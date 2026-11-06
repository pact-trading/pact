import { isAddress, maxUint256, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import type { ChainAdapter } from './types.js';
import { Refusal } from './types.js';
import { id, now, type Db } from './db.js';
import type { ApprovalCall, ApprovalSnapshot } from './approval-chain.js';
import { pendingPaymentIntent } from './payment-state.js';
import { permitTypedData } from './typed-data.js';
import { USDT } from './token.js';
export { USDT } from './token.js';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const halfOrder = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const uint = (x: unknown): bigint => { if (typeof x !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(x) || BigInt(x) >= 2n ** 256n) throw new Refusal('invalid_integer'); return BigInt(x); };
/** A merchant's standing allowance: unlimited, spent only on calls the merchant itself signs. */
export const UNLIMITED = maxUint256;
const toJson = (value: unknown) => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));
export interface ApprovalTarget { key: string; merchant: string; payer: Address; spender: Address; amount: bigint; minimumBalance: bigint }
export interface ApprovalConfig { enabled: boolean; escrow: Address; minimumAmount: bigint; gas?: bigint; maxGasPrice?: bigint; maxSpendPerMinute?: bigint; maxPerMinute?: number; confirmations?: bigint }
type Attempt = { id: string; payment_id: string; merchant_id: string; payer: Address; token: Address; spender: Address; amount_minor: string; approval_nonce: string; deadline: string; status: string; reason: string | null; tx_hash: Hex | null; cost_wei: string; created_at: string };
type Payment = { id: string; merchant_id: string; payer: string | null; amount_minor: string; currency: string; status: string; expires_at: string | null };
/**
 * Whether the payer's USDT can be pulled, and when not, the EIP-2612 permit to sign: Pact's relayer
 * submits it and pays the gas, so the payer never needs WBT.
 */
export interface Readiness {
  paymentId: string; payer: Address; chainId: number; token: Address; spender: Address; amount: string;
  balance: string | null; allowance: string | null;
  permitNonce: string | null; deadline: string | null; typedData: Record<string, unknown> | null;
  status: 'needs_funding' | 'needs_approval' | 'ready' | 'pending' | 'unavailable'; reason?: string; attemptId?: string; txHash?: Hex | null;
}
/** Caps the gas Pact absorbs submitting permits, per merchant. */
export interface ApprovalBudget { assert(merchantId: string, costWei: bigint): Promise<void> | void; record(merchantId: string, operationId: string, costWei: bigint): void }
export class ApprovalService {
  private config: Required<ApprovalConfig>;
  /**
   * Who a payment's USDT is approved to: the escrow, or the receivables contract when the payment is
   * for a financed invoice (the contract pays the claim holders). Set when financing is deployed.
   */
  spenderFor?: (paymentId: string) => Promise<Address | null>;
  receivables?: Address;
  budget?: ApprovalBudget;
  private async spender(paymentId: string) { return (await this.spenderFor?.(paymentId)) ?? this.config.escrow; }
  private pendingCharge(paymentId: string) { return pendingPaymentIntent(this.db, paymentId, this.config.escrow, this.receivables); }
  constructor(private db: Db, private chain: ChainAdapter, config: ApprovalConfig) {
    // Permits are how every customer and merchant approves USDT, so the shared ceiling allows a steady
    // flow: 30 a minute, at most 0.05 WBT of gas. Each merchant's sponsorship budget bounds its own share.
    this.config = { gas: 120_000n, maxGasPrice: 20_000_000_000n, maxSpendPerMinute: 50_000_000_000_000_000n, maxPerMinute: 30, confirmations: 2n, ...config };
    const c = this.config;
    if (c.gas < 60_000n || c.gas > 300_000n || c.maxGasPrice <= 0n || c.maxGasPrice > 100_000_000_000n || c.maxSpendPerMinute <= 0n || c.maxSpendPerMinute > 10n ** 17n || !Number.isSafeInteger(c.maxPerMinute) || c.maxPerMinute < 1 || c.maxPerMinute > 60 || c.confirmations < 1n || c.minimumAmount < 1_000_000n) throw new Error('Invalid approval limits');
    chain.writer.bind(db);
  }
  private payment(paymentId: string, merchant: string, payer: string): Payment {
    if (!isAddress(payer)) throw new Refusal('invalid_address');
    const p = this.db.prepare('SELECT * FROM payments WHERE id=? AND merchant_id=?').get(paymentId, merchant) as Payment | undefined;
    if (!p) throw new Refusal('payment_not_found');
    const a = this.attempt(paymentId);
    if ((p.payer && !same(p.payer, payer)) || (a && !same(a.payer, payer))) throw new Refusal('payer_mismatch');
    return p;
  }
  private attempt(key: string) { return this.db.prepare('SELECT * FROM approval_attempts WHERE payment_id=?').get(key) as Attempt | undefined; }
  private paymentReason(p: Payment) {
    if (p.status !== 'open') return 'payment_not_open';
    if (p.expires_at && new Date(p.expires_at).getTime() <= Date.now()) return 'payment_expired';
    if (p.currency !== 'USDT') return 'unsupported_token';
    if (BigInt(p.amount_minor) < this.config.minimumAmount || BigInt(p.amount_minor) >= 2n ** 256n) return 'below_minimum';
  }
  private configReason() {
    const c = this.config;
    if (!c.enabled) return 'feature_disabled';
    if (!isAddress(c.escrow) || /^0x0{40}$/i.test(c.escrow)) return 'approval_unconfigured';
  }
  private rate(price: bigint) {
    if (price <= 0n || price > this.config.maxGasPrice) throw new Refusal('approval_gas_price');
    const rows = this.db.prepare('SELECT cost_wei FROM approval_attempts WHERE created_at>=?').all(new Date(Date.now() - 60_000).toISOString()) as Array<{ cost_wei: string }>;
    if (rows.length >= this.config.maxPerMinute || rows.reduce((sum, r) => sum + BigInt(r.cost_wei), 0n) + this.config.gas * price > this.config.maxSpendPerMinute) throw new Refusal('approval_budget');
  }
  /** The permit to sign, valid for five minutes (and no longer than the payment). */
  private offer(owner: Address, spender: Address, value: bigint, snapshot: ApprovalSnapshot, until?: string | null) {
    const seconds = Math.floor(Date.now() / 1000) + 300;
    const deadline = BigInt(Math.min(seconds, until ? Math.floor(new Date(until).getTime() / 1000) : Number.MAX_SAFE_INTEGER));
    return { permitNonce: snapshot.nonce.toString(), deadline: deadline.toString(), typedData: toJson(permitTypedData(owner, spender, value, snapshot.nonce, deadline)) };
  }
  private blank(key: string, payer: Address, spender: Address, amount: bigint | string): Readiness {
    return { paymentId: key, payer, chainId: 1874, token: USDT, spender, amount: amount.toString(), balance: null, allowance: null, permitNonce: null, deadline: null, typedData: null, status: 'unavailable' };
  }
  async get(paymentId: string, merchant: string, payer: Address): Promise<Readiness> {
    this.payment(paymentId, merchant, payer);
    await this.reconcile(paymentId);
    const p = this.payment(paymentId, merchant, payer);
    const a = this.attempt(paymentId);
    const charge = this.pendingCharge(paymentId);
    let spender: Address;
    try { spender = await this.spender(paymentId); }
    catch { return { ...this.blank(paymentId, payer, this.config.escrow, p.amount_minor), reason: 'rpc_unavailable' }; }
    const out = this.blank(paymentId, payer, spender, p.amount_minor);
    if (a) { out.attemptId = a.id; out.txHash = a.tx_hash; }
    // The invoice was financed (or settled) after this approval: it approved a different contract.
    if (a && !charge && !same(a.spender, spender)) return { ...out, reason: 'payment_route_changed' };
    let snapshot: ApprovalSnapshot | undefined;
    let readReason: string | undefined;
    try {
      if (await this.chain.chainId() !== 1874) readReason = 'wrong_chain';
      else {
        snapshot = await this.chain.approval.snapshot(payer, spender);
        Object.assign(out, { balance: snapshot.balance.toString(), allowance: snapshot.allowance.toString() });
      }
    } catch { readReason = 'rpc_unavailable'; }
    // Persisted uncertainty takes precedence over balances/allowance/config. A
    // refresh must never invite a second charge or an ambiguous approval send.
    if (charge) return { ...out, status: 'pending', reason: 'payment_pending', txHash: charge.tx_hash as Hex | null };
    if (a && ['prepared', 'pending'].includes(a.status)) return { ...out, status: 'pending', reason: a.reason ?? 'approval_pending' };
    if (a && ['failed', 'reconciliation_required'].includes(a.status)) return { ...out, reason: a.reason ?? 'approval_failed' };
    const reason = this.configReason() ?? this.paymentReason(p) ?? readReason;
    if (reason || !snapshot) return { ...out, reason: reason ?? 'rpc_unavailable' };
    const amount = BigInt(p.amount_minor);
    if (snapshot.balance < amount) return { ...out, status: 'needs_funding', reason: 'insufficient_usdt' };
    if (snapshot.allowance >= amount) return { ...out, status: 'ready' };
    if (a) return { ...out, reason: 'allowance_insufficient_after_approval' };
    try { this.rate(await this.chain.gasPrice()); }
    catch (e) { return { ...out, reason: e instanceof Refusal ? e.code : 'rpc_unavailable' }; }
    return { ...out, ...this.offer(payer, spender, amount, snapshot, p.expires_at), status: 'needs_approval' };
  }
  async submit(paymentId: string, merchant: string, body: Record<string, unknown>): Promise<Readiness> {
    if (Object.keys(body).some(k => !['payer', 'nonce', 'deadline', 'signature'].includes(k))) throw new Refusal('unexpected_field');
    const payer = body.payer as Address;
    this.payment(paymentId, merchant, payer);
    if (this.attempt(paymentId)) return this.get(paymentId, merchant, payer);
    const spender = await this.spender(paymentId);
    try {
      await this.chain.writer.run(async () => {
        const p = this.payment(paymentId, merchant, payer);
        const reason = this.configReason() ?? this.paymentReason(p);
        if (reason) throw new Refusal(reason);
        if (this.pendingCharge(paymentId)) throw new Refusal('payment_pending');
        const amount = BigInt(p.amount_minor);
        const deadlineLimit = p.expires_at ? BigInt(Math.floor(new Date(p.expires_at).getTime() / 1000)) : undefined;
        await this.send({ key: paymentId, merchant, payer, spender, amount, minimumBalance: amount }, body, deadlineLimit, () => {
          // Recheck after asynchronous signature/RPC operations before binding.
          const latest = this.payment(paymentId, merchant, payer);
          const changed = this.paymentReason(latest); if (changed) throw new Refusal(changed);
          if (this.pendingCharge(paymentId)) throw new Refusal('payment_pending');
          this.db.prepare('UPDATE payments SET payer=? WHERE id=?').run(payer.toLowerCase(), paymentId);
        });
      });
    } catch (error) {
      // Concurrent duplicate waited in the same queue: return the durable
      // attempt instead of rejecting it or spending a second gas reservation.
      if (!this.attempt(paymentId)) throw error;
    }
    return this.get(paymentId, merchant, payer);
  }
  /**
   * An approval that is not for one payment: the USDT a subscription may pull at renewals (spender =
   * SubscriptionManager), or a merchant's standing allowance for refunds and buy-backs. `key` names
   * it; one attempt per key. `minimumBalance` is what the owner must hold now.
   */
  async getFor(t: ApprovalTarget): Promise<Readiness> {
    await this.reconcile(t.key);
    const a = this.attempt(t.key);
    if (a && (!same(a.payer, t.payer) || !same(a.spender, t.spender) || a.merchant_id !== t.merchant)) throw new Refusal('payer_mismatch');
    const out = this.blank(t.key, t.payer, t.spender, t.amount);
    if (a) { out.attemptId = a.id; out.txHash = a.tx_hash; }
    let snapshot: ApprovalSnapshot;
    try {
      if (await this.chain.chainId() !== 1874) return { ...out, reason: 'wrong_chain' };
      snapshot = await this.chain.approval.snapshot(t.payer, t.spender);
      Object.assign(out, { balance: snapshot.balance.toString(), allowance: snapshot.allowance.toString() });
    } catch { return { ...out, reason: 'rpc_unavailable' }; }
    const funded = snapshot.balance >= t.minimumBalance;
    const fundedStatus = { status: funded ? 'ready' as const : 'needs_funding' as const, ...(!funded && { reason: 'insufficient_usdt' }) };
    if (a && ['prepared', 'pending'].includes(a.status)) return { ...out, status: 'pending', reason: a.reason ?? 'approval_pending' };
    // This key's approval went through; renewals may already have spent part of it.
    if (a?.status === 'succeeded') return { ...out, ...fundedStatus };
    if (snapshot.allowance >= (t.amount === UNLIMITED ? UNLIMITED / 2n : t.amount)) return { ...out, ...fundedStatus };
    if (a && ['failed', 'reconciliation_required'].includes(a.status)) return { ...out, reason: a.reason ?? 'approval_failed' };
    const reason = this.configReason();
    if (reason) return { ...out, reason };
    if (!funded) return { ...out, status: 'needs_funding', reason: 'insufficient_usdt' };
    if (a) return { ...out, reason: 'allowance_insufficient_after_approval' };
    try { this.rate(await this.chain.gasPrice()); }
    catch (e) { return { ...out, reason: e instanceof Refusal ? e.code : 'rpc_unavailable' }; }
    return { ...out, ...this.offer(t.payer, t.spender, t.amount, snapshot), status: 'needs_approval' };
  }
  async submitFor(t: ApprovalTarget, body: Record<string, unknown>): Promise<Readiness> {
    if (Object.keys(body).some(k => !['nonce', 'deadline', 'signature'].includes(k))) throw new Refusal('unexpected_field');
    if (this.attempt(t.key)) return this.getFor(t);
    await this.chain.writer.run(async () => {
      const reason = this.configReason(); if (reason) throw new Refusal(reason);
      await this.send(t, body);
    }).catch(error => { if (!this.attempt(t.key)) throw error; });
    return this.getFor(t);
  }
  /** Verifies the owner's permit and submits it from the relayer. Runs inside the writer queue. */
  private async send(t: ApprovalTarget, body: Record<string, unknown>, deadlineLimit?: bigint, bind?: () => void) {
    if (await this.chain.chainId() !== 1874) throw new Refusal('wrong_chain');
    const s = await this.chain.approval.snapshot(t.payer, t.spender);
    if (s.allowance >= t.amount) return;
    if (s.balance < t.minimumBalance) throw new Refusal('insufficient_usdt');
    const deadline = uint(body.deadline);
    const seconds = BigInt(Math.floor(Date.now() / 1000));
    if (deadline <= seconds || deadline > seconds + 300n || (deadlineLimit !== undefined && deadline > deadlineLimit)) throw new Refusal('approval_deadline');
    if (body.nonce !== undefined && uint(body.nonce) !== s.nonce) throw new Refusal('approval_nonce');
    const signature = body.signature;
    if (typeof signature !== 'string' || !/^0x[0-9a-f]{128}(1b|1c)$/i.test(signature) || BigInt(`0x${signature.slice(66, 130)}`) > halfOrder) throw new Refusal('invalid_signature');
    let recovered: Address;
    try { recovered = await recoverTypedDataAddress({ ...permitTypedData(t.payer, t.spender, t.amount, s.nonce, deadline), signature: signature as Hex }); }
    catch { throw new Refusal('invalid_signature'); }
    if (!same(recovered, t.payer)) throw new Refusal('invalid_signature');
    const price = await this.chain.gasPrice(); this.rate(price);
    const cost = this.config.gas * price;
    await this.budget?.assert(t.merchant, cost);
    const attemptId = id('approval');
    const call: ApprovalCall = { owner: t.payer, spender: t.spender, value: t.amount, deadline, signature: signature as Hex };
    const operation = { id: attemptId, kind: 'approval' as const, objectId: t.key, links: { approvalId: attemptId, merchantId: t.merchant } };
    this.chain.writer.reserve(operation, () => {
      bind?.();
      this.db.prepare('INSERT INTO approval_attempts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(attemptId, t.key, t.merchant, t.payer.toLowerCase(), USDT, t.spender, t.amount.toString(), s.nonce.toString(), deadline.toString(), 'prepared', 'approval_prepared', null, cost.toString(), now(), now());
    });
    await this.chain.writer.execute(operation, () => this.chain.transactionCount(), async txNonce => {
      const prepared = await this.chain.approval.prepare(call, txNonce, this.config.gas, price);
      this.chain.writer.reserveSpend(operation.id, cost, this.config.maxSpendPerMinute);
      return prepared;
    }, raw => this.chain.approval.broadcast(raw));
    this.budget?.record(t.merchant, attemptId, cost);
  }
  async reconcile(key?: string) {
    const rows = this.db.prepare("SELECT * FROM approval_attempts WHERE status IN ('prepared','pending') AND (? IS NULL OR payment_id=?)").all(key ?? null, key ?? null) as Attempt[];
    if (!rows.length) return;
    let safe: bigint;
    try { if (await this.chain.chainId() !== 1874) return; safe = await this.chain.latestBlock() - this.config.confirmations; } catch { return; }
    for (const a of rows) {
      if (!a.tx_hash) continue;
      try {
        const receipt = await this.chain.approval.receipt(a.tx_hash, a.payer);
        if (!receipt || !same(receipt.hash, a.tx_hash) || receipt.block > safe) continue;
        if (receipt.status !== 'success' && receipt.status !== 'reverted') continue;
        // Finality resolves account nonce uncertainty independently of approval semantics.
        this.chain.writer.resolve(a.tx_hash, receipt.block, receipt.status, receipt.gasCostWei);
        let status: string, reason: string | null;
        if (receipt.status === 'reverted') { status = 'failed'; reason = 'transaction_reverted'; }
        // The token's own Approval event for this owner, spender and value proves the permit took effect;
        // a payment or renewal may already have spent the allowance by the time we read it.
        else if (receipt.approvals.some(e => same(e.owner, a.payer) && same(e.spender, a.spender) && e.value === BigInt(a.amount_minor))) { status = 'succeeded'; reason = null; }
        else { status = 'reconciliation_required'; reason = 'missing_approval_event'; }
        this.db.prepare("UPDATE approval_attempts SET status=?,reason=?,updated_at=? WHERE id=? AND tx_hash=? AND status IN ('prepared','pending')").run(status, reason, now(), a.id, a.tx_hash);
      } catch { /* Unknown RPC/receipt state is pending, never dropped. */ }
    }
  }
}

export function approvalConfig(env: NodeJS.ProcessEnv, escrow: Address, minimumAmount: bigint): ApprovalConfig {
  return { enabled: env.CHECKOUT_APPROVAL_ENABLED !== 'false', escrow, minimumAmount: minimumAmount > 1_000_000n ? minimumAmount : 1_000_000n,
    gas: BigInt(env.CHECKOUT_APPROVAL_GAS ?? '120000'), maxGasPrice: BigInt(env.CHECKOUT_APPROVAL_MAX_GAS_PRICE_WEI ?? '20000000000'), maxSpendPerMinute: BigInt(env.CHECKOUT_APPROVAL_MAX_SPEND_PER_MINUTE_WEI ?? '50000000000000000'), maxPerMinute: Number(env.CHECKOUT_APPROVAL_MAX_PER_MINUTE ?? '30'), confirmations: BigInt(env.CONFIRMATIONS ?? '2') };
}
