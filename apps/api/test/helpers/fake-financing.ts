import { decodeFunctionData, type Address, type Hex } from 'viem';
import { permitAbi } from '../../src/approval-chain.js';
import { USDT } from '../../src/token.js';
import { receivablesAbi, registryAbi, type ChainClaim, type ClaimStatus, type FinancingChain, type FinancingEvent, type FinancingReceipt } from '../../src/financing/chain.js';
import { Refusal } from '../../src/types.js';

export const RECEIVABLES = '0x00000000000000000000000000000000000000c1' as Address;
export const REGISTRY = '0x00000000000000000000000000000000000000c2' as Address;

/**
 * Financing chain for tests: events, receipts and reads are set by the test. It does not run the
 * contract; tests emit the events the contract would.
 */
export class FakeFinancingChain implements FinancingChain {
  readonly addresses = { receivables: RECEIVABLES, registry: REGISTRY };
  block = 10n;
  time = Math.floor(Date.now() / 1000);
  logs: FinancingEvent[] = [];
  receipts = new Map<string, FinancingReceipt>();
  claims = new Map<string, ChainClaim>();
  active = new Map<string, bigint>();
  approved = new Set<string>();
  officers = new Set<string>();
  balances = new Map<string, bigint>();
  allowances = new Map<string, bigint>();
  owedBy = new Map<string, bigint>();
  keeperCalls: Array<{ functionName: string; claimId: bigint }> = [];
  private sequence = 0;
  async latestBlock() { return this.block; }
  async now() { return this.time; }
  async events(from: bigint, to: bigint) { return this.logs.filter(e => e.block >= from && e.block <= to); }
  async receipt(hash: Hex) { return this.receipts.get(hash.toLowerCase()) ?? null; }
  async claim(claimId: bigint) {
    const c = this.claims.get(claimId.toString());
    if (!c) return { merchant: '0x0000000000000000000000000000000000000000' as Address, maturity: 0n, status: 'none' as ClaimStatus, face: 0n, sold: 0n, collected: 0n, reserve: 0n };
    return c;
  }
  async owed(claimId: bigint) { return this.owedBy.get(claimId.toString()) ?? 0n; }
  async activeClaimId(merchant: Address, ref: Hex) { return this.active.get(`${merchant.toLowerCase()}:${ref.toLowerCase()}`) ?? 0n; }
  acknowledgements = new Map<string, bigint>();
  async acknowledgementClaim(ackHash: Hex) { return this.acknowledgements.get(ackHash.toLowerCase()) ?? 0n; }
  pledged = new Set<string>();
  async invoicePledged(merchant: Address, ref: Hex) { return this.pledged.has(`${merchant.toLowerCase()}:${ref.toLowerCase()}`); }
  versions = new Map<string, bigint>();
  async decisionVersion(investor: Address) { return this.versions.get(investor.toLowerCase()) ?? 0n; }
  async isApproved(investor: Address) { return this.approved.has(investor.toLowerCase()); }
  async isOfficer(account: Address) { return this.officers.has(account.toLowerCase()); }
  async usdtBalance(account: Address) { return this.balances.get(account.toLowerCase()) ?? 0n; }
  async allowance(owner: Address, spender: Address) { return this.allowances.get(`${owner.toLowerCase()}:${spender.toLowerCase()}`) ?? 0n; }
  credits = new Map<string, bigint>();
  async claimable(account: Address) { return this.credits.get(account.toLowerCase()) ?? 0n; }
  async keeper(functionName: 'closeListing' | 'markDefault', claimId: bigint) {
    this.keeperCalls.push({ functionName, claimId });
    return this.transaction('0x00000000000000000000000000000000000000ee', RECEIVABLES, []);
  }
  nonces = new Map<string, bigint>();
  async nonce(contract: 'receivables' | 'registry', account: Address) { return this.nonces.get(`${contract}:${account.toLowerCase()}`) ?? 0n; }
  async permit(owner: Address) {
    return { domain: { name: 'Tether USD', version: '1', chainId: 1874, verifyingContract: '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7' as Address }, nonce: this.nonces.get(`usdt:${owner.toLowerCase()}`) ?? 0n };
  }
  relayed: Array<{ contract: 'receivables' | 'registry' | 'usdt'; functionName: string; args: readonly unknown[]; gas: bigint }> = [];
  /** What a relayed order does: the events the contract would emit, or the name of the error it reverts with. */
  onRelay: (call: { contract: 'receivables' | 'registry' | 'usdt'; functionName: string; args: readonly unknown[] }) => Array<{ name: string; args: Record<string, unknown>; contract?: 'receivables' | 'registry' }> | string = () => [];
  async relay(contract: 'receivables' | 'registry' | 'usdt', data: Hex, gas: bigint) {
    const { functionName, args = [] } = decodeFunctionData({ abi: contract === 'receivables' ? receivablesAbi : contract === 'usdt' ? permitAbi : registryAbi, data });
    const outcome = this.onRelay({ contract, functionName, args });
    if (typeof outcome === 'string') throw new Refusal('relay_refused', outcome);
    this.relayed.push({ contract, functionName, args, gas });
    // A permit sets the allowance it names, as the token would.
    if (contract === 'usdt' && functionName === 'permit') this.allowances.set(`${String(args[0]).toLowerCase()}:${String(args[1]).toLowerCase()}`, BigInt(String(args[2])));
    const to = contract === 'receivables' ? RECEIVABLES : contract === 'usdt' ? USDT : REGISTRY;
    return this.transaction('0x00000000000000000000000000000000000000ee', to, contract === 'usdt' ? [] : outcome.map(e => ({ contract: contract as 'receivables' | 'registry', ...e })));
  }
  /** Records a transaction another chain adapter sent (a Router call) under its own hash. */
  adopt(hash: Hex, to: Address, events: Array<{ name: string; args: Record<string, unknown>; contract?: 'receivables' | 'registry' }>) {
    this.block++;
    const decoded = events.map((e, i) => ({ id: `${hash}:${i}`, block: this.block, txHash: hash, contract: e.contract ?? 'receivables', name: e.name, args: e.args, at: this.time }));
    this.logs.push(...decoded);
    this.receipts.set(hash.toLowerCase(), { txHash: hash, block: this.block, status: 'success' as const, from: '0x00000000000000000000000000000000000000ee' as Address, to, events: decoded });
  }
  /**
   * Records a confirmed transaction from `from` to `to` emitting `events` (name and args), and returns
   * its hash. The events are also in the logs, for the indexer.
   */
  transaction(from: Address, to: Address, events: Array<{ name: string; args: Record<string, unknown>; contract?: 'receivables' | 'registry' }>, status: 'success' | 'reverted' = 'success'): Hex {
    const hash = `0x${(++this.sequence).toString(16).padStart(64, 'f')}` as Hex;
    this.block++;
    const decoded = events.map((e, i) => ({ id: `${hash}:${i}`, block: this.block, txHash: hash, contract: e.contract ?? 'receivables', name: e.name, args: e.args, at: this.time }));
    if (status === 'success') this.logs.push(...decoded);
    this.receipts.set(hash.toLowerCase(), { txHash: hash, block: this.block, status, from, to, events: status === 'success' ? decoded : [] });
    return hash;
  }
}
