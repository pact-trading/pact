import { verifyWebhook } from '@pactagent/core/webhooks';
/** The caller supplies SQLite; no key/secret is sent to the storefront browser. */
interface StoreDb { exec(sql: string): unknown; prepare(sql: string): { run(...values: string[]): unknown; get(...values: string[]): unknown; all(...values: string[]): unknown[] } }
export function initFulfillment(db: StoreDb) {
  db.exec(`CREATE TABLE IF NOT EXISTS received_events(id TEXT PRIMARY KEY,order_id TEXT NOT NULL,received_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fulfillment(order_id TEXT PRIMARY KEY,event_id TEXT NOT NULL,product_id TEXT NOT NULL,amount_minor TEXT NOT NULL,currency TEXT NOT NULL,delivered_at TEXT NOT NULL);`);
}
export async function fulfill(db: StoreDb, raw: string, signature: string, eventId: string, secret: string, productId: string, embedded?: { item: string; amountMinor: string }) {
  if (!await verifyWebhook(raw, signature, secret)) return { status: 401, result: 'invalid_signature' };
  let value; try { value = JSON.parse(raw); } catch { return { status: 400, result: 'invalid_json' }; }
  if (!value || typeof value !== 'object' || typeof value.id !== 'string' || value.id !== eventId) return { status: 400, result: 'invalid_event' };
  if (value.type === 'payment.captured' && embedded && value.metadata?.store_item === embedded.item) {
    // store_item and the price are set by this store's own proxy route, not by the browser.
    if (typeof value.object_id !== 'string' || String(value.amount_minor) !== embedded.amountMinor) return { status: 400, result: 'invalid_payment' };
    return record(db, value.id, value.object_id, embedded.item, embedded.amountMinor, 'USDT');
  }
  if (value.type !== 'order.paid' || !productId) return { status: 200, result: 'ignored' };
  const order = value.order;
  if (!order || typeof order.id !== 'string' || order.id !== value.object_id || order.productId !== productId || order.status !== 'paid' || order.rail !== 'whitechain' || order.total?.currency !== 'USDT' || !/^[1-9]\d*$/.test(order.total?.amountMinor ?? '')) return { status: 400, result: 'invalid_order' };
  return record(db, value.id, order.id, order.productId, order.total.amountMinor, order.total.currency);
}

function record(db: StoreDb, eventId: string, orderId: string, productId: string, amountMinor: string, currency: string) {
  // Event dedup and fulfillment are one durable transaction. Unique order ID
  // also protects against a second valid event ID for the same paid order.
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT id FROM received_events WHERE id=?').get(eventId)) { db.exec('COMMIT'); return { status: 200, result: 'duplicate' }; }
    const at = new Date().toISOString();
    db.prepare('INSERT INTO received_events VALUES (?,?,?)').run(eventId, orderId, at);
    db.prepare('INSERT OR IGNORE INTO fulfillment VALUES (?,?,?,?,?,?)').run(orderId, eventId, productId, amountMinor, currency, at);
    db.exec('COMMIT'); return { status: 200, result: 'recorded' };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}
