import { KeeperRenewals, type Renewals } from './subscriptions-live.js';
import { Refusal, type ChainAdapter } from './types.js';
import type { Db } from './db.js';
import { now } from './db.js';
import { enqueueWebhook } from './webhooks.js';
import { sendDueReminders } from './invoices-live.js';

/** Renewals sent per keeper transaction when the manager supports `chargeBatch`. */
export const RENEWAL_BATCH = 10;
export async function runKeeper(db: Db, chain: ChainAdapter, at = new Date(), renewals: Pick<Renewals, 'chain' | 'renew'> & { renewMany?: (ids: string[]) => Promise<string[]> } = new KeeperRenewals(db, chain)) {
  if (renewals.chain !== chain) throw new Error('Keeper must share its ChainAdapter/AccountWriter');
  const invoices = db.prepare("SELECT * FROM invoices WHERE status IN ('sent','acknowledged','partially_paid','overdue')").all() as Array<Record<string, string>>;
  for (const invoice of invoices) {
    if (!invoice.due_at || BigInt(invoice.paid_minor) >= BigInt(invoice.amount_minor)) continue;
    const remainingDays = Math.ceil((new Date(invoice.due_at).getTime() - at.getTime()) / 86_400_000);
    const stage = remainingDays <= 0 ? 'overdue' : remainingDays <= 1 ? 'one_day' : remainingDays <= 7 ? 'seven_days' : null;
    if (!stage) continue;
    if (stage === 'overdue' && invoice.status !== 'overdue') { db.prepare("UPDATE invoices SET status='overdue' WHERE id=?").run(invoice.id); enqueueWebhook(db, invoice.merchant_id, 'invoice.overdue', invoice.id); }
    const inserted = db.prepare('INSERT OR IGNORE INTO reminders VALUES (?,?,?)').run(invoice.id, stage, now());
    if (inserted.changes) enqueueWebhook(db, invoice.merchant_id, 'invoice.reminder_due', invoice.id, { stage });
  }
  // Written reminders a merchant scheduled for later (live mode).
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='invoice_manual_reminders'").get()) sendDueReminders(db, at);
  const trials = db.prepare("SELECT id,merchant_id,trial_ends_at FROM subscriptions WHERE status='trialing' AND trial_ends_at>? AND trial_ends_at<=?").all(at.toISOString(), new Date(at.getTime() + 3 * 86_400_000).toISOString()) as Array<{ id: string; merchant_id: string; trial_ends_at: string }>;
  for (const trial of trials) db.transaction(() => {
    const inserted = db.prepare('INSERT OR IGNORE INTO reminders VALUES (?,?,?)').run(trial.id, 'trial_will_end', now());
    if (inserted.changes) enqueueWebhook(db, trial.merchant_id, 'subscription.trial_will_end', trial.id, { status: 'trialing', trialEndsAt: trial.trial_ends_at });
  })();
  const subs = db.prepare(`SELECT s.*,p.amount_minor,p.period_seconds FROM subscriptions s JOIN plans p ON p.id=s.plan_id
    LEFT JOIN subscription_service_backoff b ON b.subscription_id=s.id
    WHERE s.status IN ('trialing','active','past_due') AND s.pending_tx_hash IS NULL AND s.next_charge_at<=?
    AND (b.next_attempt_at IS NULL OR b.next_attempt_at<=?)`).all(at.toISOString(), at.toISOString()) as Array<Record<string, string>>;
  // Batch what can be batched; anything a batch did not take (or every renewal, without chargeBatch) goes alone.
  const batched = new Set<string>();
  if (renewals.renewMany && chain.renewBatch) {
    const due = subs.filter(sub => sub.chain_id).map(sub => sub.id);
    for (let i = 0; i < due.length; i += RENEWAL_BATCH) {
      try { for (const id of await renewals.renewMany(due.slice(i, i + RENEWAL_BATCH))) batched.add(id); }
      catch { /* fall back to single renewals below */ }
    }
  }
  for (const sub of subs) {
    if (!sub.chain_id || batched.has(sub.id)) continue;
    try { await renewals.renew(sub.id); }
    catch (error) {
      // A shared-account hold is neither a declined renewal nor a payer retry.
      if (error instanceof Refusal && ['relayer_pending', 'relayer_stuck', 'subscription_pending'].includes(error.code)) continue;
      // Transport/preparation errors do not prove that the payer declined. Only
      // confirmed chain events change the billing retry count and status.
      const current = db.prepare('SELECT status FROM subscriptions WHERE id=?').get(sub.id) as { status: string } | undefined;
      if (!current || !['trialing', 'active', 'past_due'].includes(current.status)) continue;
      db.prepare(`INSERT INTO subscription_service_backoff VALUES (?,?)
        ON CONFLICT(subscription_id) DO UPDATE SET next_attempt_at=excluded.next_attempt_at`)
        .run(sub.id, new Date(at.getTime() + 60_000).toISOString());
    }
  }
}
