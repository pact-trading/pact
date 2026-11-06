import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { keccak256, toHex } from 'viem';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { createApp } from '../src/app.js';
import { runKeeper } from '../src/keeper.js';
import { KeeperRenewals } from '../src/subscriptions-live.js';

const addresses = { router: '0x0000000000000000000000000000000000000001', escrow: '0x0000000000000000000000000000000000000002', subscription: '0x0000000000000000000000000000000000000003' } as const;
function fixture(version: 1 | 2 = 1, dashboard = false) {
  const db = openDb(), chain = new FakeChain(true);
  const keys = seedMerchant(db, addresses.router, { webhookUrl: 'https://merchant.example/webhook' });
  const relayer = new Relayer(chain, addresses.router, allowedTargets({ escrow: addresses.escrow, subscription: addresses.subscription }));
  const renewals = new KeeperRenewals(db, chain);
  const identity = dashboard ? {
    handles: (token: string) => token === 'dashboard-session',
    merchantFor: async () => ({ merchantId: keys.merchantId, address: addresses.router, kind: 'secret' as const }),
    authenticate: vi.fn(), register: vi.fn(),
  } : undefined;
  const app = createApp({ db, chain, relayer, renewals, identity, ...addresses });
  db.prepare('INSERT INTO plans(id,merchant_id,name,amount_minor,period_seconds,created_at) VALUES (?,?,?,?,?,?)').run('plan', keys.merchantId, 'Monthly', '2000000', 86400, '2026-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO subscriptions(id,merchant_id,plan_id,chain_id,payer,status,next_charge_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run('sub', keys.merchantId, 'plan', keccak256(toHex('sub')), addresses.escrow, 'active', '2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  const post = (key = keys.secretKey, body: unknown = { by: 'merchant' }) => app.request('/v1/subscriptions/sub/cancel', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { db, chain, keys, renewals, app, post };
}
describe('merchant cancellation', () => {
  it.each([1, 2] as const)('cancels V%i off-chain, persists the timestamp, and enqueues merchant context once', async version => {
    const f = fixture(version), cancel = vi.spyOn(f.chain, 'cancelSigned');
    const response = await f.post();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 'sub', status: 'cancelled', cancelledBy: 'merchant', cancelledAt: expect.any(String) });
    const stored = f.db.prepare('SELECT status,cancelled_at,cancelled_by FROM subscriptions WHERE id=?').get('sub');
    expect(stored).toMatchObject({ status: 'cancelled', cancelled_at: expect.any(String), cancelled_by: 'merchant' });
    const detail = await f.app.request('/v1/subscriptions/sub', { headers: { authorization: `Bearer ${f.keys.secretKey}` } });
    expect(await detail.json()).toMatchObject({ status: 'cancelled', cancelledAt: (stored as { cancelled_at: string }).cancelled_at });
    const event = f.db.prepare("SELECT payload FROM webhook_events WHERE type='subscription.cancelled'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ object_id: 'sub', cancelled_by: 'merchant' });
    expect(f.db.prepare('SELECT * FROM webhook_deliveries').all()).toHaveLength(1);
    expect((await f.post()).status).toBe(422);
    expect(f.db.prepare('SELECT * FROM webhook_events').all()).toHaveLength(1);
    expect(cancel).not.toHaveBeenCalled();
    f.db.close();
  });
  it('accepts an authenticated merchant dashboard session', async () => {
    const f = fixture(1, true);
    expect((await f.post('dashboard-session')).status).toBe(200);
    expect(f.db.prepare('SELECT cancelled_by FROM subscriptions').get()).toEqual({ cancelled_by: 'merchant' });
    f.db.close();
  });
  it('rolls back cancellation if its webhook cannot be saved', async () => {
    const f = fixture();
    f.db.exec("CREATE TRIGGER fail_webhook BEFORE INSERT ON webhook_events BEGIN SELECT RAISE(ABORT,'webhook unavailable'); END");
    expect((await f.post()).status).toBe(400);
    expect(f.db.prepare('SELECT status,cancelled_at,cancelled_by FROM subscriptions').get()).toEqual({ status: 'active', cancelled_at: null, cancelled_by: null });
    f.db.close();
  });
  it('rejects publishable keys and other merchants without changing the subscription', async () => {
    const f = fixture();
    expect((await (await f.post(f.keys.publishableKey)).json()).error.code).toBe('secret_key_required');
    const other = seedMerchant(f.db, addresses.escrow);
    expect((await (await f.post(other.secretKey)).json()).error.code).toBe('subscription_not_found');
    expect((await f.post('invalid')).status).toBe(401);
    expect(f.db.prepare('SELECT status FROM subscriptions').get()).toEqual({ status: 'active' });
    expect(f.db.prepare('SELECT * FROM webhook_events').all()).toHaveLength(0);
    f.db.close();
  });
  it('never renews after the due date, including forced merchant renewals', async () => {
    const f = fixture(), renew = vi.spyOn(f.chain, 'renew');
    expect((await f.post()).status).toBe(200);
    await runKeeper(f.db, f.chain, new Date('2027-01-01T00:00:00.000Z'), f.renewals);
    await expect(f.renewals.renew('sub', { force: true })).rejects.toMatchObject({ code: 'cancelled' });
    const manual = await f.app.request('/v1/subscriptions/sub/renew', { method: 'POST', headers: { authorization: `Bearer ${f.keys.secretKey}`, 'content-type': 'application/json' }, body: '{}' });
    expect(manual.status).toBe(422);
    expect((await manual.json()).error.code).toBe('cancelled');
    expect(renew).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT status FROM subscriptions').get()).toEqual({ status: 'cancelled' });
    f.db.close();
  });
  it('refuses cancellation while a renewal is pending', async () => {
    const f = fixture();
    f.db.prepare('UPDATE subscriptions SET pending_tx_hash=?').run(keccak256(toHex('pending')));
    expect((await (await f.post()).json()).error.code).toBe('subscription_pending');
    expect(f.db.prepare('SELECT status FROM subscriptions').get()).toEqual({ status: 'active' });
    f.db.close();
  });
  it('adds nullable cancellation columns to an existing database without losing records', () => {
    const old = new Database(':memory:');
    old.exec("CREATE TABLE subscriptions(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, plan_id TEXT NOT NULL, chain_id TEXT, payer TEXT, status TEXT NOT NULL, next_charge_at TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, pending_tx_hash TEXT, created_at TEXT NOT NULL); INSERT INTO subscriptions(id,merchant_id,plan_id,status,next_charge_at,created_at) VALUES ('old','merchant','plan','active','2026-01-01','2026-01-01')");
    const migrated = openDb(old.serialize());
    expect(migrated.prepare('SELECT id,status,cancelled_at,cancelled_by FROM subscriptions').get()).toEqual({ id: 'old', status: 'active', cancelled_at: null, cancelled_by: null });
    migrated.close(); old.close();
  });
});
