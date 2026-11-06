import type { Address, Hex } from 'viem';
import type { WriteOperation } from './account-writer.js';
import { amountString, id, type Db } from './db.js';
import { chargedPeriods, discountTerms, discountView, renewalDiscountAmount } from './discounts.js';
import { initRenewalStatus, setRenewalStatus, type RenewalStatus } from './renewal-status.js';
import { readSubscriptionMandate } from './subscription-mandates.js';
import type { ChainAdapter } from './types.js';
import { Refusal } from './types.js';
import { assertSubscriptionAvailable } from './write-reservations.js';

/** Renewals sent by the keeper key, which the SubscriptionManager allows to call `charge` directly. */
export interface Renewals {
  readonly chain: ChainAdapter;
  readonly store: { db: Db };
  status(subscriptionId: string): RenewalStatus;
  renew(subscriptionId: string, options?: { force?: boolean }): Promise<RenewalStatus>;
}

/**
 * The keeper pulls each renewal itself. The contract still checks every rule (cap, period, cancelled,
 * expired, funds, the merchant's fee terms) and records a refusal with its reason. `force` sends a
 * merchant's "Run renewal now" to the contract even when it is early or cancelled, so the refusal is
 * on chain, not just in our API. Pact's relayer pays the gas; the renewal's fee, taken out of the
 * payment, covers it.
 */
export class KeeperRenewals implements Renewals {
  readonly store: { db: Db };
  constructor(private readonly db: Db, readonly chain: ChainAdapter) { initRenewalStatus(db); this.store = { db }; }
  status(subscriptionId: string): RenewalStatus {
    const row = this.db.prepare('SELECT state,reason,operation_id FROM renewal_service_status WHERE subscription_id=?').get(subscriptionId) as { state: string; reason: string; operation_id: string | null } | undefined;
    return row ? { state: row.state, reason: row.reason, ...(row.operation_id ? { operationId: row.operation_id } : {}) } : { state: 'idle', reason: '' };
  }
  async renew(subscriptionId: string, options: { force?: boolean } = {}): Promise<RenewalStatus> {
    const sub = this.db.prepare('SELECT s.chain_id,s.status,s.cancelled_by,s.trial_ends_at,p.amount_minor FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.id=?').get(subscriptionId) as { chain_id: Hex | null; status: string; cancelled_by: string | null; trial_ends_at: string | null; amount_minor: string } | undefined;
    if (!sub?.chain_id) throw new Refusal('subscription_not_found');
    if (sub.cancelled_by === 'merchant') throw new Refusal('cancelled');
    // Trial timing is an off-chain promise: even forced calls must respect it.
    if (sub.trial_ends_at && Date.parse(sub.trial_ends_at) > Date.now()) throw new Refusal('too_early', 'The free trial has not ended');
    const operation: WriteOperation = { id: id('renew'), kind: 'renew', objectId: subscriptionId, links: { subscriptionId } };
    this.chain.writer.reserve(operation, () => {
      if (!options.force) assertSubscriptionAvailable(this.db, subscriptionId);
      else if (this.db.prepare("SELECT 1 FROM subscriptions WHERE id=? AND pending_tx_hash IS NOT NULL").get(subscriptionId) || this.db.prepare("SELECT 1 FROM relayer_operations WHERE object_id=? AND kind IN ('renew','subscribe','cancel','replace','intent') AND phase IN ('preparing','signed','broadcasting','submitted','uncertain')").get(subscriptionId)) throw new Refusal('subscription_pending');
      operation.links!.previousSubscriptionStatus = sub.status;
    });
    setRenewalStatus(this.db, subscriptionId, 'pending', 'submitted', operation.id);
    const txHash = await this.chain.renew(sub.chain_id, renewalDiscountAmount(this.db, subscriptionId, chargedPeriods(this.db, sub.chain_id) + 1), operation);
    return { state: 'submitted', reason: '', operationId: operation.id, txHash };
  }
}

type PlanRow = { trial_days: number; id: string; merchant_id: string; name: string; amount_minor: string; period_seconds: number; max_periods: number | null; created_at: string; description: string | null; status: string | null; archived_at: string | null };
const MONTH = 30 * 86_400;

export function initLivePlans(db: Db) {
  const cols = (db.pragma('table_info(plans)') as Array<{ name: string }>).map(c => c.name);
  if (!cols.includes('description')) db.exec("ALTER TABLE plans ADD COLUMN description TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('status')) db.exec("ALTER TABLE plans ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  if (!cols.includes('archived_at')) db.exec('ALTER TABLE plans ADD COLUMN archived_at TEXT');
}

export function planSummary(db: Db, p: PlanRow) {
  const active = (db.prepare("SELECT count(*) n FROM subscriptions WHERE plan_id=? AND status IN ('active','past_due')").get(p.id) as { n: number }).n;
  // Monthly recurring revenue, normalized from any period length.
  const monthly = (BigInt(p.amount_minor) * BigInt(active) * BigInt(MONTH)) / BigInt(Math.max(1, Number(p.period_seconds)));
  return {
    trialDays: Number(p.trial_days ?? 0), id: p.id, name: p.name, description: p.description ?? '', amount: amountString(p.amount_minor), amountMinor: p.amount_minor,
    periodSeconds: Number(p.period_seconds), maxPeriods: p.max_periods === null ? null : Number(p.max_periods),
    activeSubscribers: active, monthlyRecurringMinor: monthly.toString(),
    status: (p.status ?? 'active') as 'active' | 'archived', archivedAt: p.archived_at, createdAt: p.created_at,
  };
}
export const planRows = (db: Db, merchantId: string) => db.prepare('SELECT * FROM plans WHERE merchant_id=? ORDER BY created_at DESC').all(merchantId) as PlanRow[];
export const planRow = (db: Db, planId: string, merchantId?: string) =>
  db.prepare(`SELECT * FROM plans WHERE id=?${merchantId ? ' AND merchant_id=?' : ''}`).get(...(merchantId ? [planId, merchantId] : [planId])) as PlanRow | undefined;

type SubRow = { trial_ends_at: string | null; id: string; merchant_id: string; plan_id: string; chain_id: Hex | null; payer: Address | null; status: string; next_charge_at: string; retry_count: number; created_at: string; cancelled_at: string | null };

/** Charges and refusals of one subscription, newest first, with the signed mandate's terms. */
export function subscriptionDetail(db: Db, s: SubRow) {
  const plan = planRow(db, s.plan_id)!;
  const customer = db.prepare('SELECT id,name,email FROM commerce_customers WHERE merchant_id=? AND lower(wallet)=lower(?) ORDER BY created_at LIMIT 1').get(s.merchant_id, s.payer ?? '') as { id: string; name: string | null; email: string | null } | undefined;
  const merchantName = (db.prepare('SELECT brand_name FROM merchant_settings WHERE merchant_id=?').get(s.merchant_id) as { brand_name: string } | undefined)?.brand_name || 'This business';
  const charged = (s.chain_id ? db.prepare("SELECT event_id,amount_minor,tx_hash,occurred_at FROM accounting_entries WHERE merchant_id=? AND lower(object_id)=lower(?) AND kind='Subscription' ORDER BY occurred_at").all(s.merchant_id, s.chain_id) : []) as Array<{ event_id: string; amount_minor: string; tx_hash: Hex; occurred_at: string }>;
  const refused = db.prepare('SELECT id,reason,tx_hash,created_at FROM refusal_attempts WHERE merchant_id=? AND object_id=? ORDER BY created_at').all(s.merchant_id, s.id) as Array<{ id: string; reason: string; tx_hash: Hex | null; created_at: string }>;
  const charges = [
    ...charged.map((c, i) => ({ id: c.event_id, period: i + 1, amount: amountString(c.amount_minor), status: 'charged' as const, reason: null, txHash: c.tx_hash, at: c.occurred_at })),
    ...refused.map(r => ({ id: r.id, period: charged.filter(c => c.occurred_at <= r.created_at).length + 1, amount: amountString(plan.amount_minor), status: 'refused' as const, reason: r.reason, txHash: r.tx_hash, at: r.created_at })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const mandate = readSubscriptionMandate(db, s.id);
  const cancelledAt = s.status === 'cancelled'
    ? s.cancelled_at ?? (db.prepare("SELECT created_at FROM webhook_events WHERE merchant_id=? AND object_id=? AND type='subscription.cancelled' ORDER BY created_at DESC LIMIT 1").get(s.merchant_id, s.id) as { created_at: string } | undefined)?.created_at ?? null
    : null;
  const replacedBy = (db.prepare('SELECT new_id FROM subscription_replacements WHERE old_id=? LIMIT 1').get(s.id) as { new_id: string } | undefined)?.new_id ?? null;
  return {
    id: s.id, chainId: s.chain_id, payer: s.payer, planId: s.plan_id, plan: plan.name, amount: amountString(plan.amount_minor),
    periodSeconds: Number(plan.period_seconds), maxPeriods: plan.max_periods === null ? null : Number(plan.max_periods),
    status: s.status, trialEndsAt: s.trial_ends_at ?? null, nextChargeAt: s.next_charge_at, createdAt: s.created_at,
    customerId: customer?.id ?? '', customerName: customer?.name ?? null, customerEmail: customer?.email ?? null, merchantName,
    periodsCharged: charged.length, retryCount: Number(s.retry_count ?? 0), cancelledAt, replacedBy,
    ...discountView((s as SubRow & { amount_gross_minor?: string }).amount_gross_minor ?? null, (s as SubRow & { amount_discount_minor?: string }).amount_discount_minor ?? null, (s as SubRow & { discount_code?: string }).discount_code ?? null),
    discount: discountTerms((s as SubRow & { discount_duration?: string }).discount_duration, (s as SubRow & { discount_periods?: string }).discount_periods, charged.length),
    mandate: {
      amountCap: amountString(mandate?.mandate.amountCap ?? plan.amount_minor),
      periodSeconds: Number(mandate?.mandate.periodSeconds ?? plan.period_seconds),
      maxPeriods: mandate ? Number(mandate.mandate.maxPeriods) : plan.max_periods,
      signedAt: s.created_at,
    },
    charges,
  };
}
export const subscriptionRows = (db: Db, where: string, ...args: unknown[]) =>
  db.prepare(`SELECT * FROM subscriptions WHERE ${where} ORDER BY created_at DESC LIMIT 200`).all(...args) as SubRow[];
