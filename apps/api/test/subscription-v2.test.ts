import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { privateKeyToAccount } from 'viem/accounts';
import { hashTypedData, keccak256, toHex, type Hex } from 'viem';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { createApp } from '../src/app.js';
import { cancellationTypedData, consentTypedData, mandateTypedData } from '../src/typed-data.js';
import { bindSubscriptions } from '../src/subscription-binding.js';
import { Indexer } from '../src/indexer.js';
import { readSubscriptionMandate } from '../src/subscription-mandates.js';

const payer = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const merchant = privateKeyToAccount(`0x${'3'.repeat(64)}`);
const addresses = { router: '0x0000000000000000000000000000000000000001', escrow: '0x0000000000000000000000000000000000000002', subscription: '0x0000000000000000000000000000000000000003' } as const;
function fixture() {
  const db = openDb(); const chain = new FakeChain(true, 2);
  const keys = seedMerchant(db, merchant.address);
  const relayer = new Relayer(chain, addresses.router, allowedTargets(addresses.escrow, addresses.subscription, 2));
  const app = createApp({ db, chain, relayer, ...addresses });
  const post = (path: string, body: unknown, key = keys.secretKey) => app.request(path, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body, (_, v) => typeof v === 'bigint' ? v.toString() : v) });
  return { db, chain, keys, app, post };
}
async function request(f: ReturnType<typeof fixture>, version: '1' | '2' = '2') {
  const plan = await (await f.post('/v1/subscriptions/plans', { name: 'Monthly', amount: '2', periodSeconds: 86400, maxPeriods: 12 })).json();
  const mandate = { payer: payer.address, merchant: merchant.address, planId: keccak256(toHex(plan.id)), amountCap: 2_000_000n, periodSeconds: 86400n, maxPeriods: 12, endTime: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400), nonce: 0n };
  const typed = mandateTypedData(mandate, addresses.subscription, version);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const merchantConsent = { deadline, signature: await merchant.signTypedData(consentTypedData(hashTypedData(typed), deadline, addresses.subscription)) };
  return { planId: plan.id, mandate, signature: await payer.signTypedData(typed), merchantConsent };
}
describe('subscription V2 API integration', () => {
  it('persists the exact signed mandate before submission and exposes only merchant-scoped terms', async () => {
    const f = fixture(), body = await request(f);
    const subscribe = f.chain.subscribe.bind(f.chain);
    vi.spyOn(f.chain, 'subscribe').mockImplementation(async (...args) => {
      const stored = readSubscriptionMandate(f.db, args[2]!.objectId)!;
      expect(stored.mandate).toEqual(body.mandate);
      expect(stored.payerSignature).toBe(body.signature);
      expect(stored.merchantConsent).toEqual(body.merchantConsent);
      expect(stored.version).toBe(2);
      return subscribe(...args);
    });
    const created = await (await f.post('/v1/subscriptions', body)).json();
    const get = (key: string) => f.app.request(`/v1/subscriptions/${created.id}/mandate`, { headers: { authorization: `Bearer ${key}` } });
    const response = await get(f.keys.secretKey);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const terms = await response.json();
    expect(terms).toMatchObject({ subscriptionId: created.id, status: 'active', manager: addresses.subscription, version: 2, mandateHash: hashTypedData(mandateTypedData(body.mandate, addresses.subscription, '2')), mandate: { nonce: '0', amountCap: '2000000', endTime: body.mandate.endTime.toString() } });
    expect(terms).not.toHaveProperty('payerSignature');
    expect(terms).not.toHaveProperty('merchantConsent');
    expect((await get(f.keys.publishableKey)).status).toBe(403);
    const other = seedMerchant(f.db, payer.address);
    expect((await get(other.secretKey)).status).toBe(404);
    // The audit record is immutable even after the plan template changes.
    f.db.prepare('UPDATE plans SET max_periods=20 WHERE id=?').run(body.planId);
    expect(readSubscriptionMandate(f.db, created.id)!.mandate.maxPeriods).toBe(12);
    expect(() => f.db.prepare('UPDATE subscription_mandates SET payload=? WHERE subscription_id=?').run('{}', created.id)).toThrow('immutable subscription mandate');
    expect(() => f.db.prepare('DELETE FROM subscription_mandates WHERE subscription_id=?').run(created.id)).toThrow('immutable subscription mandate');
    const reopened = new Database(f.db.serialize());
    try { expect(readSubscriptionMandate(reopened, created.id)).toEqual(readSubscriptionMandate(f.db, created.id)); }
    finally { reopened.close(); }
  });
  it('does not invent legacy signed terms or persist rejected signatures', async () => {
    const f = fixture(), body = await request(f);
    expect((await f.post('/v1/subscriptions', { ...body, merchantConsent: undefined })).status).toBe(422);
    expect(f.db.prepare('SELECT * FROM subscription_mandates').all()).toHaveLength(0);
    f.db.prepare('INSERT INTO subscriptions(id,merchant_id,plan_id,chain_id,payer,status,next_charge_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run('legacy', f.keys.merchantId, body.planId, keccak256(toHex('legacy')), payer.address, 'active', new Date().toISOString(), new Date().toISOString());
    const response = await f.app.request('/v1/subscriptions/legacy/mandate', { headers: { authorization: `Bearer ${f.keys.secretKey}` } });
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('mandate_snapshot_unavailable');
  });
  it('rolls back the writer and subscription if saving the signed terms fails', async () => {
    const f = fixture(), body = await request(f);
    f.db.exec("CREATE TRIGGER reject_mandate BEFORE INSERT ON subscription_mandates BEGIN SELECT RAISE(ABORT,'snapshot unavailable'); END");
    const send = vi.spyOn(f.chain, 'subscribe');
    expect((await f.post('/v1/subscriptions', body)).status).toBe(400);
    expect(send).not.toHaveBeenCalled();
    expect(f.chain.writer.rows()).toHaveLength(0);
    expect(f.db.prepare('SELECT * FROM subscriptions').all()).toHaveLength(0);
  });
  it('publishes the selected contract version to authenticated checkout clients', async () => {
    const f = fixture();
    const response = await f.app.request('/v1/config', { headers: { authorization: `Bearer ${f.keys.publishableKey}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ subscriptionVersion: 2, subscription: addresses.subscription });
  });
  it('requires exact merchant consent before reserving or sending registration', async () => {
    const f = fixture(), body = await request(f);
    const absent = await f.post('/v1/subscriptions', { ...body, merchantConsent: undefined }, f.keys.publishableKey);
    expect(absent.status).toBe(422); expect((await absent.json()).error.code).toBe('merchant_consent_required');
    const wrong = await payer.signTypedData(consentTypedData(hashTypedData(mandateTypedData(body.mandate, addresses.subscription, '2')), body.merchantConsent.deadline, addresses.subscription));
    const response = await f.post('/v1/subscriptions', { ...body, merchantConsent: { ...body.merchantConsent, signature: wrong } });
    expect((await response.json()).error.code).toBe('invalid_merchant_consent');
    expect(f.chain.writer.rows()).toHaveLength(0);
    const create = await f.post('/v1/subscriptions', body, f.keys.publishableKey);
    expect(create.status).toBe(200);
    expect((await create.json()).status).toBe('active');
    expect(f.db.prepare('SELECT status FROM subscriptions').get()).toEqual({ status: 'active' });
  });
  it('rejects expired and altered consent, and V1 payer signatures', async () => {
    const f = fixture(), body = await request(f);
    for (const deadline of [1n, body.merchantConsent.deadline + 1n, body.mandate.endTime + 1n]) {
      const response = await f.post('/v1/subscriptions', { ...body, merchantConsent: { ...body.merchantConsent, deadline } });
      expect(response.status).toBe(422);
      expect((await response.json()).error.code).toBe('invalid_merchant_consent');
    }
    const response = await f.post('/v1/subscriptions', { ...body, signature: await payer.signTypedData(mandateTypedData(body.mandate, addresses.subscription, '1')) });
    expect(response.status).toBe(422); expect((await response.json()).error.code).toBe('invalid_signature');
    expect(f.chain.writer.rows()).toHaveLength(0);
  });
  it('cancels with payer signature while the merchant tank is empty', async () => {
    const f = fixture();
    const sub = await (await f.post('/v1/subscriptions', await request(f))).json();
    f.chain.tank.set(merchant.address.toLowerCase(), { balanceWei: 0n, dailyCapWei: 0n, spentTodayWei: 0n });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    const signature = await payer.signTypedData(cancellationTypedData(sub.chainId, deadline, addresses.subscription));
    const response = await f.post(`/v1/subscriptions/${sub.id}/cancel`, { deadline, signature }, f.keys.publishableKey);
    expect(response.status).toBe(200);
    expect(f.db.prepare('SELECT status,pending_tx_hash FROM subscriptions WHERE id=?').get(sub.id)).toEqual({ status: 'cancelled', pending_tx_hash: null });
    expect(f.chain.writer.rows().map(r => r.phase)).toEqual(['confirmed', 'confirmed']);
    expect((await f.post(`/v1/subscriptions/${sub.id}/cancel`, { deadline, signature })).status).toBe(422);
  });
  it('rejects a merchant cancellation signature and excessive deadline before any new write', async () => {
    const f = fixture();
    const sub = await (await f.post('/v1/subscriptions', await request(f))).json();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    const wrong = await merchant.signTypedData(cancellationTypedData(sub.chainId, deadline, addresses.subscription));
    const response = await f.post(`/v1/subscriptions/${sub.id}/cancel`, { deadline, signature: wrong });
    expect((await response.json()).error.code).toBe('invalid_signature');
    const later = deadline + 600n;
    const signature = await payer.signTypedData(cancellationTypedData(sub.chainId, later, addresses.subscription));
    expect((await (await f.post(`/v1/subscriptions/${sub.id}/cancel`, { deadline: later, signature })).json()).error.code).toBe('invalid_cancellation');
    expect(f.chain.writer.rows()).toHaveLength(1);
  });
  it('holds an accepted-but-timed-out signed cancellation until matching receipt reconciliation', async () => {
    const f = fixture();
    const sub = await (await f.post('/v1/subscriptions', await request(f))).json();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    const signature = await payer.signTypedData(cancellationTypedData(sub.chainId, deadline, addresses.subscription));
    const send = f.chain.broadcastTransaction.bind(f.chain);
    vi.spyOn(f.chain, 'broadcastTransaction').mockImplementationOnce(async raw => { await send(raw); throw new Error('accepted then timeout'); });
    const response = await f.post(`/v1/subscriptions/${sub.id}/cancel`, { deadline, signature });
    expect(response.status).toBe(200);
    await new Indexer(f.db, f.chain).poll();
    expect(f.db.prepare('SELECT status FROM subscriptions WHERE id=?').get(sub.id)).toEqual({ status: 'cancelled' });
    expect(f.chain.writer.rows().at(-1)?.phase).toBe('confirmed');
  });
  it('will not reinterpret an existing subscription database as a different deployment', async () => {
    const f = fixture(); await f.post('/v1/subscriptions', await request(f));
    expect(() => bindSubscriptions(f.db, addresses.subscription, 1)).toThrow('deployment mismatch');
    expect(() => bindSubscriptions(f.db, merchant.address, 2)).toThrow('deployment mismatch');
    f.db.exec('DELETE FROM subscription_binding');
    expect(() => bindSubscriptions(f.db, addresses.subscription, 2)).toThrow('deployment mismatch');
  });
});
