import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { fulfill, initFulfillment } from '../../../examples/merchant-store/fulfillment.ts';
import { openDb, seedMerchant } from '../src/db.js';
import { deliverWebhooks, enqueueWebhook, replayWebhook, signWebhook } from '../src/webhooks.js';
const secret = 'whsec_local_fixture', productId = 'prod_saved';
const event = (id = 'evt_1') => JSON.stringify({ id, type: 'order.paid', object_id: 'ord_1', order: { id: 'ord_1', productId, status: 'paid', rail: 'whitechain', total: { currency: 'USDT', amountMinor: '2000000' } } });
describe('independent store raw webhook fulfillment', () => {
  it('rejects invalid signatures/payloads and records a paid order once across duplicate event IDs', async () => {
    const db = new Database(':memory:'); initFulfillment(db); const raw = event();
    expect((await fulfill(db, raw, signWebhook(raw, 'wrong'), 'evt_1', secret, productId)).status).toBe(401);
    expect((await fulfill(db, raw + ' ', signWebhook(raw, secret), 'evt_1', secret, productId)).status).toBe(401);
    expect((await fulfill(db, raw, signWebhook(raw, secret), 'different', secret, productId)).status).toBe(400);
    expect((await fulfill(db, raw, signWebhook(raw, secret), 'evt_1', secret, 'prod_other')).status).toBe(400);
    expect((await fulfill(db, raw, signWebhook(raw, secret), 'evt_1', secret, productId)).status).toBe(200);
    expect((await fulfill(db, raw, signWebhook(raw, secret), 'evt_1', secret, productId)).result).toBe('duplicate');
    const second = event('evt_2'); await fulfill(db, second, signWebhook(second, secret), 'evt_2', secret, productId);
    expect(db.prepare('SELECT * FROM fulfillment').all()).toHaveLength(1);
    const reopened = new Database(db.serialize()); initFulfillment(reopened);
    expect((await fulfill(reopened, raw, signWebhook(raw, secret), 'evt_1', secret, productId)).result).toBe('duplicate');
  });
  it('fulfills once after a temporary failure, then accepts an outbox replay without duplicate delivery', async () => {
    const api = openDb(), store = new Database(':memory:'); initFulfillment(store);
    const owner = seedMerchant(api, '0x0000000000000000000000000000000000000001', { webhookUrl: 'http://localhost:3210/webhooks/pact', webhookSecret: secret });
    const id = enqueueWebhook(api, owner.merchantId, 'order.paid', 'ord_1', { order: JSON.parse(event()).order }); let failures = 1;
    const fetcher = async (_url: unknown, init?: RequestInit) => {
      if (failures-- > 0) return new Response(null, { status: 503 });
      const headers = new Headers(init?.headers), result = await fulfill(store, String(init?.body), headers.get('x-settle-signature')!, headers.get('x-settle-event-id')!, secret, productId);
      return new Response(null, { status: result.status });
    };
    await deliverWebhooks(api, fetcher as typeof fetch); expect(store.prepare('SELECT * FROM fulfillment').all()).toHaveLength(0);
    await deliverWebhooks(api, fetcher as typeof fetch, new Date(Date.now() + 2000));
    expect(store.prepare('SELECT * FROM fulfillment').all()).toHaveLength(1);
    replayWebhook(api, owner.merchantId, id); await deliverWebhooks(api, fetcher as typeof fetch, new Date(Date.now() + 3000));
    expect(store.prepare('SELECT * FROM fulfillment').all()).toHaveLength(1);
    expect(api.prepare('SELECT status,attempt FROM webhook_deliveries').get()).toMatchObject({ status: 'delivered', attempt: 1 });
  });
});
