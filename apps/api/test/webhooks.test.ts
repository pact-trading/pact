import { describe, expect, it, vi } from 'vitest';
import { openDb, seedMerchant } from '../src/db.js';
import { deliverWebhooks, enqueueWebhook, replayWebhook, signWebhook } from '../src/webhooks.js';

describe('webhook replay and configuration', () => {
  it('creates a missing delivery when a merchant configures its webhook after the event', async () => {
    const db = openDb();
    const merchant = seedMerchant(db, '0x0000000000000000000000000000000000000001');
    const eventId = enqueueWebhook(db, merchant.merchantId, 'invoice.paid', 'inv_1');
    expect(db.prepare('SELECT * FROM webhook_deliveries').all()).toHaveLength(0);
    db.prepare('UPDATE merchants SET webhook_url=?,webhook_secret=? WHERE id=?').run('https://example.test/events', 'whsec_later', merchant.merchantId);
    expect(replayWebhook(db, merchant.merchantId, eventId)).toBe(true);
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = init!.headers as Record<string, string>;
      expect(headers['idempotency-key']).toBe(eventId);
      expect(headers['x-settle-signature']).toBe(signWebhook(String(init!.body), 'whsec_later'));
      return new Response(null, { status: 204 });
    });
    expect(await deliverWebhooks(db, fetcher as typeof fetch)).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(replayWebhook(db, merchant.merchantId, eventId)).toBe(true);
    expect(db.prepare('SELECT * FROM webhook_deliveries').all()).toHaveLength(1);
    expect(replayWebhook(db, 'other_merchant', eventId)).toBe(false);
  });

  it('does not claim a replay was queued without a signing secret and destination', () => {
    const db = openDb();
    const merchant = seedMerchant(db, '0x0000000000000000000000000000000000000001');
    const event = enqueueWebhook(db, merchant.merchantId, 'payment.captured', 'pay_1');
    expect(() => replayWebhook(db, merchant.merchantId, event)).toThrow('webhook_not_configured');
  });

  it('never sends a delivery signed with a missing secret', async () => {
    const db = openDb();
    const merchant = seedMerchant(db, '0x0000000000000000000000000000000000000001', { webhookUrl: 'https://example.test/events' });
    enqueueWebhook(db, merchant.merchantId, 'payment.captured', 'pay_1');
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    await deliverWebhooks(db, fetcher as typeof fetch);
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status,last_error FROM webhook_deliveries').get()).toEqual({ status: 'failed', last_error: 'webhook_not_configured' });
  });
});
