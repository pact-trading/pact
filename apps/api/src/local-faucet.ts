import { encodeFunctionData, formatUnits, isAddress, parseAbi, parseEther, parseUnits, type Address, type Hex } from 'viem';
import { USDT } from './token.js';
import { Refusal } from './types.js';

const erc20 = parseAbi(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
/** A large holder of testnet USDT whose balance the local fork can spend by impersonation. */
const USDT_HOLDER: Address = '0xA1616Fe9624B64eF2Dddc8ccAc735bAA234CEbF7';
const MAX_WBT = parseEther('1');
const MAX_USDT = parseUnits('100', 6);

/**
 * Local fork only. Stands in for the Whitechain faucet (WBT) and a DEX swap (USDT) so the whole
 * product can be tried without real funds. Refuses to run against anything but a local Anvil node.
 */
export class LocalFaucet {
  private queue: Promise<unknown> = Promise.resolve();
  private checked = false;
  constructor(private readonly rpcUrl: string) {
    if (!['127.0.0.1', 'localhost'].includes(new URL(rpcUrl).hostname)) throw new Error('Local faucet only runs against a local node');
  }
  private async rpc<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await fetch(this.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
    const body = await response.json() as { result: T; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result;
  }
  private async ensureAnvil() {
    if (this.checked) return;
    if (!String(await this.rpc('web3_clientVersion')).toLowerCase().includes('anvil')) throw new Refusal('faucet_unavailable');
    this.checked = true;
  }
  async balances(address: Address) {
    const [wei, usdt] = await Promise.all([
      this.rpc<Hex>('eth_getBalance', [address, 'latest']),
      this.rpc<Hex>('eth_call', [{ to: USDT, data: encodeFunctionData({ abi: erc20, functionName: 'balanceOf', args: [address] }) }, 'latest']),
    ]);
    return { wbt: formatUnits(BigInt(wei), 18), usdt: formatUnits(BigInt(usdt), 6) };
  }
  fund(address: unknown, amounts: { wbt?: unknown; usdt?: unknown }) {
    const run = this.queue.then(() => this.fundSerial(address, amounts));
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async fundSerial(address: unknown, amounts: { wbt?: unknown; usdt?: unknown }) {
    if (typeof address !== 'string' || !isAddress(address)) throw new Refusal('invalid_address');
    const parse = (value: unknown, decimals: number, max: bigint) => {
      if (value === undefined || value === null || value === '') return 0n;
      if (typeof value !== 'string' || !/^\d{1,6}(\.\d{1,6})?$/.test(value)) throw new Refusal('invalid_amount');
      const amount = parseUnits(value, decimals);
      if (amount > max) throw new Refusal('faucet_limit');
      return amount;
    };
    const wbt = parse(amounts.wbt, 18, MAX_WBT), usdt = parse(amounts.usdt, 6, MAX_USDT);
    if (wbt === 0n && usdt === 0n) throw new Refusal('invalid_amount');
    await this.ensureAnvil();
    if (wbt > 0n) {
      const balance = BigInt(await this.rpc<Hex>('eth_getBalance', [address, 'latest']));
      await this.rpc('anvil_setBalance', [address, `0x${(balance + wbt).toString(16)}`]);
    }
    if (usdt > 0n) {
      await this.rpc('anvil_setBalance', [USDT_HOLDER, '0xDE0B6B3A7640000']);
      await this.rpc('anvil_impersonateAccount', [USDT_HOLDER]);
      try {
        const hash = await this.rpc<Hex>('eth_sendTransaction', [{ from: USDT_HOLDER, to: USDT, data: encodeFunctionData({ abi: erc20, functionName: 'transfer', args: [address, usdt] }), gas: '0x30d40' }]);
        for (let i = 0; i < 60; i++) {
          const receipt = await this.rpc<{ status: Hex } | null>('eth_getTransactionReceipt', [hash]);
          if (receipt) { if (receipt.status !== '0x1') throw new Refusal('faucet_failed'); break; }
          await new Promise(r => setTimeout(r, 250));
        }
      } finally { await this.rpc('anvil_stopImpersonatingAccount', [USDT_HOLDER]); }
    }
    return { address: address.toLowerCase(), ...(await this.balances(address)) };
  }
  /** Appoints a compliance officer in the investor registry by impersonating its owner (local fork only). */
  appointOfficer(registry: Address, owner: Address, officer: Address) {
    const run = this.queue.then(async () => {
      if (!isAddress(officer)) throw new Refusal('invalid_address');
      await this.ensureAnvil();
      await this.rpc('anvil_setBalance', [owner, '0xDE0B6B3A7640000']);
      await this.rpc('anvil_impersonateAccount', [owner]);
      try {
        const data = encodeFunctionData({ abi: parseAbi(['function setOfficer(address,bool)']), functionName: 'setOfficer', args: [officer, true] });
        const hash = await this.rpc<Hex>('eth_sendTransaction', [{ from: owner, to: registry, data, gas: '0x186a0' }]);
        for (let i = 0; i < 60; i++) {
          const receipt = await this.rpc<{ status: Hex } | null>('eth_getTransactionReceipt', [hash]);
          if (receipt) { if (receipt.status !== '0x1') throw new Refusal('faucet_failed'); return hash; }
          await new Promise(r => setTimeout(r, 250));
        }
        throw new Refusal('faucet_failed');
      } finally { await this.rpc('anvil_stopImpersonatingAccount', [owner]); }
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
  /** Moves the fork's clock forward (local fork only), to try maturity, the grace period and default. */
  async advanceTime(seconds: number) {
    if (!Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 400 * 86_400) throw new Refusal('invalid_amount');
    await this.ensureAnvil();
    await this.rpc('evm_increaseTime', [seconds]);
    await this.rpc('evm_mine', []);
    const block = await this.rpc<{ timestamp: Hex }>('eth_getBlockByNumber', ['latest', false]);
    return { chainTime: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString() };
  }
}
