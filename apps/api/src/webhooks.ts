import { createHmac, randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { id, now } from './db.js';
import { enqueueNotifications } from './notifications.js';
import { Refusal } from './types.js';

export function enqueueWebhook(db: Db, merchantId: string, type: string, objectId: string, context: Record<string, unknown> = {}) {
  const eventId = id('evt');
  const payload = JSON.stringify({ id: eventId, api_version: '2026-11-06', type, object_id: objectId, occurred_at: now(), idempotency_key: eventId, ...context });
  db.prepare('INSERT INTO webhook_events VALUES (?,?,?,?,?,?)').run(eventId, merchantId, type, objectId, payload, now());
  const merchant = db.prepare('SELECT webhook_url FROM merchants WHERE id=?').get(merchantId) as { webhook_url: string | null } | undefined;
  if (merchant?.webhook_url) db.prepare('INSERT INTO webhook_deliveries VALUES (?,?,?,?,?,?,?,?,?)').run(id('del'), eventId, merchantId, 0, 'pending', now(), null, null, null);
  enqueueNotifications(db, eventId, merchantId, type, objectId, context);
  return eventId;
}
export function replayWebhook(db: Db, merchantId: string, eventId: string) {
  const event = db.prepare('SELECT id FROM webhook_events WHERE id=? AND merchant_id=?').get(eventId, merchantId);
  if (!event) return false;
  const merchant = db.prepare('SELECT webhook_url,webhook_secret FROM merchants WHERE id=?').get(merchantId) as { webhook_url: string | null; webhook_secret: string | null };
  if (!merchant.webhook_url || !merchant.webhook_secret) throw new Refusal('webhook_not_configured');
  db.prepare(`INSERT INTO webhook_deliveries(id,event_id,merchant_id,attempt,status,next_at) VALUES (?,?,?,0,'pending',?)
    ON CONFLICT(event_id,merchant_id) DO UPDATE SET status='pending',next_at=excluded.next_at,attempt=0,delivered_at=NULL,last_http_status=NULL,last_error=NULL`)
    .run(id('del'), eventId, merchantId, now());
  return true;
}
export function signWebhook(body: string, secret: string) { return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`; }
export async function deliverWebhooks(db: Db, fetcher: typeof fetch = fetch, at = new Date()) {
  const rows = db.prepare(`SELECT d.*, e.payload, m.webhook_url, m.webhook_secret FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id JOIN merchants m ON m.id=d.merchant_id WHERE d.status='pending' AND d.next_at<=? ORDER BY d.next_at LIMIT 50`).all(at.toISOString()) as Array<Record<string, unknown>>;
  // The query caps concurrent sends at 50. A failing destination must not hold
  // every other merchant behind its five-second network timeout.
  const results = await Promise.allSettled(rows.map(async row => {
    if (!row.webhook_url || !row.webhook_secret) {
      db.prepare("UPDATE webhook_deliveries SET status='failed',last_error='webhook_not_configured' WHERE id=?").run(row.id);
      return;
    }
    const attempt = Number(row.attempt) + 1;
    const body = JSON.stringify({ ...JSON.parse(String(row.payload)), attempt });
    let status: number | null = null, error: string | null = null;
    try {
      const response = await fetcher(String(row.webhook_url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-settle-signature': signWebhook(body, String(row.webhook_secret)), 'x-settle-event-id': String(row.event_id), 'x-settle-attempt': String(attempt), 'idempotency-key': String(row.event_id) }, body, signal: AbortSignal.timeout(5000) });
      status = response.status;
      if (!response.ok) error = `HTTP ${status}`;
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    db.prepare('INSERT INTO webhook_attempts VALUES (?,?,?,?,?,?)').run(randomUUID(), row.id, attempt, status, error, now());
    if (!error) db.prepare("UPDATE webhook_deliveries SET attempt=?,status='delivered',last_http_status=?,last_error=NULL,delivered_at=? WHERE id=?").run(attempt, status, now(), row.id);
    else db.prepare("UPDATE webhook_deliveries SET attempt=?,status=?,last_http_status=?,last_error=?,next_at=? WHERE id=?").run(attempt, attempt >= 8 ? 'failed' : 'pending', status, error, new Date(at.getTime() + Math.min(3_600_000, 1000 * 2 ** (attempt - 1))).toISOString(), row.id);
  }));
  const failures = results.filter(result => result.status === 'rejected');
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Webhook persistence failed');
  return rows.length;
}
