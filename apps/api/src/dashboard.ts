import type { Address } from 'viem';
import { amountString, type Db } from './db.js';
import type { ChainAdapter } from './types.js';
import { USDT } from './token.js';

export interface DashboardActivity {
  id: string;
  type: string;
  objectId: string;
  createdAt: string;
  txHash: string | null;
  reason: string | null;
}

export interface DashboardSummary {
  generatedAt: string;
  timeZone: 'UTC';
  accountingComplete: boolean;
  balance: { available: boolean; address: Address; token: Address; amountUsdt: string | null; blockNumber: string | null };
  today: { capturedUsdt: string; refundedUsdt: string; feesUsdt: string; payments: number; refunds: number; subscriptionCharges: number };
  metrics: {
    capturedUsdt: string;
    refundedUsdt: string;
    netUsdt: string;
    feesUsdt: string;
    totalPayments: number;
    successfulPayments: number;
    authorizedPayments: number;
    activeSubscriptions: number;
    financedInvoices: number;
  };
  volume: Array<{ date: string; amount: string }>;
  recentActivity: DashboardActivity[];
  /** Whether the merchant signed Pact's fee terms: until it does, Pact cannot take its payments. Null when unreadable. */
  feeTerms: { accepted: boolean | null; acceptedVersion: number | null; latestVersion: number | null };
}

interface PaymentRow { captured_minor: string; refunded_minor: string; status: string; created_at: string }
interface WebhookRow { id: string; type: string; object_id: string; payload: string; created_at: string }
interface RefusalRow { id: string; object_id: string; reason: string | null; tx_hash: string | null; created_at: string }

function utcDate(timestamp: string): string | null {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function payloadFields(payload: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(payload);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

const textField = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
const transactionReason = (tx: string, reason: string | null) => JSON.stringify([tx.toLowerCase(), reason]);
const refusalKey = (tx: string, reason: string | null, objectId: string) => JSON.stringify([tx.toLowerCase(), reason, objectId]);
const newestFirst = (a: Pick<DashboardActivity, 'id' | 'createdAt'>, b: Pick<DashboardActivity, 'id' | 'createdAt'>) =>
  (Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));

function recentActivity(db: Db, merchantId: string): DashboardActivity[] {
  const events = db.prepare('SELECT id,type,object_id,payload,created_at FROM webhook_events WHERE merchant_id=?').all(merchantId) as WebhookRow[];
  const attempts = db.prepare('SELECT id,object_id,reason,tx_hash,created_at FROM refusal_attempts WHERE merchant_id=?').all(merchantId) as RefusalRow[];
  const intents = db.prepare("SELECT id,id AS object_id,reason,tx_hash,created_at FROM intents WHERE merchant_id=? AND status='refused'").all(merchantId) as RefusalRow[];
  const activity: DashboardActivity[] = [];
  const webhookKeys = new Set<string>();
  const representedRefusals = new Set<string>();
  const representedTransactions = new Set<string>();
  const representedIntents = new Set<string>();

  // Prefer webhook records: they retain event type and the indexed payment/subscription ID.
  const webhooks = events.map(row => {
    const payload = payloadFields(row.payload);
    return {
      event: { id: row.id, type: row.type, objectId: row.object_id, createdAt: row.created_at, txHash: textField(payload.tx_hash), reason: textField(payload.reason) },
      eventId: textField(payload.id), intentId: textField(payload.intent_id),
    };
  }).sort((a, b) => newestFirst(a.event, b.event));
  for (const { event, eventId, intentId } of webhooks) {
    const key = event.txHash
      ? JSON.stringify([event.type, event.objectId, event.txHash.toLowerCase(), event.reason, intentId])
      : JSON.stringify(['event', eventId ?? event.id]);
    const isRefusal = event.type.endsWith('.refused') || event.type === 'transaction.failed' || event.type === 'transaction.reconciliation_required';
    const duplicateIntent = isRefusal && intentId !== null && representedIntents.has(intentId);
    if (isRefusal) {
      if (intentId) representedIntents.add(intentId);
      if (event.type === 'intent.refused') representedIntents.add(event.objectId);
      if (event.txHash) {
        representedRefusals.add(refusalKey(event.txHash, event.reason, event.objectId));
        if (intentId) representedRefusals.add(refusalKey(event.txHash, event.reason, intentId));
        representedTransactions.add(transactionReason(event.txHash, event.reason));
      }
    }
    if (webhookKeys.has(key) || duplicateIntent) continue;
    webhookKeys.add(key);
    activity.push(event);
  }

  const refusals: DashboardActivity[] = attempts.map(row => ({ id: row.id, type: 'refusal', objectId: row.object_id, createdAt: row.created_at, txHash: row.tx_hash, reason: row.reason }));
  for (const event of refusals.sort(newestFirst)) {
    const key = event.txHash ? refusalKey(event.txHash, event.reason, event.objectId) : null;
    if (key && representedRefusals.has(key)) continue;
    if (key && event.txHash) {
      representedRefusals.add(key);
      representedTransactions.add(transactionReason(event.txHash, event.reason));
    }
    // Without an onchain transaction identity, separate attempts must remain separate.
    activity.push(event);
  }
  for (const row of intents) {
    // API submissions contain one Router intent per transaction. The indexed refusal may
    // use a payment ID instead of the intent ID, so match its tx/reason as a fallback.
    if (representedIntents.has(row.id) || (row.tx_hash && representedTransactions.has(transactionReason(row.tx_hash, row.reason)))) continue;
    activity.push({ id: row.id, type: 'intent.refused', objectId: row.id, createdAt: row.created_at, txHash: row.tx_hash, reason: row.reason });
  }
  return activity.sort(newestFirst).slice(0, 10);
}

/** Confirmed accounting totals with independent current wallet and fee-terms RPC reads. */
export async function getDashboardSummary(
  db: Db,
  chain: Pick<ChainAdapter, 'merchantFees' | 'merchantBalance'>,
  merchant: { merchantId: string; address: Address },
  clock: () => Date = () => new Date(),
): Promise<DashboardSummary> {
  const generatedAt = clock().toISOString();
  const today = generatedAt.slice(0, 10);
  const midnight = Date.parse(`${today}T00:00:00.000Z`);
  // A synchronous read transaction keeps all DB-derived fields on one SQLite snapshot.
  const snapshot = db.transaction(() => {
    const dates = new Map(Array.from({ length: 14 }, (_, index) => [new Date(midnight - (13 - index) * 86_400_000).toISOString().slice(0, 10), 0n]));
    let captured = 0n, refunded = 0n, fees = 0n;
    let totalPayments = 0, successfulPayments = 0, authorizedPayments = 0;
    // SQLite SUM would coerce text amounts through bounded integers/floating point.
    const payments = db.prepare('SELECT captured_minor,refunded_minor,status,created_at FROM payments WHERE merchant_id=?').iterate(merchant.merchantId) as Iterable<PaymentRow>;
    for (const row of payments) {
      const amount = BigInt(row.captured_minor);
      totalPayments++;
      if (amount > 0n) successfulPayments++;
      if (row.status === 'authorized') authorizedPayments++;
    }
    let todayCaptured = 0n, todayRefunded = 0n, todayFees = 0n, refundCount = 0, subscriptionCharges = 0;
    const capturedPayments = new Set<string>();
    const entries = db.prepare('SELECT kind,object_id,amount_minor,fee_minor,occurred_at FROM accounting_entries WHERE merchant_id=?').iterate(merchant.merchantId) as Iterable<{ kind: string; object_id: string; amount_minor: string; fee_minor: string; occurred_at: string }>;
    for (const entry of entries) {
      const day = utcDate(entry.occurred_at), amount = BigInt(entry.amount_minor);
      if (['Payment', 'Subscription'].includes(entry.kind)) {
        captured += amount;
        if (day !== null && dates.has(day)) dates.set(day, dates.get(day)! + amount);
        if (day === today) { todayCaptured += amount; if (entry.kind === 'Payment') capturedPayments.add(entry.object_id); else subscriptionCharges++; }
      }
      if (entry.kind === 'Refund') refunded -= amount;
      // Pact's fees: taken out of payments and renewals, and a refund's network fee.
      fees += BigInt(entry.fee_minor);
      if (day === today && entry.kind === 'Refund') { todayRefunded -= amount; refundCount++; }
      if (day === today) todayFees += BigInt(entry.fee_minor);
    }
    const { count: financedInvoices } = db.prepare("SELECT COUNT(*) AS count FROM invoices WHERE merchant_id=? AND (status='financed' OR financing_status='financed')").get(merchant.merchantId) as { count: number };
    const accountingComplete = (db.prepare('SELECT coverage_complete FROM accounting_state WHERE id=1').get() as { coverage_complete: number }).coverage_complete === 1;
    const { count: activeSubscriptions } = db.prepare("SELECT COUNT(*) AS count FROM subscriptions WHERE merchant_id=? AND status='active'").get(merchant.merchantId) as { count: number };
    return {
      metrics: { capturedUsdt: amountString(captured), refundedUsdt: amountString(refunded), netUsdt: amountString(captured - refunded - fees), feesUsdt: amountString(fees), totalPayments, successfulPayments, authorizedPayments, activeSubscriptions, financedInvoices },
      volume: Array.from(dates, ([date, amount]) => ({ date, amount: amountString(amount) })),
      recentActivity: recentActivity(db, merchant.merchantId),
      accountingComplete,
      today: { capturedUsdt: amountString(todayCaptured), refundedUsdt: amountString(todayRefunded), feesUsdt: amountString(todayFees), payments: capturedPayments.size, refunds: refundCount, subscriptionCharges },
    };
  })();

  let feeTerms: DashboardSummary['feeTerms'] = { accepted: null, acceptedVersion: null, latestVersion: null };
  let balance: DashboardSummary['balance'] = { available: false, address: merchant.address, token: USDT, amountUsdt: null, blockNumber: null };
  // Independent deadlines preserve whichever RPC read succeeds. Late rejection
  // stays observed; neither an RPC failure nor sales totals imply a zero balance.
  async function bounded<T>(read: () => Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([Promise.resolve().then(read), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Dashboard read timed out')), 2500); })]); }
    finally { if (timer !== undefined) clearTimeout(timer); }
  }
  const [termsRead, balanceRead] = await Promise.allSettled([bounded(() => chain.merchantFees(merchant.address)), bounded(() => chain.merchantBalance(merchant.address))]);
  if (termsRead.status === 'fulfilled') feeTerms = { accepted: termsRead.value.acceptedVersion !== 0, acceptedVersion: termsRead.value.acceptedVersion, latestVersion: termsRead.value.latestVersion };
  if (balanceRead.status === 'fulfilled') {
    const current = balanceRead.value;
    if (current.token.toLowerCase() === USDT.toLowerCase() && current.balanceMinor >= 0n) balance = { available: true, address: merchant.address, token: current.token, amountUsdt: amountString(current.balanceMinor), blockNumber: current.blockNumber.toString() };
  }
  return { generatedAt, timeZone: 'UTC', accountingComplete: snapshot.accountingComplete, today: snapshot.today, balance, metrics: snapshot.metrics, volume: snapshot.volume, recentActivity: snapshot.recentActivity, feeTerms };
}
