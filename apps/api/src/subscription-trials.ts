import type { Db } from './db.js';

/** A trial is consumed once registered, including when it is later cancelled. */
export function availableTrialDays(db: Db, planId: string, merchantId: string, payer: string, days: number, customerSubjectId?: string) {
  if (!days) return 0;
  // Wallet callers have the same rule; linked Pact identities also share trial history.
  const used = db.prepare(`SELECT 1 FROM subscriptions s
    WHERE s.plan_id=? AND s.trial_ends_at IS NOT NULL AND s.status!='failed'
    AND (lower(s.payer)=lower(?) OR s.trial_customer_subject_id=COALESCE(?, (
      SELECT subject_id FROM commerce_customers WHERE merchant_id=? AND lower(wallet)=lower(?) LIMIT 1
    ))) LIMIT 1`).get(planId, payer, customerSubjectId ?? null, merchantId, payer);
  return used ? 0 : days;
}
