export const MERCHANT_NOTIFICATION_EVENTS = ['order.paid', 'payment.refunded', 'subscription.past_due', 'subscription.cancelled', 'invoice.paid'];
export const CUSTOMER_NOTIFICATION_EVENTS = ['order.paid', 'payment.refunded', 'subscription.renewed', 'subscription.trial_will_end', 'subscription.past_due'];
export const NOTIFICATION_LABELS: Record<string, { merchant: string; customer: string }> = {
  'order.paid': { merchant: 'A customer paid', customer: 'Receipts for what you buy' },
  'payment.refunded': { merchant: 'A refund confirmed', customer: 'Refunds' },
  'subscription.renewed': { merchant: 'A subscription renewed', customer: 'Subscription renewals' },
  'subscription.trial_will_end': { merchant: 'A trial is ending', customer: 'A free trial is about to end' },
  'subscription.past_due': { merchant: 'A renewal failed', customer: 'A renewal failed' },
  'subscription.cancelled': { merchant: 'A subscription was cancelled', customer: 'A subscription was cancelled' },
  'invoice.paid': { merchant: 'An invoice was paid in full', customer: 'An invoice was paid' },
};
