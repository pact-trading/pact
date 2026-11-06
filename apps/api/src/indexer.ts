import { storedMetadata } from './metadata.js';
import { amountString } from './db.js';
import { orderEvent } from './commerce/events.js';
import { chargedPeriods, discountView, renewalDiscountAmount } from './discounts.js';
import { decodeFunctionData, encodeAbiParameters, keccak256, toHex, type Hex } from 'viem';
import { escrowAbi, receivablesAbi, subscriptionAbi } from './chain.js';
import type { ChainAdapter, ChainEvent, IntentRequest } from './types.js';
import type { Db } from './db.js';
import { id, now } from './db.js';
import { enqueueWebhook } from './webhooks.js';
import { recordAccounting } from './accounting.js';
import { deadlineIso } from './merchant-settings.js';

type Row = Record<string, string>;
/** Router.Refusal, in the contract's enum order. */
export const ROUTER_REFUSALS = ['invalid_signature', 'deadline', 'replay', 'wrong_selector', 'quote_mismatch', 'dust', 'payer_daily_cap', 'gas_limit', 'gas_price', 'fee_unavailable', 'target_failed', 'target_refused', 'signer_not_merchant'];
const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && String(a).toLowerCase() === String(b).toLowerCase();
const matches = (event: ChainEvent, contract: ChainEvent['contract'], name: string, args: Record<string, unknown>) => event.contract === contract && event.name === name && Object.entries(args).every(([key, value]) => same(event.args[key], value));
function expectedEvent(request: IntentRequest): { contract: ChainEvent['contract']; name: string; args: Record<string, unknown>; paymentId?: string } | undefined {
  try {
    const { functionName: name, args = [] } = decodeFunctionData({ abi: escrowAbi, data: request.data });
    const id = String(args[0]);
    const common = { contract: 'escrow' as const, paymentId: id };
    if (name === 'charge' || name === 'chargeInvoice' || name === 'authorize') return { ...common, name: name === 'authorize' ? 'Authorized' : 'Charged', args: { id, merchant: args[1], payer: request.intent.signer, amount: args[2] } };
    if (name === 'capture' || name === 'refund') return { ...common, name: name === 'capture' ? 'Captured' : 'Refunded', args: { id, amount: args[1], ...(name === 'refund' ? { reason: args[2] } : {}) } };
    if (name === 'void' || name === 'reclaim') return { ...common, name: name === 'void' ? 'Voided' : 'Reclaimed', args: { id } };
  } catch { /* Try the other allowlisted target ABI. */ }
  try {
    const { functionName: name, args = [] } = decodeFunctionData({ abi: subscriptionAbi, data: request.data });
    const contract = 'subscription' as const;
    if (name === 'charge') return { contract, name: 'Charged', args: { id: args[0], amount: args[1] } };
    if (name === 'cancel') return { contract, name: 'Cancelled', args: { id: args[0] } };
    if (name === 'subscribe' || name === 'replace') {
      const mandate = args[name === 'subscribe' ? 0 : 1] as { payer: Hex; nonce: bigint; merchant: Hex; planId: Hex };
      const id = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'address' }], [mandate.payer, mandate.nonce, request.intent.target]));
      return name === 'subscribe' ? { contract, name: 'Subscribed', args: { id, payer: mandate.payer, merchant: mandate.merchant, planId: mandate.planId } } : { contract, name: 'Replaced', args: { oldId: args[0], newId: id } };
    }
  } catch { /* Try the receivables contract. */ }
  try {
    const { functionName: name, args = [] } = decodeFunctionData({ abi: receivablesAbi, data: request.data });
    // A financed invoice's payment: the receivables contract pays the claim holders and the merchant.
    if (name === 'pay') return { contract: 'receivables', name: 'Paid', args: { claimId: args[0], paymentId: args[1], payer: request.intent.signer, amount: args[2] }, paymentId: String(args[1]) };
  } catch { /* Unknown calls require operator reconciliation. */ }
}
/** Payments settled by the receivables contract: not refundable through the escrow. */
export function initFinancedPayments(db: Db) {
  db.exec('CREATE TABLE IF NOT EXISTS financed_payments(payment_id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, to_holders_minor TEXT NOT NULL, to_merchant_minor TEXT NOT NULL)');
}
function is429(error: unknown) { return /429|rate.limit|too many requests/i.test(String(error)); }
export class Indexer {
  constructor(private db: Db, private chain: ChainAdapter, private startBlock = 0n, private confirmations = 2n) {
    initFinancedPayments(db);
  }
  async poll() {
    await this.chain.writer.reconcile(this.chain, this.confirmations);
    if (await this.chain.chainId() !== 1874) throw new Error('Wrong chain');
    const latest = await this.chain.latestBlock();
    if (latest < this.confirmations) return 0;
    const safe = latest - this.confirmations;
    const row = this.db.prepare("SELECT block_number FROM cursor WHERE name='settle'").get() as { block_number: string } | undefined;
    let from = row ? BigInt(row.block_number) + 1n : this.startBlock;
    let count = 0;
    while (from <= safe) {
      const to = from + 99n < safe ? from + 99n : safe;
      let logs: ChainEvent[] | undefined;
      for (let retry = 0; retry < 5; retry++) {
        try { logs = await this.chain.events(from, to); break; }
        catch (e) { if (!is429(e) || retry === 4) throw e; await new Promise(r => setTimeout(r, 250 * 2 ** retry)); }
      }
      const pending = new Set<string>(this.pendingHashes());
      this.db.transaction(() => {
        for (const event of logs ?? []) {
          // Tracked transactions are settled from their confirmed receipt below.
          // Advancing the log cursor is safe: the receipt supplies the logs later.
          if (pending.has(event.txHash.toLowerCase())) continue;
          if (this.db.prepare('SELECT 1 FROM chain_events WHERE id=?').get(event.id)) continue;
          this.apply(event);
          this.db.prepare('INSERT INTO chain_events VALUES (?,?,?,?)').run(event.id, event.block.toString(), event.txHash, now());
          count++;
        }
        this.db.prepare("INSERT INTO cursor VALUES ('settle',?) ON CONFLICT(name) DO UPDATE SET block_number=excluded.block_number").run(to.toString());
      })();
      from = to + 1n;
    }
    return count + await this.reconcile(safe);
  }
  private pendingHashes(): Hex[] {
    return (this.db.prepare(`SELECT lower(tx_hash) AS hash FROM intents WHERE status IN ('submitted','reconciliation_required') AND tx_hash IS NOT NULL
      UNION SELECT lower(tx_hash) FROM refunds WHERE status='pending' AND tx_hash IS NOT NULL
      UNION SELECT lower(pending_tx_hash) FROM subscriptions WHERE pending_tx_hash IS NOT NULL`).all() as { hash: Hex }[]).map(row => row.hash);
  }
  private note(merchantId: string, objectId: string, hash: Hex, reason: string) {
    if (this.db.prepare('SELECT 1 FROM refusal_attempts WHERE merchant_id=? AND object_id=? AND lower(tx_hash)=lower(?) AND reason=?').get(merchantId, objectId, hash, reason)) return;
    this.db.prepare('INSERT INTO refusal_attempts (id,merchant_id,object_id,reason,tx_hash,created_at) VALUES (?,?,?,?,?,?)').run(id('refusal'), merchantId, objectId, reason, hash, now());
    enqueueWebhook(this.db, merchantId, reason === 'transaction_reverted' ? 'transaction.failed' : 'transaction.reconciliation_required', objectId, { tx_hash: hash, reason });
  }
  private recordEvent(event: ChainEvent): number {
    if (this.db.prepare('SELECT 1 FROM chain_events WHERE id=?').get(event.id)) return 0;
    this.apply(event);
    this.db.prepare('INSERT INTO chain_events VALUES (?,?,?,?)').run(event.id, event.block.toString(), event.txHash, now());
    return 1;
  }
  private async reconcile(safe: bigint): Promise<number> {
    let count = 0;
    for (const hash of this.pendingHashes()) {
      let receipt;
      try { receipt = await this.chain.receipt(hash); }
      catch { continue; } // RPC failure is uncertainty, never proof of failure.
      if (!receipt || !same(receipt.txHash, hash) || receipt.block > safe) continue;
      if (receipt.status !== 'success' && receipt.status !== 'reverted') continue;
      const events = receipt.events.filter(event => same(event.txHash, hash) && event.block === receipt.block);
      this.db.transaction(() => {
        // Re-read after the RPC await: another request may have replaced a pending hash.
        const intents = this.db.prepare("SELECT * FROM intents WHERE lower(tx_hash)=? AND (status IN ('submitted','reconciliation_required') OR (status='confirmed' AND EXISTS (SELECT 1 FROM refunds r WHERE lower(r.tx_hash)=lower(intents.tx_hash) AND r.status='pending')))").all(hash) as Row[];
        const refunds = this.db.prepare("SELECT r.*,p.merchant_id FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE lower(r.tx_hash)=? AND r.status='pending'").all(hash) as Row[];
        const subscriptions = this.db.prepare("SELECT s.*,p.amount_minor,p.period_seconds,m.address AS merchant_address FROM subscriptions s JOIN plans p ON p.id=s.plan_id JOIN merchants m ON m.id=s.merchant_id WHERE lower(s.pending_tx_hash)=?").all(hash) as Row[];
        for (const intent of intents) {
          let request: IntentRequest | undefined;
          try {
            const parsed = JSON.parse(intent.request_json) as IntentRequest;
            if (parsed?.intent && typeof parsed.data === 'string') request = parsed;
          } catch { /* Preserve the operation for review. */ }
          const expected = request && expectedEvent(request);
          const objectId = refunds[0]?.payment_id ?? expected?.paymentId ?? intent.id;
          const identity = request && { signer: request.intent.signer, merchant: request.intent.merchant, nonce: request.intent.nonce };
          const refused = identity && events.find(event => matches(event, 'router', 'Refused', identity));
          const executed = identity && events.find(event => matches(event, 'router', 'Executed', { ...identity, target: request!.intent.target }));
          const target = expected && events.find(event => matches(event, expected.contract, expected.name, expected.args));
          const replacement = this.db.prepare('SELECT * FROM subscription_replacements WHERE intent_id=?').get(intent.id) as { old_id: string; new_id: string } | undefined;
          const replacementEvents: ChainEvent[] = [];
          if (expected?.name === 'Replaced') {
            const decoded = decodeFunctionData({ abi: subscriptionAbi, data: request!.data });
            const mandate = decoded.args![1] as { payer: Hex; merchant: Hex; planId: Hex };
            const created = events.find(event => matches(event, 'subscription', 'Subscribed', { id: expected.args.newId, payer: mandate.payer, merchant: mandate.merchant, planId: mandate.planId }));
            const cancelled = events.find(event => matches(event, 'subscription', 'Cancelled', { id: expected.args.oldId }));
            if (created && cancelled) replacementEvents.push(created, cancelled);
          }
          if (replacement && (receipt.status === 'reverted' || refused)) {
            const operation = this.db.prepare('SELECT links_json FROM relayer_operations WHERE operation_id=?').get(intent.id) as { links_json: string } | undefined;
            const previous = operation ? JSON.parse(operation.links_json).previousSubscriptionStatus : undefined;
            if (!['trialing', 'active', 'past_due', 'paused'].includes(previous)) throw new Error('Replacement has no prior subscription state');
            this.db.prepare("UPDATE subscriptions SET status=CASE WHEN status='cancelled' THEN status ELSE ? END,pending_tx_hash=NULL WHERE id=? AND lower(pending_tx_hash)=?").run(previous, replacement.old_id, hash);
            this.db.prepare("UPDATE subscriptions SET status=CASE WHEN status='cancelled' THEN status ELSE 'failed' END,pending_tx_hash=NULL WHERE id=? AND lower(pending_tx_hash)=?").run(replacement.new_id, hash);
          }
          if (receipt.status === 'success' && refused) {
            if (this.db.prepare('SELECT 1 FROM chain_events WHERE id=?').get(refused.id)) this.apply(refused);
            else count += this.recordEvent(refused);
            continue;
          }
          if (receipt.status === 'success' && executed && target && (expected!.name !== 'Replaced' || replacementEvents.length === 2)) {
            for (const event of replacementEvents) count += this.recordEvent(event);
            count += this.recordEvent(target);
            count += this.recordEvent(executed);
            this.db.prepare("UPDATE intents SET status='confirmed',reason=NULL WHERE id=?").run(intent.id);
            if (expected!.name === 'Refunded') this.db.prepare("UPDATE refunds SET status='succeeded' WHERE lower(tx_hash)=? AND payment_id=? AND amount_minor=? AND status='pending'").run(hash, String(expected!.args.id), String(expected!.args.amount));
            continue;
          }
          const reason = receipt.status === 'reverted' ? 'transaction_reverted' : 'missing_expected_event';
          const status = receipt.status === 'reverted' ? 'failed' : 'reconciliation_required';
          this.db.prepare('UPDATE intents SET status=?,reason=? WHERE id=?').run(status, reason, intent.id);
          // A failed attempt must never erase an earlier captured/refunded balance.
          if (expected?.paymentId && ['Charged', 'Authorized'].includes(expected.name)) this.db.prepare("UPDATE payments SET status=?,tx_hash=? WHERE id=? AND merchant_id=? AND captured_minor='0' AND status IN ('open','failed','reconciliation_required')").run(status, hash, expected.paymentId, intent.merchant_id);
          this.note(intent.merchant_id, objectId, hash, reason);
        }
        for (const refund of refunds) {
          // Only legacy refund-only rows may use this fallback. Linked refunds
          // must pass the full signed-intent/event match above, including reason
          // and Router Executed; id/amount alone must not bypass ambiguity.
          if (receipt.status === 'success' && this.db.prepare('SELECT 1 FROM intents WHERE lower(tx_hash)=?').get(hash)) continue;
          const settled = events.find(event => matches(event, 'escrow', 'Refunded', { id: refund.payment_id, amount: refund.amount_minor }));
          if (receipt.status === 'success' && settled) {
            count += this.recordEvent(settled);
            // Also handles an event indexed before the refund row was persisted.
            this.db.prepare("UPDATE refunds SET status='succeeded' WHERE id=? AND status='pending'").run(refund.id);
          } else if (receipt.status === 'reverted') {
            this.db.prepare("UPDATE refunds SET status='failed' WHERE id=? AND status='pending'").run(refund.id);
            this.note(refund.merchant_id, refund.payment_id, hash, 'transaction_reverted');
          } else if ((this.db.prepare('SELECT status FROM refunds WHERE id=?').get(refund.id) as Row).status === 'pending') {
            // Keep status=pending: app.ts reserves ONLY pending refunds. A different
            // status would accidentally free money whose outcome remains ambiguous.
            this.note(refund.merchant_id, refund.payment_id, hash, 'missing_expected_event');
          }
        }
        for (const sub of subscriptions) {
          const current = this.db.prepare('SELECT pending_tx_hash FROM subscriptions WHERE id=?').get(sub.id) as Row;
          if (!same(current.pending_tx_hash, hash)) continue;
          // Router-mediated subscription operations must pass the intent match;
          // a target-only fallback must not bypass a missing Executed event.
          const linked = this.db.prepare('SELECT status FROM intents WHERE lower(tx_hash)=?').all(hash) as Row[];
          if (receipt.status === 'success' && linked.length) {
            if (linked.every(i => i.status === 'confirmed' || i.status === 'refused')) this.db.prepare('UPDATE subscriptions SET pending_tx_hash=NULL WHERE id=? AND lower(pending_tx_hash)=?').run(sub.id, hash);
            else this.db.prepare("UPDATE subscriptions SET status=CASE WHEN status='cancelled' THEN status ELSE 'reconciliation_required' END WHERE id=? AND lower(pending_tx_hash)=?").run(sub.id, hash);
            continue;
          }
          if (receipt.status === 'reverted') {
            this.db.prepare("UPDATE subscriptions SET status=CASE WHEN status='cancelled' THEN status ELSE 'paused' END,pending_tx_hash=NULL WHERE id=? AND lower(pending_tx_hash)=?").run(sub.id, hash);
            this.note(sub.merchant_id, sub.id, hash, 'transaction_reverted');
            continue;
          }
          // The stored hash covers both creation and renewal. Require a matching
          // object and event payload; an EVM-success receipt alone proves neither.
          const charged = chargedPeriods(this.db, sub.chain_id);
          const expected = events.find(event => matches(event, 'subscription', 'Subscribed', { id: sub.chain_id, payer: sub.payer, merchant: sub.merchant_address, planId: keccak256(toHex(sub.plan_id)) })) ?? events.find(event => matches(event, 'subscription', 'Charged', { id: sub.chain_id, amount: renewalDiscountAmount(this.db, sub.id, charged + 1) })) ?? events.find(event => matches(event, 'subscription', 'Cancelled', { id: sub.chain_id }));
          const refused = events.find(event => matches(event, 'subscription', 'Refused', { id: sub.chain_id }));
          if (expected || refused) {
            count += this.recordEvent((expected ?? refused)!);
            // apply() owns the business transition. Replaying an already-indexed
            // receipt only releases its own pending hash; it never retries a
            // refusal or reactivates a subscription cancelled in another tx.
            this.db.prepare('UPDATE subscriptions SET pending_tx_hash=NULL WHERE id=? AND lower(pending_tx_hash)=?').run(sub.id, hash);
          } else {
            this.db.prepare("UPDATE subscriptions SET status=CASE WHEN status='cancelled' THEN status ELSE 'reconciliation_required' END WHERE id=? AND lower(pending_tx_hash)=?").run(sub.id, hash);
            this.note(sub.merchant_id, sub.id, hash, 'missing_expected_event');
          }
        }
      })();
    }
    return count;
  }
  /** A financed invoice's payment, settled by the receivables contract: the invoice is paid as with an escrow charge. */
  private applyFinancedPayment(e: ChainEvent, context: Record<string, unknown>) {
    const args = e.args;
    const paymentId = String(args.paymentId);
    const p = this.db.prepare('SELECT * FROM payments WHERE id=?').get(paymentId) as Record<string, string> | undefined;
    if (!p) return;
    const amount = BigInt(String(args.amount));
    if (amount !== BigInt(p.amount_minor) || (p.payer && !same(p.payer, args.payer)) || BigInt(p.captured_minor) !== 0n) {
      this.note(p.merchant_id, paymentId, e.txHash, 'payment_event_mismatch');
      return;
    }
    recordAccounting(this.db, e);
    // No refund window: the money went to the claim holders, not into an escrow payment.
    this.db.prepare("UPDATE payments SET status='captured',captured_minor=?,tx_hash=?,payer=COALESCE(payer,?),refund_deadline=NULL WHERE id=?").run(amount.toString(), e.txHash, String(args.payer).toLowerCase(), paymentId);
    this.db.prepare('INSERT OR IGNORE INTO financed_payments VALUES (?,?,?,?)').run(paymentId, String(args.claimId), String(args.toHolders ?? 0), String(args.toMerchant ?? 0));
    const metadata = storedMetadata(p.custom_metadata);
    const fee = BigInt(String(args.fee ?? 0));
    enqueueWebhook(this.db, p.merchant_id, 'payment.captured', paymentId, { ...context, amount_minor: amount.toString(), fee_minor: fee.toString(), net_minor: (amount - fee).toString(), metadata, data: { amount: amountString(amount), fee: amountString(fee), net: amountString(amount - fee), currency: 'USDT', customer: p.customer ?? null, tx_hash: e.txHash, metadata, financed: true } });
    const invoiceId = (JSON.parse(p.metadata ?? '{}') as { invoiceId?: string }).invoiceId;
    if (!invoiceId) return;
    const invoice = this.db.prepare('SELECT * FROM invoices WHERE id=? AND merchant_id=?').get(invoiceId, p.merchant_id) as Record<string, string> | undefined;
    if (!invoice) return;
    const paid = BigInt(invoice.paid_minor) + amount;
    const status = paid >= BigInt(invoice.amount_minor) ? 'paid' : 'partially_paid';
    this.db.prepare('UPDATE invoices SET paid_minor=?,status=? WHERE id=?').run(paid.toString(), status, invoiceId);
    if (status === 'paid') enqueueWebhook(this.db, p.merchant_id, 'invoice.paid', invoiceId, context);
  }
  private apply(e: ChainEvent) {
    const args = e.args;
    const objectId = String(args.id ?? '');
    const context = { tx_hash: e.txHash, block_number: e.block.toString() };
    let paidContext: Record<string, unknown> = context;
    if (e.contract === 'escrow') {
      const p = this.db.prepare('SELECT * FROM payments WHERE id=?').get(objectId) as Record<string, string> | undefined;
      if (!p) return;
      const merchant = this.db.prepare('SELECT address FROM merchants WHERE id=?').get(p.merchant_id) as { address: string } | undefined;
      const amount = args.amount === undefined ? null : BigInt(args.amount);
      const merchantMismatch = args.merchant !== undefined && (!merchant || !same(args.merchant, merchant.address));
      const amountMismatch = (e.name === 'Charged' || e.name === 'Authorized') ? amount !== BigInt(p.amount_minor)
        : e.name === 'Captured' ? (p.status !== 'authorized' && BigInt(p.captured_minor) === 0n) || amount === null || amount <= 0n || BigInt(p.captured_minor) + amount > BigInt(p.amount_minor)
        : e.name === 'Refunded' ? amount === null || amount <= 0n || BigInt(p.refunded_minor) + amount > BigInt(p.captured_minor)
        : false;
      if (merchantMismatch || amountMismatch) {
        this.note(p.merchant_id, objectId, e.txHash, 'payment_event_mismatch');
        if (BigInt(p.captured_minor) === 0n) this.db.prepare("UPDATE payments SET status='reconciliation_required' WHERE id=?").run(objectId);
        return;
      }
      recordAccounting(this.db, e);
      if (e.paymentTerms && ['Authorized', 'Charged', 'Captured'].includes(e.name)) {
        // Read from the configured escrow at the confirmed event block. Never
        // recompute an existing payment's deadline from today's merchant settings.
        this.db.prepare(`INSERT INTO payment_contract_terms VALUES (?,?,?) ON CONFLICT(payment_id) DO UPDATE SET
          refund_window_seconds=excluded.refund_window_seconds,refund_deadline_unix=excluded.refund_deadline_unix`)
          .run(objectId, e.paymentTerms.refundWindowSeconds, e.paymentTerms.refundDeadlineUnix);
        this.db.prepare('UPDATE payments SET refund_deadline=? WHERE id=?').run(deadlineIso(e.paymentTerms.refundDeadlineUnix), objectId);
      }
      if (e.name === 'Authorized') this.db.prepare("UPDATE payments SET status='authorized',tx_hash=? WHERE id=?").run(e.txHash, objectId);
      if (e.name === 'Captured' || e.name === 'Charged') {
        const captured = BigInt(p.captured_minor) + BigInt(String(args.amount));
        this.db.prepare("UPDATE payments SET status='captured',captured_minor=?,tx_hash=?,payer=COALESCE(?,payer) WHERE id=?").run(captured.toString(), e.txHash, args.payer ?? null, objectId);
        const metadata = storedMetadata(p.custom_metadata);
        // Pact's fee came out of this payment: the merchant received the net.
        const fee = BigInt(String(args.fee ?? 0));
        paidContext = { ...context, amount_minor: String(args.amount), fee_minor: fee.toString(), net_minor: (BigInt(String(args.amount)) - fee).toString(), metadata, data: { amount: amountString(String(args.amount)), fee: amountString(fee), net: amountString(BigInt(String(args.amount)) - fee), currency: 'USDT', customer: p.customer ?? null, tx_hash: e.txHash, metadata } };
        enqueueWebhook(this.db, p.merchant_id, 'payment.captured', objectId, paidContext);
        const invoiceId = (JSON.parse(p.metadata ?? '{}') as { invoiceId?: string }).invoiceId;
        if (invoiceId) {
          const invoice = this.db.prepare('SELECT * FROM invoices WHERE id=? AND merchant_id=?').get(invoiceId, p.merchant_id) as Record<string, string> | undefined;
          if (invoice) {
            const paid = BigInt(invoice.paid_minor) + BigInt(String(args.amount));
            const status = paid >= BigInt(invoice.amount_minor) ? 'paid' : 'partially_paid';
            this.db.prepare('UPDATE invoices SET paid_minor=?,status=? WHERE id=?').run(paid.toString(), status, invoiceId);
            if (status === 'paid') enqueueWebhook(this.db, p.merchant_id, 'invoice.paid', invoiceId, context);
          }
        }
      }
      if (e.name === 'Refunded') {
        const refunded = BigInt(p.refunded_minor) + BigInt(String(args.amount));
        this.db.prepare('UPDATE payments SET status=?,refunded_minor=? WHERE id=?').run(refunded >= BigInt(p.captured_minor) ? 'refunded' : 'partially_refunded', refunded.toString(), objectId);
        const refund = this.db.prepare("SELECT id FROM refunds WHERE payment_id=? AND status='pending' AND amount_minor=? AND lower(tx_hash)=lower(?) ORDER BY created_at LIMIT 1").get(objectId, String(args.amount), e.txHash) as { id: string } | undefined;
        if (refund) this.db.prepare("UPDATE refunds SET status='succeeded',tx_hash=? WHERE id=?").run(e.txHash, refund.id);
        enqueueWebhook(this.db, p.merchant_id, 'payment.refunded', objectId, { ...context, amount_minor: String(args.amount) });
      }
      if (e.name === 'Voided' || e.name === 'Reclaimed') this.db.prepare("UPDATE payments SET status='voided',tx_hash=? WHERE id=?").run(e.txHash, objectId);
    }
    if (e.contract === 'receivables' && e.name === 'Paid') this.applyFinancedPayment(e, context);
    if (e.contract === 'escrow') orderEvent(this.db, objectId, e.id, e.name, paidContext);
    if (e.contract === 'subscription') {
      if (e.name === 'Replaced') {
        const old = this.db.prepare('SELECT * FROM subscriptions WHERE chain_id=?').get(String(args.oldId)) as Row | undefined;
        const replacement = this.db.prepare('SELECT * FROM subscriptions WHERE chain_id=?').get(String(args.newId)) as Row | undefined;
        if (old && replacement && old.merchant_id === replacement.merchant_id && same(old.payer, replacement.payer)) enqueueWebhook(this.db, old.merchant_id, 'subscription.replaced', old.id, { ...context, replacement_id: replacement.id });
        return;
      }
      const s = this.db.prepare('SELECT * FROM subscriptions WHERE chain_id=?').get(objectId) as Record<string, string> | undefined;
      if (!s) return;
      if (s.pending_tx_hash && !same(s.pending_tx_hash, e.txHash) && e.name !== 'Cancelled') return;
      recordAccounting(this.db, e);
      if (e.name === 'Subscribed') {
        this.db.prepare("UPDATE subscriptions SET status=CASE WHEN status='cancelled' THEN status WHEN trial_ends_at IS NOT NULL THEN 'trialing' ELSE 'active' END,pending_tx_hash=NULL WHERE id=?").run(s.id);
        enqueueWebhook(this.db, s.merchant_id, 'subscription.created', s.id, { ...context, status: s.status === 'cancelled' ? 'cancelled' : s.trial_ends_at ? 'trialing' : 'active', trialEndsAt: s.trial_ends_at ?? null });
      }
      if (e.name === 'Charged') {
        const plan = this.db.prepare('SELECT period_seconds,amount_minor FROM plans WHERE id=?').get(s.plan_id) as { period_seconds: number; amount_minor: string } | undefined;
        if (!e.timestamp || !Number.isFinite(Date.parse(e.timestamp))) throw new Error('Subscription event requires confirmed block time');
        this.db.prepare("UPDATE subscriptions SET status=CASE WHEN status='cancelled' THEN status ELSE 'active' END,retry_count=0,pending_tx_hash=NULL,next_charge_at=? WHERE id=?")
          .run(new Date(Date.parse(e.timestamp) + Number(plan?.period_seconds ?? 0) * 1000).toISOString(), s.id);
        this.db.prepare('DELETE FROM subscription_service_backoff WHERE subscription_id=?').run(s.id);
        enqueueWebhook(this.db, s.merchant_id, 'subscription.renewed', s.id, { ...context, ...discountView(plan?.amount_minor ?? null, plan ? (BigInt(plan.amount_minor) - BigInt(String(args.amount))).toString() : null, s.discount_code ?? null), amountChargedMinor: String(args.amount) });
      }
      if (e.name === 'Refused') {
        const code = Number(args.reason);
        const reason = ['cancelled','expired','too_early','cap_exceeded','max_periods','insufficient_funds','transfer_failed','fee_unavailable'][code] ?? String(args.reason);
        this.db.prepare('INSERT INTO refusal_attempts (id,merchant_id,object_id,reason,tx_hash,created_at,source) VALUES (?,?,?,?,?,?,?)').run(id('refusal'), s.merchant_id, s.id, reason, e.txHash, e.timestamp ?? now(), 'contract');
        this.db.prepare('UPDATE subscriptions SET pending_tx_hash=NULL WHERE id=?').run(s.id);
        enqueueWebhook(this.db, s.merchant_id, 'subscription.refused', s.id, { ...context, reason });
        if (s.status !== 'cancelled' && s.status !== 'paused') {
          if (code === 5) {
            if (!e.timestamp || !Number.isFinite(Date.parse(e.timestamp))) throw new Error('Subscription event requires confirmed block time');
            // The initial failure starts the grace window; only subsequent
            // confirmed failures consume its three daily retries.
            const retry = s.status === 'past_due' ? Number(s.retry_count) + 1 : 0;
            const next = new Date(Date.parse(e.timestamp) + 86_400_000).toISOString();
            this.db.prepare('UPDATE subscriptions SET status=?,retry_count=?,next_charge_at=? WHERE id=?')
              .run(retry >= 3 ? 'paused' : 'past_due', retry, next, s.id);
            enqueueWebhook(this.db, s.merchant_id, 'subscription.past_due', s.id, { ...context, retry, next_retry_at: retry >= 3 ? null : next });
          } else if (code === 2) {
            // A too-early call does not invalidate an active mandate. Back off
            // separately without shifting the confirmed billing schedule.
            this.db.prepare('INSERT INTO subscription_service_backoff VALUES (?,?) ON CONFLICT(subscription_id) DO UPDATE SET next_attempt_at=excluded.next_attempt_at')
              .run(s.id, new Date(Date.now() + 60_000).toISOString());
          } else {
            this.db.prepare('UPDATE subscriptions SET status=? WHERE id=?').run(code === 0 ? 'cancelled' : 'paused', s.id);
          }
        }
      }
      if (e.name === 'Cancelled') {
        this.db.prepare("UPDATE subscriptions SET status='cancelled',pending_tx_hash=CASE WHEN lower(pending_tx_hash)=lower(?) THEN NULL ELSE pending_tx_hash END WHERE id=?").run(e.txHash, s.id);
        enqueueWebhook(this.db, s.merchant_id, 'subscription.cancelled', s.id, context);
      }
    }
    if (e.contract === 'router' && (e.name === 'Refused' || e.name === 'Executed')) {
      // Bind to the actual submitted transaction as well as the signed identity.
      const intent = this.db.prepare('SELECT * FROM intents WHERE signer=? AND nonce=? AND lower(tx_hash)=lower(?)').get(String(args.signer).toLowerCase(), String(args.nonce), e.txHash) as Record<string, string> | undefined;
      if (intent) {
        const request = JSON.parse(intent.request_json) as IntentRequest;
        if (request.intent.merchant.toLowerCase() === String(args.merchant).toLowerCase()) {
          if (e.name === 'Refused') {
            const reason = ROUTER_REFUSALS[Number(args.reason)] ?? `router_refusal_${args.reason}`;
            this.db.prepare("UPDATE intents SET status='refused',reason=? WHERE id=?").run(reason, intent.id);
            let objectId = intent.id;
            const refund = this.db.prepare("SELECT id,payment_id FROM refunds WHERE lower(tx_hash)=lower(?) AND status='pending'").get(e.txHash) as { id: string; payment_id: string } | undefined;
            if (refund) {
              objectId = refund.payment_id;
              this.db.prepare("UPDATE refunds SET status='failed' WHERE id=?").run(refund.id);
            } else {
              try {
                const call = decodeFunctionData({ abi: escrowAbi, data: request.data });
                if (call.functionName === 'charge' || call.functionName === 'chargeInvoice') {
                  objectId = String(call.args![0]);
                  this.db.prepare("UPDATE payments SET status='failed',tx_hash=? WHERE id=? AND merchant_id=? AND status IN ('open','failed') AND captured_minor='0'").run(e.txHash, objectId, intent.merchant_id);
                }
              } catch {
                try {
                  const pay = decodeFunctionData({ abi: receivablesAbi, data: request.data });
                  if (pay.functionName === 'pay') {
                    objectId = String(pay.args![1]);
                    this.db.prepare("UPDATE payments SET status='failed',tx_hash=? WHERE id=? AND merchant_id=? AND status IN ('open','failed') AND captured_minor='0'").run(e.txHash, objectId, intent.merchant_id);
                  }
                } catch { /* A non-payment intent has no payment to update. */ }
              }
            }
            this.db.prepare('INSERT INTO refusal_attempts (id,merchant_id,object_id,reason,tx_hash,created_at,source,signer) VALUES (?,?,?,?,?,?,?,?)').run(id('refusal'), intent.merchant_id, objectId, reason, e.txHash, now(), 'contract', String(args.signer).toLowerCase());
            enqueueWebhook(this.db, intent.merchant_id, 'intent.refused', objectId, { ...context, reason, intent_id: intent.id });
          }
        }
      }
      // A refund or buy-back's gas, charged to the merchant in USDT.
      if (e.name === 'Executed') recordAccounting(this.db, e);
    }
  }
}
