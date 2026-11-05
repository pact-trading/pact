import type { SubscriptionDetail } from '@pactagent/core/platform-types';

/**
 * When a cancelled subscription ends: the end of the period already paid for, or the
 * cancellation itself. Null while it is live, or when a new plan replaced it.
 * Cancelling revokes the mandate at once, so nothing is charged after `cancelledAt`.
 */
export function subscriptionEndsAt(
  sub: Pick<SubscriptionDetail, 'status' | 'cancelledAt' | 'nextChargeAt' | 'replacedBy'> & Partial<Pick<SubscriptionDetail, 'periodsCharged'>>,
): string | null {
  if (sub.status !== 'cancelled' || !sub.cancelledAt || sub.replacedBy) return null;
  if (sub.periodsCharged === 0) return sub.cancelledAt;
  return sub.nextChargeAt > sub.cancelledAt ? sub.nextChargeAt : sub.cancelledAt;
}
