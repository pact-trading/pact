import { recoverAuthorizationAddress } from 'viem/utils';
import { encodeAbiParameters, isAddress, keccak256, recoverMessageAddress, type Address, type Hex, type SignedAuthorization } from 'viem';
import type { ChainAdapter } from './types.js';
import { Refusal } from './types.js';
import { id, now, type Db } from './db.js';
import type { ApprovalCall, ApprovalSnapshot } from './approval-chain.js';
import { pendingPaymentIntent } from './payment-state.js';
import { USDT } from './token.js';
export { USDT } from './token.js';

export const APPROVER: Address = '0x3CEc4a4Eff3c1ef0F8F8e1a4f20F98c2c2baBC3f';
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const halfOrder = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
const uint = (x: unknown): bigint => { if (typeof x !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(x) || BigInt(x) >= 2n ** 256n) throw new Refusal('invalid_integer'); return BigInt(x); };
export function approvalMessage(payer: Address, spender: Address, amount: bigint, nonce: bigint, deadline: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1874n, payer, USDT, spender, amount, nonce, deadline]));
}
export interface ApprovalTarget { key: string; merchant: string; payer: Address; spender: Address; amount: bigint; minimumBalance: bigint }
export interface ApprovalConfig { enabled: boolean; delegate: Address; runtimeHash?: Hex; escrow: Address; minimumAmount: bigint; gas?: bigint; maxGasPrice?: bigint; maxSpendPerMinute?: bigint; maxPerMinute?: number; confirmations?: bigint }
type Attempt = { id: string; payment_id: string; merchant_id: string; payer: Address; token: Address; spender: Address; amount_minor: string; approval_nonce: string; deadline: string; status: string; reason: string | null; tx_hash: Hex | null; cost_wei: string; created_at: string };
type Payment = { id: string; merchant_id: string; payer: string | null; amount_minor: string; currency: string; status: string; expires_at: string | null };
export interface Readiness {
  paymentId: string; payer: Address; chainId: number; token: Address; spender: Address; amount: string;
  balance: string | null; allowance: string | null; delegate: Address; delegateState: 'none' | 'expected' | 'unknown';
  approvalNonce: string | null; authorizationNonce: string | null; deadline: string | null; message: Hex | null; authorizationRequired: boolean;
  status: 'needs_funding' | 'needs_approval' | 'ready' | 'pending' | 'unavailable'; reason?: string; attemptId?: string; txHash?: Hex | null;
}
export class ApprovalService {
  private config: Required<Omit<ApprovalConfig, 'runtimeHash'>> & Pick<ApprovalConfig, 'runtimeHash'>;
  /**
   * Who a payment's USDT is approved to: the escrow, or the receivables contract when the payment is
   * for a financed invoice (the contract pays the claim holders). Set when financing is deployed.
   */
  spenderFor?: (paymentId: string) => Promise<Address | null>;
  receivables?: Address;
  private async spender(paymentId: string) { return (await this.spenderFor?.(paymentId)) ?? this.config.escrow; }
  private pendingCharge(paymentId: string) { return pendingPaymentIntent(this.db, paymentId, this.config.escrow, this.receivables); }
  constructor(private db: Db, private chain: ChainAdapter, config: ApprovalConfig) {
    this.config = { gas: 200_000n, maxGasPrice: 20_000_000_000n, maxSpendPerMinute: 10_000_000_000_000_000n, maxPerMinute: 5, confirmations: 2n, ...config };
    const c = this.config;
    if (c.gas < 80_000n || c.gas > 300_000n || c.maxGasPrice <= 0n || c.maxGasPrice > 100_000_000_000n || c.maxSpendPerMinute <= 0n || c.maxSpendPerMinute > 10n ** 17n || !Number.isSafeInteger(c.maxPerMinute) || c.maxPerMinute < 1 || c.maxPerMinute > 10 || c.confirmations < 1n || c.minimumAmount < 1_000_000n) throw new Error('Invalid approval limits');
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
  private attempt(paymentId: string) { return this.db.prepare('SELECT * FROM approval_attempts WHERE payment_id=?').get(paymentId) as Attempt | undefined; }
  private paymentReason(p: Payment) {
    if (p.status !== 'open') return 'payment_not_open';
    if (p.expires_at && new Date(p.expires_at).getTime() <= Date.now()) return 'payment_expired';
    if (p.currency !== 'USDT') return 'unsupported_token';
    if (BigInt(p.amount_minor) < this.config.minimumAmount || BigInt(p.amount_minor) >= 2n ** 256n) return 'below_minimum';
  }
  private configReason() {
    const c = this.config;
    if (!c.enabled) return 'feature_disabled';
    if (!isAddress(c.escrow) || /^0x0{40}$/i.test(c.escrow) || !same(c.delegate, APPROVER) || !c.runtimeHash || !/^0x[0-9a-f]{64}$/i.test(c.runtimeHash)) return 'approval_unconfigured';
  }
  private state(s: ApprovalSnapshot): Readiness['delegateState'] {
    return s.code === '0x' ? 'none' : same(s.code, `0xef0100${this.config.delegate.slice(2)}`) ? 'expected' : 'unknown';
  }
  private runtimeReason(s: ApprovalSnapshot) {
    if (!this.config.runtimeHash || s.runtime === '0x' || !same(keccak256(s.runtime), this.config.runtimeHash)) return 'delegate_runtime_mismatch';
    if (this.state(s) === 'unknown') return 'unknown_delegation';
  }
  private budget(price: bigint) {
    if (price <= 0n || price > this.config.maxGasPrice) throw new Refusal('approval_gas_price');
    const rows = this.db.prepare('SELECT cost_wei FROM approval_attempts WHERE created_at>=?').all(new Date(Date.now() - 60_000).toISOString()) as Array<{ cost_wei: string }>;
    if (rows.length >= this.config.maxPerMinute || rows.reduce((sum, r) => sum + BigInt(r.cost_wei), 0n) + this.config.gas * price > this.config.maxSpendPerMinute) throw new Refusal('approval_budget');
  }
  async get(paymentId: string, merchant: string, payer: Address): Promise<Readiness> {
    this.payment(paymentId, merchant, payer);
    await this.reconcile(paymentId);
    const p = this.payment(paymentId, merchant, payer);
    const a = this.attempt(paymentId);
    const charge = this.pendingCharge(paymentId);
    let spender: Address;
    try { spender = await this.spender(paymentId); }
    catch { return { paymentId, payer, chainId: 1874, token: USDT, spender: this.config.escrow, amount: p.amount_minor, balance: null, allowance: null, delegate: this.config.delegate, delegateState: 'unknown', approvalNonce: null, authorizationNonce: null, deadline: null, message: null, authorizationRequired: false, status: 'unavailable', reason: 'financing_unavailable' }; }
    const out: Readiness = { paymentId, payer, chainId: 1874, token: USDT, spender, amount: p.amount_minor, balance: null, allowance: null, delegate: this.config.delegate, delegateState: 'unknown', approvalNonce: null, authorizationNonce: null, deadline: null, message: null, authorizationRequired: false, status: 'unavailable' };
    if (a) { out.attemptId = a.id; out.txHash = a.tx_hash; }
    // The invoice was financed (or settled) after this approval: it approved a different contract.
    if (a && !charge && !same(a.spender, spender)) return { ...out, reason: 'payment_route_changed' };
    let snapshot: ApprovalSnapshot | undefined;
    let readReason: string | undefined;
    try {
      if (await this.chain.chainId() !== 1874) readReason = 'wrong_chain';
      else {
        snapshot = await this.chain.approval.snapshot(payer, USDT, spender, this.config.delegate);
        Object.assign(out, { balance: snapshot.balance.toString(), allowance: snapshot.allowance.toString(), delegateState: this.state(snapshot) });
      }
    } catch { readReason = 'rpc_unavailable'; }
    // Persisted uncertainty takes precedence over balances/allowance/config. A
    // refresh must never invite a second charge or an ambiguous approval send.
    if (charge) return { ...out, status: 'pending', reason: 'payment_pending', txHash: charge.tx_hash as Hex | null };
    if (a && ['prepared', 'pending'].includes(a.status)) return { ...out, status: 'pending', reason: a.reason ?? 'approval_pending' };
    if (a && ['failed', 'reconciliation_required'].includes(a.status)) return { ...out, reason: a.reason ?? 'approval_failed' };
    const reason = this.configReason() ?? this.paymentReason(p) ?? readReason ?? (snapshot && this.runtimeReason(snapshot));
    if (reason || !snapshot) return { ...out, reason: reason ?? 'rpc_unavailable' };
    const deadline = BigInt(Math.min(Math.floor(Date.now() / 1000) + 300, p.expires_at ? Math.floor(new Date(p.expires_at).getTime() / 1000) : Number.MAX_SAFE_INTEGER));
    Object.assign(out, { approvalNonce: snapshot.approvalNonce.toString(), authorizationNonce: snapshot.authorizationNonce.toString(), deadline: deadline.toString(), authorizationRequired: out.delegateState === 'none', message: approvalMessage(payer, spender, BigInt(p.amount_minor), snapshot.approvalNonce, deadline) });
    if (snapshot.balance < BigInt(p.amount_minor)) return { ...out, status: 'needs_funding', reason: 'insufficient_usdt' };
    if (snapshot.allowance >= BigInt(p.amount_minor)) return { ...out, status: 'ready' };
    if (a) return { ...out, reason: 'allowance_insufficient_after_approval' };
    try { this.budget(await this.chain.gasPrice()); }
    catch (e) { return { ...out, reason: e instanceof Refusal ? e.code : 'rpc_unavailable' }; }
    return { ...out, status: 'needs_approval' };
  }
  async submit(paymentId: string, merchant: string, body: Record<string, unknown>): Promise<Readiness> {
    if (Object.keys(body).some(k => !['payer', 'approvalNonce', 'deadline', 'signature', 'authorization'].includes(k))) throw new Refusal('unexpected_field');
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
        if (await this.chain.chainId() !== 1874) throw new Refusal('wrong_chain');
        const s = await this.chain.approval.snapshot(payer, USDT, spender, this.config.delegate);
        const runtime = this.runtimeReason(s); if (runtime) throw new Refusal(runtime);
        const amount = BigInt(p.amount_minor);
        if (s.balance < amount) throw new Refusal('insufficient_usdt');
        if (s.allowance >= amount) return;
        const nonce = uint(body.approvalNonce), deadline = uint(body.deadline);
        const seconds = BigInt(Math.floor(Date.now() / 1000));
        if (deadline <= seconds || deadline > seconds + 300n || (p.expires_at && deadline > BigInt(Math.floor(new Date(p.expires_at).getTime() / 1000)))) throw new Refusal('approval_deadline');
        if (nonce !== s.approvalNonce) throw new Refusal('approval_nonce');
        const signature = body.signature;
        if (typeof signature !== 'string' || !/^0x[0-9a-f]{128}(1b|1c)$/i.test(signature) || BigInt(`0x${signature.slice(66, 130)}`) > halfOrder) throw new Refusal('invalid_signature');
        const recovered = await recoverMessageAddress({ message: { raw: approvalMessage(payer, spender, amount, nonce, deadline) }, signature: signature as Hex });
        if (!same(recovered, payer)) throw new Refusal('invalid_signature');
        let authorization: SignedAuthorization | undefined;
        if (this.state(s) === 'none') {
          const a = body.authorization as Record<string, unknown> | undefined;
          if (!a || typeof a !== 'object' || Object.keys(a).some(k => !['address', 'chainId', 'nonce', 'r', 's', 'yParity'].includes(k))) throw new Refusal('authorization_required');
          if (a.chainId !== 1874 || typeof a.address !== 'string' || !same(a.address, this.config.delegate) || !Number.isSafeInteger(a.nonce) || a.nonce !== s.authorizationNonce || ![0, 1].includes(a.yParity as number) || !/^0x[0-9a-f]{64}$/i.test(String(a.r)) || !/^0x[0-9a-f]{64}$/i.test(String(a.s)) || BigInt(String(a.s)) > halfOrder) throw new Refusal('invalid_authorization');
          authorization = a as unknown as SignedAuthorization;
          if (!same(await recoverAuthorizationAddress({ authorization }), payer)) throw new Refusal('invalid_authorization');
        } else if (body.authorization !== undefined) throw new Refusal('unexpected_authorization');
        const price = await this.chain.gasPrice(); this.budget(price);
        const attemptId = id('approval');
        const call: ApprovalCall = { payer, token: USDT, spender, amount, approvalNonce: nonce, deadline, signature: signature as Hex, authorization };
        // Recheck after asynchronous signature/RPC operations before binding.
        const latest = this.payment(paymentId, merchant, payer);
        const changed = this.paymentReason(latest); if (changed) throw new Refusal(changed);
        if (this.pendingCharge(paymentId)) throw new Refusal('payment_pending');
        const operation = { id: attemptId, kind: 'approval' as const, objectId: paymentId, links: { approvalId: attemptId } };
        this.chain.writer.reserve(operation, () => {
          this.db.prepare('INSERT INTO approval_attempts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(attemptId, paymentId, merchant, payer.toLowerCase(), USDT, spender, amount.toString(), nonce.toString(), deadline.toString(), 'prepared', 'approval_prepared', null, (this.config.gas * price).toString(), now(), now());
          this.db.prepare('UPDATE payments SET payer=? WHERE id=?').run(payer.toLowerCase(), paymentId);
        });
        await this.chain.writer.execute(operation, () => this.chain.transactionCount(), async nonce => {
          const prepared = await this.chain.approval.prepare(call, nonce, this.config.gas, price);
          this.chain.writer.reserveSpend(operation.id, this.config.gas * price, this.config.maxSpendPerMinute);
          return prepared;
        }, raw => this.chain.approval.broadcast(raw));
      });
    } catch (error) {
      // Concurrent duplicate waited in the same queue: return the durable
      // attempt instead of rejecting it or spending a second gas reservation.
      if (!this.attempt(paymentId)) throw error;
    }
    return this.get(paymentId, merchant, payer);
  }
  /**
   * A one-time approval that is not for a payment: for example the USDT a subscription may pull at
   * renewals (spender = SubscriptionManager). `key` names this approval; one attempt per key.
   * `minimumBalance` is what the payer must hold now (the first period), not the whole approval.
   */
  async getFor(t: ApprovalTarget): Promise<Readiness> {
    await this.reconcile(t.key);
    const a = this.attempt(t.key);
    if (a && (!same(a.payer, t.payer) || !same(a.spender, t.spender) || a.merchant_id !== t.merchant)) throw new Refusal('payer_mismatch');
    const out: Readiness = { paymentId: t.key, payer: t.payer, chainId: 1874, token: USDT, spender: t.spender, amount: t.amount.toString(), balance: null, allowance: null, delegate: this.config.delegate, delegateState: 'unknown', approvalNonce: null, authorizationNonce: null, deadline: null, message: null, authorizationRequired: false, status: 'unavailable' };
    if (a) { out.attemptId = a.id; out.txHash = a.tx_hash; }
    let snapshot: ApprovalSnapshot | undefined;
    try {
      if (await this.chain.chainId() !== 1874) return { ...out, reason: 'wrong_chain' };
      snapshot = await this.chain.approval.snapshot(t.payer, USDT, t.spender, this.config.delegate);
      Object.assign(out, { balance: snapshot.balance.toString(), allowance: snapshot.allowance.toString(), delegateState: this.state(snapshot) });
    } catch { return { ...out, reason: 'rpc_unavailable' }; }
    if (a && ['prepared', 'pending'].includes(a.status)) return { ...out, status: 'pending', reason: a.reason ?? 'approval_pending' };
    // This key's approval went through; renewals may already have spent part of it.
    if (a?.status === 'succeeded') return { ...out, status: snapshot.balance >= t.minimumBalance ? 'ready' : 'needs_funding', ...(snapshot.balance < t.minimumBalance && { reason: 'insufficient_usdt' }) };
    if (snapshot.allowance >= t.amount) return { ...out, status: snapshot.balance >= t.minimumBalance ? 'ready' : 'needs_funding', ...(snapshot.balance < t.minimumBalance && { reason: 'insufficient_usdt' }) };
    if (a && ['failed', 'reconciliation_required'].includes(a.status)) return { ...out, reason: a.reason ?? 'approval_failed' };
    const reason = this.configReason() ?? this.runtimeReason(snapshot);
    if (reason) return { ...out, reason };
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    Object.assign(out, { approvalNonce: snapshot.approvalNonce.toString(), authorizationNonce: snapshot.authorizationNonce.toString(), deadline: deadline.toString(), authorizationRequired: out.delegateState === 'none', message: approvalMessage(t.payer, t.spender, t.amount, snapshot.approvalNonce, deadline) });
    if (snapshot.balance < t.minimumBalance) return { ...out, status: 'needs_funding', reason: 'insufficient_usdt' };
    if (a) return { ...out, reason: 'allowance_insufficient_after_approval' };
    try { this.budget(await this.chain.gasPrice()); }
    catch (e) { return { ...out, reason: e instanceof Refusal ? e.code : 'rpc_unavailable' }; }
    return { ...out, status: 'needs_approval' };
  }
  async submitFor(t: ApprovalTarget, body: Record<string, unknown>): Promise<Readiness> {
    if (Object.keys(body).some(k => !['approvalNonce', 'deadline', 'signature', 'authorization'].includes(k))) throw new Refusal('unexpected_field');
    if (this.attempt(t.key)) return this.getFor(t);
    await this.chain.writer.run(async () => {
      const reason = this.configReason(); if (reason) throw new Refusal(reason);
      if (await this.chain.chainId() !== 1874) throw new Refusal('wrong_chain');
      const s = await this.chain.approval.snapshot(t.payer, USDT, t.spender, this.config.delegate);
      const runtime = this.runtimeReason(s); if (runtime) throw new Refusal(runtime);
      if (s.allowance >= t.amount) return;
      if (s.balance < t.minimumBalance) throw new Refusal('insufficient_usdt');
      const nonce = uint(body.approvalNonce), deadline = uint(body.deadline);
      const seconds = BigInt(Math.floor(Date.now() / 1000));
      if (deadline <= seconds || deadline > seconds + 300n) throw new Refusal('approval_deadline');
      if (nonce !== s.approvalNonce) throw new Refusal('approval_nonce');
      const signature = body.signature;
      if (typeof signature !== 'string' || !/^0x[0-9a-f]{128}(1b|1c)$/i.test(signature) || BigInt(`0x${signature.slice(66, 130)}`) > halfOrder) throw new Refusal('invalid_signature');
      const recovered = await recoverMessageAddress({ message: { raw: approvalMessage(t.payer, t.spender, t.amount, nonce, deadline) }, signature: signature as Hex });
      if (!same(recovered, t.payer)) throw new Refusal('invalid_signature');
      const authorization = await this.authorizationFor(s, t.payer, body.authorization);
      const price = await this.chain.gasPrice(); this.budget(price);
      const attemptId = id('approval');
      const call: ApprovalCall = { payer: t.payer, token: USDT, spender: t.spender, amount: t.amount, approvalNonce: nonce, deadline, signature: signature as Hex, authorization };
      const operation = { id: attemptId, kind: 'approval' as const, objectId: t.key, links: { approvalId: attemptId } };
      this.chain.writer.reserve(operation, () => {
        this.db.prepare('INSERT INTO approval_attempts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(attemptId, t.key, t.merchant, t.payer.toLowerCase(), USDT, t.spender, t.amount.toString(), nonce.toString(), deadline.toString(), 'prepared', 'approval_prepared', null, (this.config.gas * price).toString(), now(), now());
      });
      await this.chain.writer.execute(operation, () => this.chain.transactionCount(), async txNonce => {
        const prepared = await this.chain.approval.prepare(call, txNonce, this.config.gas, price);
        this.chain.writer.reserveSpend(operation.id, this.config.gas * price, this.config.maxSpendPerMinute);
        return prepared;
      }, raw => this.chain.approval.broadcast(raw));
    }).catch(error => { if (!this.attempt(t.key)) throw error; });
    return this.getFor(t);
  }
  private async authorizationFor(s: ApprovalSnapshot, payer: Address, raw: unknown): Promise<SignedAuthorization | undefined> {
    if (this.state(s) !== 'none') { if (raw !== undefined) throw new Refusal('unexpected_authorization'); return undefined; }
    const a = raw as Record<string, unknown> | undefined;
    if (!a || typeof a !== 'object' || Object.keys(a).some(k => !['address', 'chainId', 'nonce', 'r', 's', 'yParity'].includes(k))) throw new Refusal('authorization_required');
    if (a.chainId !== 1874 || typeof a.address !== 'string' || !same(a.address, this.config.delegate) || !Number.isSafeInteger(a.nonce) || a.nonce !== s.authorizationNonce || ![0, 1].includes(a.yParity as number) || !/^0x[0-9a-f]{64}$/i.test(String(a.r)) || !/^0x[0-9a-f]{64}$/i.test(String(a.s)) || BigInt(String(a.s)) > halfOrder) throw new Refusal('invalid_authorization');
    const authorization = a as unknown as SignedAuthorization;
    if (!same(await recoverAuthorizationAddress({ authorization }), payer)) throw new Refusal('invalid_authorization');
    return authorization;
  }
  async reconcile(paymentId?: string) {
    const rows = this.db.prepare("SELECT * FROM approval_attempts WHERE status IN ('prepared','pending') AND (? IS NULL OR payment_id=?)").all(paymentId ?? null, paymentId ?? null) as Attempt[];
    if (!rows.length) return;
    let safe: bigint;
    try { if (await this.chain.chainId() !== 1874) return; safe = await this.chain.latestBlock() - this.config.confirmations; } catch { return; }
    for (const a of rows) {
      if (!a.tx_hash) continue;
      try {
        const receipt = await this.chain.approval.receipt(a.tx_hash, a.payer);
        if (!receipt || !same(receipt.hash, a.tx_hash) || receipt.block > safe) continue;
        if (receipt.status !== 'success' && receipt.status !== 'reverted') continue;
        // Finality resolves account nonce uncertainty independently of approval
        // semantics, including revoked allowance or unavailable readback.
        this.chain.writer.resolve(a.tx_hash, receipt.block, receipt.status);
        let status: string, reason: string | null;
        if (receipt.status === 'reverted') { status = 'failed'; reason = 'transaction_reverted'; }
        else if (receipt.status === 'success') {
          const match = receipt.approvals.some(e => same(e.payer, a.payer) && same(e.token, a.token) && same(e.spender, a.spender) && e.amount === BigInt(a.amount_minor) && e.nonce === BigInt(a.approval_nonce));
          if (!match) { status = 'reconciliation_required'; reason = 'missing_approval_event'; }
          else {
            try {
              const s = await this.chain.approval.snapshot(a.payer, a.token, a.spender, this.config.delegate);
              // A subscription's allowance is spent by renewals, possibly before this read; the matched
              // ApprovalSponsored event proves the approval. Payments keep the strict allowance check.
              const spendsAllowance = !same(a.spender, this.config.escrow);
              if (this.runtimeReason(s) || this.state(s) !== 'expected' || (!spendsAllowance && s.allowance < BigInt(a.amount_minor))) { status = 'reconciliation_required'; reason = 'approval_readback_mismatch'; }
              else { status = 'succeeded'; reason = null; }
            } catch { continue; /* A read that fails now (RPC, a block not yet visible) is retried, not final. */ }
          }
        } else continue;
        this.db.prepare("UPDATE approval_attempts SET status=?,reason=?,updated_at=? WHERE id=? AND tx_hash=? AND status IN ('prepared','pending')").run(status, reason, now(), a.id, a.tx_hash);
      } catch { /* Unknown RPC/receipt state is pending, never dropped. */ }
    }
  }
}

export function approvalConfig(env: NodeJS.ProcessEnv, escrow: Address, minimumAmount: bigint): ApprovalConfig {
  return { enabled: env.CHECKOUT_APPROVAL_ENABLED === 'true', delegate: (env.SPONSORED_APPROVER_ADDRESS ?? APPROVER) as Address, runtimeHash: env.SPONSORED_APPROVER_RUNTIME_HASH as Hex | undefined, escrow, minimumAmount: minimumAmount > 1_000_000n ? minimumAmount : 1_000_000n,
    gas: BigInt(env.CHECKOUT_APPROVAL_GAS ?? '200000'), maxGasPrice: BigInt(env.CHECKOUT_APPROVAL_MAX_GAS_PRICE_WEI ?? '20000000000'), maxSpendPerMinute: BigInt(env.CHECKOUT_APPROVAL_MAX_SPEND_PER_MINUTE_WEI ?? '10000000000000000'), maxPerMinute: Number(env.CHECKOUT_APPROVAL_MAX_PER_MINUTE ?? '5'), confirmations: BigInt(env.CONFIRMATIONS ?? '2') };
}
