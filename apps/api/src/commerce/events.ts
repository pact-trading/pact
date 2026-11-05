import type { Db } from '../db.js';
import { now } from '../db.js';
import { enqueueWebhook } from '../webhooks.js';
import { orderView, type OrderRow } from './orders.js';
/** Called inside the indexer's confirmed-event transaction; outbox and money
 * commit together. No frontend callback can invoke this transition. */
export function orderEvent(db: Db, paymentId: string, sourceId: string, event: string, context: Record<string, unknown>) {
  const row = db.prepare('SELECT * FROM commerce_orders WHERE payment_id=?').get(paymentId) as OrderRow | undefined;
  if (!row) return;
  const order = orderView(db, row);
  const type = event === 'Refunded' ? 'order.refunded' : ['Charged', 'Captured'].includes(event) && order.status === 'paid' ? 'order.paid' : null;
  if (!type) return;
  // A paid notification is unique for the order; refunds have distinct confirmed events.
  const key = type === 'order.paid' ? 'paid' : sourceId;
  if (db.prepare('INSERT OR IGNORE INTO commerce_order_events VALUES (?,?,?,?)').run(row.id, type, key, now()).changes) enqueueWebhook(db, row.merchant_id, type, row.id, { ...context, order });
}
