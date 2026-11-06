import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, erc20Abi, parseAbi, type Address, type Hex } from 'viem';
import { feeScheduleAbi, type ViemChain } from '../src/chain.js';
import { DEX, Treasury, boundedStep, readPoolPrice, treasuryConfig, usdtPerWbtFromTick } from '../src/treasury.js';
import { USDT } from '../src/token.js';

const RELAYER = '0x00000000000000000000000000000000000000aa' as Address;
const FEES = '0x00000000000000000000000000000000000000fe' as Address;
const POOL = '0x5645101Ca8d2F7BaBC27b10359555767a1BdF999' as Address;
const WEI = 10n ** 18n;
const swapAbi = parseAbi(['function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)']);

/** sqrtPriceX96 for a price of `usdtPerWbt` USDT base units per 1 WBT (1e18 wei), WWBT as token0. */
const sqrtPrice = (usdtPerWbt: bigint) => {
  const target = usdtPerWbt * 2n ** 192n / WEI;
  let x = 2n ** 96n;
  for (let i = 0; i < 200; i++) x = (x + target / x) / 2n;
  return x;
};

describe('treasury pricing helpers', () => {
  it('reads USDT per WBT from a pool tick, in either token order', () => {
    // Tick 0 is a raw price of 1: one USDT base unit per wei, so 1e18 per WBT.
    expect(usdtPerWbtFromTick(0, true)).toBe(WEI);
    // ~73.6 USDT per WBT is a raw price of 7.36e-11 (6 vs 18 decimals): a tick near -233,332.
    const price = usdtPerWbtFromTick(-233_332, true);
    expect(price).toBeGreaterThan(73_000_000n);
    expect(price).toBeLessThan(74_500_000n);
    expect(usdtPerWbtFromTick(233_332, false)).toBe(price);
  });
  it('moves the price at most 20% per step, like the FeeSchedule keeper rule', () => {
    expect(boundedStep(100n, 110n)).toBe(110n);
    expect(boundedStep(100n, 200n)).toBe(120n);
    expect(boundedStep(100n, 10n)).toBe(80n);
    expect(boundedStep(79_000_000n, 79_000_000n)).toBe(79_000_000n);
  });
  it('validates its configuration and keeps safe defaults', () => {
    expect(treasuryConfig({})).toEqual({ minWbtWei: 200_000_000_000_000_000n, swapChunkMinor: 20_000_000n, maxSlippageBps: 300, sweepAlertMinor: 500_000_000n, priceDeviationBps: 200, twapSeconds: 600 });
    for (const env of [{ TREASURY_MAX_SLIPPAGE_BPS: '0' }, { TREASURY_MAX_SLIPPAGE_BPS: '2500' }, { TREASURY_SWAP_CHUNK_MINOR: '0' }, { TREASURY_PRICE_DEVIATION_BPS: '0' }, { TREASURY_TWAP_SECONDS: '-1' }])
      expect(() => treasuryConfig(env)).toThrow('Invalid treasury config');
  });
  it('prices from the TWAP when the pool has history, else from spot', async () => {
    const pool = { address: POOL, wbtIsToken0: true };
    const twap = { readContract: vi.fn(async ({ functionName }: { functionName: string }) => functionName === 'observe' ? [[0n, -237_329n * 600n], []] : null) };
    expect(await readPoolPrice(twap as never, 600, pool)).toBe(usdtPerWbtFromTick(-237_329, true));
    const spot = { readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'observe') throw new Error('OLD');
      return [sqrtPrice(73_600_000n), 0, 0, 0, 0, 0, true];
    }) };
    const price = await readPoolPrice(spot as never, 600, pool);
    expect(price > 73_599_000n && price < 73_601_000n).toBe(true);
  });
});

/** A treasury over a fake chain: reads come from `state`, relayed writes are recorded. */
function treasury(state: { usdtPerWBT: bigint; priceUpdatedAt: bigint; priceKeeper: Address; now: bigint; wbt: bigint; usdt: bigint; allowance: bigint; wrapped: bigint; pool: bigint }) {
  const relayed: Array<{ to: Address; data: Hex; gas: bigint }> = [];
  const chain = { relayer: RELAYER, relay: vi.fn(async (_op: unknown, to: Address, data: Hex, gas: bigint) => { relayed.push({ to, data, gas }); return '0x01' as Hex; }) } as unknown as ViemChain;
  const log = vi.fn();
  const t = new Treasury(chain, 'http://unused.invalid', FEES, { ...treasuryConfig({}), twapSeconds: 0 }, log);
  const readContract = vi.fn(async ({ address, functionName }: { address: Address; functionName: string }) => {
    if (address === FEES) return state[functionName as 'usdtPerWBT' | 'priceUpdatedAt' | 'priceKeeper'];
    if (functionName === 'balanceOf') return address === USDT ? state.usdt : state.wrapped;
    if (functionName === 'allowance') return state.allowance;
    if (functionName === 'slot0') return [sqrtPrice(state.pool), 0, 0, 0, 0, 0, true];
    throw new Error(`unexpected read ${functionName}`);
  });
  Object.assign(t, { pool: { address: POOL, wbtIsToken0: true }, public: { readContract, getBalance: async () => state.wbt, getBlock: async () => ({ timestamp: state.now }) } });
  return { t, relayed, log, chain };
}
const base = { usdtPerWBT: 79_000_000n, priceUpdatedAt: 1_000n, priceKeeper: RELAYER, now: 10_000n, wbt: WEI, usdt: 0n, allowance: 0n, wrapped: 0n, pool: 79_000_000n };

describe('treasury jobs', () => {
  it('moves the FeeSchedule price one bounded step towards the pool, only when it has moved enough', async () => {
    const steady = treasury({ ...base, pool: 79_500_000n });
    expect(await steady.t.syncPrice()).toBeNull(); // Under 2%.
    const crash = treasury({ ...base, pool: 40_000_000n });
    const next = await crash.t.syncPrice();
    expect(next).toBe(63_200_000n); // 20% down, not to 40.
    expect(crash.relayed).toHaveLength(1);
    expect(crash.relayed[0].to).toBe(FEES);
    expect(decodeFunctionData({ abi: feeScheduleAbi, data: crash.relayed[0].data })).toMatchObject({ functionName: 'setPrice', args: [63_200_000n] });
  });
  it('leaves the price alone within 10 minutes of the last update, or when it is not the keeper', async () => {
    expect(await treasury({ ...base, pool: 40_000_000n, priceUpdatedAt: base.now - 599n }).t.syncPrice()).toBeNull();
    const other = treasury({ ...base, pool: 40_000_000n, priceKeeper: '0x00000000000000000000000000000000000000bb' });
    expect(await other.t.syncPrice()).toBeNull();
    expect(other.relayed).toHaveLength(0);
  });
  it('swaps one chunk of fee USDT for WBT when gas runs low, approving the router once first', async () => {
    expect(await treasury({ ...base, usdt: 100_000_000n }).t.refill()).toBe(0n); // Enough WBT.
    const low = { ...base, wbt: WEI / 100n, usdt: 100_000_000n };
    const approving = treasury(low);
    expect(await approving.t.refill()).toBe(0n);
    expect(approving.relayed[0].to).toBe(USDT);
    expect(decodeFunctionData({ abi: erc20Abi, data: approving.relayed[0].data })).toMatchObject({ functionName: 'approve', args: [DEX.swapRouter, 2n ** 256n - 1n] });
    const swapping = treasury({ ...low, allowance: 2n ** 256n - 1n });
    expect(await swapping.t.refill()).toBe(20_000_000n);
    const swap = decodeFunctionData({ abi: swapAbi, data: swapping.relayed[0].data });
    const params = swap.args[0];
    expect([params.tokenIn, params.tokenOut, params.recipient].map(a => a.toLowerCase())).toEqual([USDT, DEX.wrappedNative, RELAYER].map(a => a.toLowerCase()));
    expect(params.amountIn).toBe(20_000_000n);
    // At 79 USDT per WBT, 20 USDT buys ~0.2532 WBT; it accepts no less than 3% under that.
    const expected = 20_000_000n * WEI / 79_000_000n;
    expect(params.amountOutMinimum).toBeGreaterThan(expected * 9_690n / 10_000n);
    expect(params.amountOutMinimum).toBeLessThanOrEqual(expected * 9_701n / 10_000n);
  });
  it('warns instead of swapping dust, unwraps WWBT, and warns once a day while fees pile up', async () => {
    const dust = treasury({ ...base, wbt: 0n, usdt: 500_000n, allowance: 2n ** 256n - 1n });
    expect(await dust.t.refill()).toBe(0n);
    expect(dust.log).toHaveBeenCalledWith(expect.stringContaining('too little USDT'));
    const wrapped = treasury({ ...base, wrapped: 5n * WEI });
    expect(await wrapped.t.unwrap()).toBe(5n * WEI);
    expect(wrapped.relayed[0].to).toBe(DEX.wrappedNative);
    const rich = treasury({ ...base, usdt: 600_000_000n });
    const day = new Date('2026-11-06T10:00:00Z');
    expect(await rich.t.alert(day)).toBe(true);
    expect(await rich.t.alert(new Date('2026-11-06T22:00:00Z'))).toBe(false);
    expect(await rich.t.alert(new Date('2026-11-07T01:00:00Z'))).toBe(true);
    expect(rich.log).toHaveBeenCalledWith(expect.stringContaining('fee vault'));
  });
  it('runs every job and logs a failing one without stopping the rest', async () => {
    const f = treasury({ ...base, wbt: 0n, usdt: 100_000_000n, allowance: 2n ** 256n - 1n, pool: 40_000_000n });
    (f.chain.relay as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('rpc down'));
    await f.t.run();
    expect(f.log).toHaveBeenCalledWith('Treasury price skipped: rpc down');
    expect(f.relayed.map(r => r.to)).toEqual([DEX.swapRouter]);
  });
});
