import { createPublicClient, defineChain, encodeFunctionData, erc20Abi, http, parseAbi, type Address, type PublicClient } from 'viem';
import { feeScheduleAbi, type ViemChain } from './chain.js';
import { id } from './db.js';
import { USDT } from './token.js';

/** Whitechain testnet DEX (Uniswap v3, SwapRouter02) and its wrapped WBT. */
export const DEX = { swapRouter: '0xe208cC685cD95D56E8ec6DEC9816476567fc6962' as Address, wrappedNative: '0x4200000000000000000000000000000000000006' as Address, fee: 3000 };

const swapRouterAbi = parseAbi([
  'function factory() view returns (address)',
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)',
]);
const factoryAbi = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const poolAbi = parseAbi([
  'function token0() view returns (address)',
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives,uint160[])',
]);
const wrappedAbi = parseAbi(['function withdraw(uint256)', 'function balanceOf(address) view returns (uint256)']);

export interface TreasuryConfig {
  /** Swap fee USDT for gas when the relayer's WBT falls below this. */
  minWbtWei: bigint;
  /** The most USDT one swap sells. */
  swapChunkMinor: bigint;
  /** A swap must return at least the price's value less this. */
  maxSlippageBps: number;
  /** Warn when this much fee USDT sits in the relayer wallet, until a fee vault takes it. */
  sweepAlertMinor: bigint;
  /** Move the FeeSchedule price only when the pool has moved at least this much. */
  priceDeviationBps: number;
  /** The TWAP window the price is read over. */
  twapSeconds: number;
}
export function treasuryConfig(env: NodeJS.ProcessEnv = process.env): TreasuryConfig {
  const config = {
    minWbtWei: BigInt(env.TREASURY_MIN_WBT_WEI ?? '200000000000000000'),
    swapChunkMinor: BigInt(env.TREASURY_SWAP_CHUNK_MINOR ?? '20000000'),
    maxSlippageBps: Number(env.TREASURY_MAX_SLIPPAGE_BPS ?? '300'),
    sweepAlertMinor: BigInt(env.TREASURY_SWEEP_ALERT_MINOR ?? '500000000'),
    priceDeviationBps: Number(env.TREASURY_PRICE_DEVIATION_BPS ?? '200'),
    twapSeconds: Number(env.TREASURY_TWAP_SECONDS ?? '600'),
  };
  if (config.minWbtWei < 0n || config.swapChunkMinor <= 0n || !Number.isInteger(config.maxSlippageBps) || config.maxSlippageBps < 1 || config.maxSlippageBps > 2_000
    || config.sweepAlertMinor <= 0n || !Number.isInteger(config.priceDeviationBps) || config.priceDeviationBps < 1 || !Number.isInteger(config.twapSeconds) || config.twapSeconds < 0) throw new Error('Invalid treasury config');
  return config;
}

/** The FeeSchedule keeper rule: at most 20% per update, at least 10 minutes apart. */
const MAX_STEP_BPS = 2_000n;
const MIN_PRICE_INTERVAL = 600;
const WEI = 10n ** 18n;
const Q192 = 2n ** 192n;

/** USDT base units per 1 WBT from a pool tick, with WWBT as `token0`: 1.0001^tick raw units, times 10^18. */
export function usdtPerWbtFromTick(tick: number, wbtIsToken0: boolean): bigint {
  const raw = Math.pow(1.0001, wbtIsToken0 ? tick : -tick);
  return BigInt(Math.round(raw * 1e18));
}
/** One step towards `target` that the FeeSchedule keeper rule allows from `current`. */
export function boundedStep(current: bigint, target: bigint): bigint {
  const maxStep = current * MAX_STEP_BPS / 10_000n;
  if (target > current + maxStep) return current + maxStep;
  if (target < current - maxStep) return current - maxStep;
  return target;
}

type Reader = Pick<PublicClient, 'readContract'>;
/** The WWBT/USDT pool the treasury prices WBT from. */
export async function findPool(client: Reader) {
  const factory = await client.readContract({ address: DEX.swapRouter, abi: swapRouterAbi, functionName: 'factory' });
  const address = await client.readContract({ address: factory, abi: factoryAbi, functionName: 'getPool', args: [DEX.wrappedNative, USDT, DEX.fee] });
  if (/^0x0{40}$/i.test(address)) throw new Error('No WWBT/USDT pool');
  const token0 = await client.readContract({ address, abi: poolAbi, functionName: 'token0' });
  return { address, wbtIsToken0: token0.toLowerCase() === DEX.wrappedNative.toLowerCase() };
}
/** USDT base units per 1 WBT from the pool: a TWAP when the pool keeps enough history, otherwise spot. */
export async function readPoolPrice(client: Reader, twapSeconds = 600, pool?: { address: Address; wbtIsToken0: boolean }): Promise<bigint> {
  pool ??= await findPool(client);
  if (twapSeconds > 0) {
    try {
      const [cumulatives] = await client.readContract({ address: pool.address, abi: poolAbi, functionName: 'observe', args: [[twapSeconds, 0]] });
      const tick = Math.round(Number(cumulatives[1] - cumulatives[0]) / twapSeconds);
      return usdtPerWbtFromTick(tick, pool.wbtIsToken0);
    } catch { /* Not enough observations: use the spot price. */ }
  }
  const [sqrtPriceX96] = await client.readContract({ address: pool.address, abi: poolAbi, functionName: 'slot0' });
  const squared = sqrtPriceX96 * sqrtPriceX96;
  return pool.wbtIsToken0 ? squared * WEI / Q192 : WEI * Q192 / squared;
}

/**
 * Pact's relayer keeps itself in gas from the fees it receives: it keeps the FeeSchedule's WBT price
 * near the pool's, so refunds pay their real gas, and swaps fee USDT for WBT when it runs low. Every
 * write goes through the shared AccountWriter. A failure is logged and retried on the next tick;
 * the circuit breakers and sponsorship budgets still bound spend if the relayer runs dry.
 */
export class Treasury {
  private public;
  private pool?: { address: Address; wbtIsToken0: boolean };
  private alertedOn = '';
  constructor(private chain: ViemChain, rpcUrl: string, private fees: Address, private config: TreasuryConfig, private log: (message: string) => void = console.warn) {
    this.public = createPublicClient({ chain: defineChain({ id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } }), transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }) });
  }
  /** The pool's WBT price, as the treasury reads it. */
  async poolPrice(): Promise<bigint> {
    this.pool ??= await findPool(this.public);
    return readPoolPrice(this.public, this.config.twapSeconds, this.pool);
  }
  /** Moves the FeeSchedule price one allowed step towards the pool's. Returns the price it set, or null. */
  async syncPrice(): Promise<bigint | null> {
    const read = (functionName: 'usdtPerWBT' | 'priceUpdatedAt' | 'priceKeeper') => this.public.readContract({ address: this.fees, abi: feeScheduleAbi, functionName });
    const [current, updatedAt, keeper] = await Promise.all([read('usdtPerWBT'), read('priceUpdatedAt'), read('priceKeeper')]) as [bigint, bigint, Address];
    if (keeper.toLowerCase() !== this.chain.relayer.toLowerCase()) return null;
    const block = await this.public.getBlock({ blockTag: 'latest' });
    if (block.timestamp < updatedAt + BigInt(MIN_PRICE_INTERVAL)) return null;
    const target = await this.poolPrice();
    const deviation = (target > current ? target - current : current - target) * 10_000n / current;
    if (deviation < BigInt(this.config.priceDeviationBps)) return null;
    const next = boundedStep(current, target);
    const data = encodeFunctionData({ abi: feeScheduleAbi, functionName: 'setPrice', args: [next] });
    await this.chain.relay({ id: id('treasury'), kind: 'treasury', objectId: 'price' }, this.fees, data, 80_000n);
    return next;
  }
  /** Swaps one chunk of fee USDT for WBT when the relayer runs low on gas. Returns the USDT sold. */
  async refill(): Promise<bigint> {
    const relayer = this.chain.relayer;
    const [wbt, usdt, allowance] = await Promise.all([
      this.public.getBalance({ address: relayer }),
      this.public.readContract({ address: USDT, abi: erc20Abi, functionName: 'balanceOf', args: [relayer] }),
      this.public.readContract({ address: USDT, abi: erc20Abi, functionName: 'allowance', args: [relayer, DEX.swapRouter] }),
    ]);
    if (wbt >= this.config.minWbtWei) return 0n;
    const amountIn = usdt < this.config.swapChunkMinor ? usdt : this.config.swapChunkMinor;
    if (amountIn < 1_000_000n) { this.log(`Treasury: relayer WBT is low (${wbt} wei) and it holds too little USDT to swap`); return 0n; }
    if (allowance < amountIn) {
      await this.chain.relay({ id: id('treasury'), kind: 'treasury', objectId: 'approve-swap' }, USDT, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [DEX.swapRouter, 2n ** 256n - 1n] }), 80_000n);
      // The approval must be mined before the swap simulates; the next tick swaps.
      return 0n;
    }
    const price = await this.poolPrice();
    const expected = amountIn * WEI / price;
    const amountOutMinimum = expected * BigInt(10_000 - this.config.maxSlippageBps) / 10_000n;
    const swap = encodeFunctionData({ abi: swapRouterAbi, functionName: 'exactInputSingle', args: [{ tokenIn: USDT, tokenOut: DEX.wrappedNative, fee: DEX.fee, recipient: relayer, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n }] });
    await this.chain.relay({ id: id('treasury'), kind: 'treasury', objectId: 'swap' }, DEX.swapRouter, swap, 300_000n);
    return amountIn;
  }
  /** Unwraps any WWBT the relayer holds, so it can pay gas with it. */
  async unwrap(): Promise<bigint> {
    const wrapped = await this.public.readContract({ address: DEX.wrappedNative, abi: wrappedAbi, functionName: 'balanceOf', args: [this.chain.relayer] });
    if (wrapped === 0n) return 0n;
    await this.chain.relay({ id: id('treasury'), kind: 'treasury', objectId: 'unwrap' }, DEX.wrappedNative, encodeFunctionData({ abi: wrappedAbi, functionName: 'withdraw', args: [wrapped] }), 80_000n);
    return wrapped;
  }
  /** Warns once a day while fee USDT piles up in the hot relayer wallet. */
  async alert(at = new Date()): Promise<boolean> {
    const usdt = await this.public.readContract({ address: USDT, abi: erc20Abi, functionName: 'balanceOf', args: [this.chain.relayer] });
    const day = at.toISOString().slice(0, 10);
    if (usdt < this.config.sweepAlertMinor || this.alertedOn === day) return false;
    this.alertedOn = day;
    this.log(`Treasury: the relayer holds ${usdt} USDT base units of fees. Sweep it to cold storage, or point the FeeSchedule recipient at a fee vault.`);
    return true;
  }
  async run() {
    for (const [name, step] of [['price', () => this.syncPrice()], ['unwrap', () => this.unwrap()], ['refill', () => this.refill()], ['alert', () => this.alert()]] as const) {
      try { await step(); }
      catch (error) { this.log(`Treasury ${name} skipped: ${error instanceof Error ? error.message : 'unknown error'}`); }
    }
  }
}
