import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Address } from 'viem';
import { openDb, seedMerchant, type Db } from '../src/db.js';
import { getDashboardSummary } from '../src/dashboard.js';
import { FakeChain } from '../src/chain.js';
import { createApp } from '../src/app.js';
import { Relayer } from '../src/relayer.js';

const merchant = '0x0000000000000000000000000000000000000011' as Address;
const other = '0x0000000000000000000000000000000000000022' as Address;
const router = '0x0000000000000000000000000000000000000033' as Address;
const timestamp = '2026-11-01T00:00:00.000Z';
const databases: Db[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture(at = timestamp) {
  const db = openDb();
  databases.push(db);
  const keys = seedMerchant(db, merchant);
  const otherKeys = seedMerchant(db, other);
  const chain = new FakeChain();
  const termsRead = vi.spyOn(chain, 'merchantFees');
  const auth = { merchantId: keys.merchantId, address: merchant };
  const summary = () => getDashboardSummary(db, chain, auth, () => new Date(at));
  const app = createApp({ db, chain, relayer: new Relayer(chain, router, {}) });
  const get = (key = keys.secretKey, path = '/v1/dashboard') => app.request(path, { headers: { authorization: `Bearer ${key}` } });
  const payment = (id: string, captured = '0', refunded = '0', status = 'open', date = at, owner = keys.merchantId) => {
    db.prepare('INSERT INTO payments(id,merchant_id,amount_minor,captured_minor,refunded_minor,status,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(id, owner, captured, captured, refunded, status, date);
    if (BigInt(captured) > 0n) db.prepare('INSERT INTO accounting_entries(event_id,merchant_id,object_id,kind,amount_minor,tx_hash,occurred_at,block_number) VALUES (?,?,?,?,?,?,?,?)').run(`capture-${id}`, owner, id, 'Payment', captured, `0x${id}`, date, '1');
    if (BigInt(refunded) > 0n) db.prepare('INSERT INTO accounting_entries(event_id,merchant_id,object_id,kind,amount_minor,tx_hash,occurred_at,block_number) VALUES (?,?,?,?,?,?,?,?)').run(`refund-${id}`, owner, id, 'Refund', String(-BigInt(refunded)), `0x${id}`, date, '1');
  };
  /** A refund's network fee, charged to the merchant in USDT. */
  const gas = (id: string, fee: string, _cost: string, date = at, owner = keys.merchantId) => {
    db.prepare('INSERT INTO accounting_entries(event_id,merchant_id,object_id,kind,amount_minor,fee_minor,tx_hash,occurred_at,block_number) VALUES (?,?,?,?,?,?,?,?,?)').run(`fee-${id}`, owner, id, 'Fee', '0', fee, `0x${id}`, date, '1');
  };
  const webhook = (id: string, type: string, objectId: string, payload: object | string = {}, date = at, owner = keys.merchantId) =>
    db.prepare('INSERT INTO webhook_events VALUES (?,?,?,?,?,?)')
      .run(id, owner, type, objectId, typeof payload === 'string' ? payload : JSON.stringify(payload), date);
  const refusal = (id: string, objectId: string, reason: string, tx: string | null, date = at, owner = keys.merchantId) =>
    db.prepare('INSERT INTO refusal_attempts (id,merchant_id,object_id,reason,tx_hash,created_at) VALUES (?,?,?,?,?,?)').run(id, owner, objectId, reason, tx, date);
  const intent = (id: string, reason: string, tx: string | null, date = at, owner = keys.merchantId) =>
    db.prepare('INSERT INTO intents VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, owner, merchant, id, '{}', 'refused', reason, tx, date);
  return { db, keys, otherKeys, chain, termsRead, summary, get, app, payment, gas, webhook, refusal, intent };
}

describe('dashboard summary', () => {
  it('keeps the onchain wallet balance distinct from lifetime net sales with exact large amounts', async () => {
    const f = fixture();
    f.payment('sale', '2000000');
    f.chain.merchantBalances.set(merchant.toLowerCase(), 900719925474099312345678n);
    const result = await f.summary();
    expect(result.metrics.netUsdt).toBe('2.000000');
    expect(result.balance).toMatchObject({ available: true, address: merchant, amountUsdt: '900719925474099312.345678', blockNumber: '0' });
    expect(result.accountingComplete).toBe(true);
    expect((await (await f.get(f.otherKeys.secretKey)).json()).balance.amountUsdt).toBe('0.000000');
  });
  it('uses confirmed time for daily volume and includes subscription charges without counting old creation dates', async () => {
    const f = fixture();
    f.payment('created-last-month', '2000000', '500000', 'partially_refunded', '2026-10-01T00:00:00Z');
    f.db.prepare('UPDATE accounting_entries SET occurred_at=? WHERE object_id=?').run(timestamp, 'created-last-month');
    f.db.prepare('INSERT INTO accounting_entries(event_id,merchant_id,object_id,kind,amount_minor,tx_hash,occurred_at,block_number) VALUES (?,?,?,?,?,?,?,?)').run('renewal', f.keys.merchantId, 'sub', 'Subscription', '3000000', '0x01', timestamp, '2');
    f.gas('today-fee', '10000', '50');
    f.db.prepare('INSERT INTO invoices(id,merchant_id,customer_email,amount_minor,status,created_at) VALUES (?,?,?,?,?,?)').run('financed', f.keys.merchantId, 'buyer@test.example', '1000000', 'financed', timestamp);
    const result = await f.summary();
    expect(result.today).toEqual({ capturedUsdt: '5.000000', refundedUsdt: '0.500000', feesUsdt: '0.010000', payments: 1, refunds: 1, subscriptionCharges: 1 });
    expect(result.volume.at(-1)?.amount).toBe('5.000000');
    expect(result.metrics).toMatchObject({ capturedUsdt: '5.000000', refundedUsdt: '0.500000', feesUsdt: '0.010000', netUsdt: '4.490000' });
    expect(result.metrics.financedInvoices).toBe(1);
    f.db.prepare('UPDATE accounting_state SET coverage_complete=0 WHERE id=1').run();
    expect((await f.summary()).accountingComplete).toBe(false);
  });
  it('preserves gas state and indexed metrics when the independent wallet balance read fails', async () => {
    const f = fixture();
    f.payment('sale', '2000000');
    vi.spyOn(f.chain, 'merchantBalance').mockRejectedValue(new Error('balance RPC failed'));
    const result = await f.summary();
    expect(result.balance).toMatchObject({ available: false, amountUsdt: null, blockNumber: null });
    expect(result.feeTerms).toEqual({ accepted: false, acceptedVersion: 0, latestVersion: 1 });
    expect(result.today.capturedUsdt).toBe('2.000000');
  });
  it('bounds a stalled balance read independently without losing the successful fee-terms read', async () => {
    vi.useFakeTimers();
    const f = fixture();
    vi.spyOn(f.chain, 'merchantBalance').mockImplementation(() => new Promise(() => {}));
    const pending = f.summary();
    await vi.advanceTimersByTimeAsync(2500);
    expect(await pending).toMatchObject({ balance: { available: false }, feeTerms: { accepted: false } });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('sums all-time base units exactly across more than 100 payments and isolates every metric', async () => {
    const f = fixture();
    for (let i = 0; i < 105; i++) f.payment(`payment-${i}`, '1000001', '0', 'captured');
    f.payment('large-old-payment', '900719925474099312345678', '0', 'captured', '2024-01-01T00:00:00.000Z');
    f.payment('partial', '3000000', '1000000', 'partially_refunded');
    f.payment('full', '2000000', '2000000', 'refunded');
    f.payment('authorized', '0', '0', 'authorized');
    f.payment('open');
    f.payment('other-payment', '999999999999999999999999999', '1000000', 'authorized', timestamp, f.otherKeys.merchantId);
    f.gas('current', '10001', '20');
    f.gas('old', '20002', '800', '2024-01-01T00:00:00.000Z');
    f.gas('other', '999999999', '999999999', timestamp, f.otherKeys.merchantId);
    for (const [id, status, owner] of [
      ['active-1', 'active', f.keys.merchantId], ['active-2', 'active', f.keys.merchantId],
      ['cancelled', 'cancelled', f.keys.merchantId], ['past-due', 'past_due', f.keys.merchantId],
      ['other-active', 'active', f.otherKeys.merchantId],
    ]) f.db.prepare('INSERT INTO subscriptions(id,merchant_id,plan_id,status,next_charge_at,created_at) VALUES (?,?,?,?,?,?)')
      .run(id, owner, 'plan', status, timestamp, timestamp);
    const result = await f.summary();
    expect(result.metrics).toEqual({
      capturedUsdt: '900719925474099422.345783', refundedUsdt: '3.000000',
      netUsdt: '900719925474099419.315780', feesUsdt: '0.030003',
      totalPayments: 110, successfulPayments: 108, authorizedPayments: 1, activeSubscriptions: 2, financedInvoices: 0,
    });
    expect(result.volume.at(-1)).toEqual({ date: '2026-11-01', amount: '110.000105' });
    expect(f.termsRead).toHaveBeenCalledExactlyOnceWith(merchant);
  });

  it('zero-fills 14 UTC dates across a month boundary using confirmed accounting timestamps', async () => {
    const f = fixture();
    f.payment('before-window', '99000000', '0', 'captured', '2026-10-18T23:59:59.999Z');
    f.payment('window-start', '1000000', '0', 'captured', '2026-10-19T00:00:00.000Z');
    f.payment('last-month', '2000001', '0', 'captured', '2026-10-31T23:59:59.999Z');
    // Explicit offset normalizes to October 31 in UTC.
    f.payment('offset', '3000000', '0', 'captured', '2026-11-01T00:30:00+02:00');
    f.payment('today', '4000000', '0', 'captured');
    f.payment('tomorrow', '5000000', '0', 'captured', '2026-11-02T00:00:00.000Z');
    f.webhook('capture-record', 'payment.captured', 'before-window', {}, timestamp);
    const result = await f.summary();
    expect(result.generatedAt).toBe(timestamp);
    expect(result.timeZone).toBe('UTC');
    expect(result.volume).toEqual(Array.from({ length: 14 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 9, 19 + index)).toISOString().slice(0, 10),
      amount: index === 0 ? '1.000000' : index === 12 ? '5.000001' : index === 13 ? '4.000000' : '0.000000',
    })));
    expect(result.metrics.capturedUsdt).toBe('114.000001');
  });

  it('returns honest empty state and preserves negative net when recorded fees exceed net captures', async () => {
    const f = fixture();
    const empty = await f.summary();
    expect(empty.metrics).toEqual({ capturedUsdt: '0.000000', refundedUsdt: '0.000000', netUsdt: '0.000000', feesUsdt: '0.000000', totalPayments: 0, successfulPayments: 0, authorizedPayments: 0, activeSubscriptions: 0, financedInvoices: 0 });
    expect(empty.volume).toHaveLength(14);
    expect(empty.volume.every(day => day.amount === '0.000000')).toBe(true);
    expect(empty.recentActivity).toEqual([]);
    expect(empty.feeTerms).toEqual({ accepted: false, acceptedVersion: 0, latestVersion: 1 });
    f.payment('refunded', '1000000', '1000000', 'refunded');
    f.gas('fee', '1', '0');
    expect((await f.summary()).metrics).toMatchObject({ successfulPayments: 1, netUsdt: '-0.000001', feesUsdt: '0.000001' });
  });

  it('reports the fee terms the merchant signed, and counts every fee Pact took', async () => {
    const f = fixture();
    f.chain.accepted.set(merchant.toLowerCase(), 1);
    f.chain.latestVersion = 2;
    expect((await f.summary()).feeTerms).toEqual({ accepted: true, acceptedVersion: 1, latestVersion: 2 });
    f.payment('sale', '100000000');
    f.db.prepare("UPDATE accounting_entries SET fee_minor='800000' WHERE event_id='capture-sale'").run();
    f.gas('refund-gas', '20000', '0');
    expect((await f.summary()).metrics).toMatchObject({ capturedUsdt: '100.000000', feesUsdt: '0.820000', netUsdt: '99.180000' });
  });

  it('preserves all DB results when the fee-terms RPC fails and never fabricates its fields', async () => {
    const f = fixture();
    f.payment('payment', '2000000', '1000000', 'partially_refunded');
    f.gas('fee', '10000', '20');
    f.webhook('event', 'payment.refunded', 'payment', { tx_hash: '0xabc' });
    f.termsRead.mockRejectedValue(new Error('RPC unavailable'));
    const result = await f.summary();
    expect(result.metrics).toMatchObject({ capturedUsdt: '2.000000', refundedUsdt: '1.000000', feesUsdt: '0.010000', netUsdt: '0.990000', successfulPayments: 1 });
    expect(result.volume.at(-1)?.amount).toBe('2.000000');
    expect(result.recentActivity).toHaveLength(1);
    expect(result.feeTerms).toEqual({ accepted: null, acceptedVersion: null, latestVersion: null });
    const response = await f.get();
    expect(response.status).toBe(200);
    expect((await response.json()).feeTerms).toEqual(result.feeTerms);
  });

  it('returns DB metrics within 2500ms when the fee-terms RPC never settles', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.payment('payment', '2000000', '1000000', 'partially_refunded');
    f.gas('fee', '10000', '20');
    f.webhook('event', 'payment.refunded', 'payment', { tx_hash: '0xabc' });
    f.termsRead.mockImplementation(() => new Promise(() => {}));
    let settled = false;
    const pending = f.summary().then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(2499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    const result = await pending;
    expect(result.metrics).toMatchObject({ capturedUsdt: '2.000000', refundedUsdt: '1.000000', feesUsdt: '0.010000', netUsdt: '0.990000' });
    expect(result.volume.at(-1)?.amount).toBe('2.000000');
    expect(result.recentActivity).toHaveLength(1);
    expect(result.feeTerms).toEqual({ accepted: null, acceptedVersion: null, latestVersion: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles an RPC rejection arriving after the dashboard timeout', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.termsRead.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(new Error('late RPC failure')), 3000)));
    let settled = false;
    const pending = f.summary().then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(2500);
    expect(settled).toBe(true);
    const result = await pending;
    expect(result.feeTerms.accepted).toBeNull();
    // Vitest reports an unhandled rejection if the timed-out RPC is not observed.
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.getTimerCount()).toBe(0);
    expect(result.feeTerms.accepted).toBeNull();
  });

  it('cleans up the timeout after a delayed RPC succeeds before the deadline', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.termsRead.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ acceptedVersion: 1, latestVersion: 2, accepted: null, latest: null, recipient: merchant, usdtPerWbt: 1n, nonce: 0n } as never), 100)));
    const pending = f.summary();
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).feeTerms).toEqual({ accepted: true, acceptedVersion: 1, latestVersion: 2 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up the timeout after an immediate RPC rejection', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.termsRead.mockRejectedValue(new Error('immediate RPC failure'));
    expect((await f.summary()).feeTerms.accepted).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('deduplicates webhook, refusal and refused-intent representations without hiding distinct activity', async () => {
    const f = fixture();
    f.intent('intent-1', 'gas_limit', '0xABC');
    f.refusal('attempt-1', 'payment-1', 'gas_limit', '0xabc');
    f.refusal('attempt-intent-id', 'intent-1', 'gas_limit', '0xabc');
    f.webhook('event-1', 'intent.refused', 'payment-1', { tx_hash: '0xAbC', reason: 'gas_limit', intent_id: 'intent-1' });
    f.webhook('event-duplicate', 'intent.refused', 'payment-1', { tx_hash: '0xabc', reason: 'gas_limit', intent_id: 'intent-1' });
    f.webhook('event-intent-id', 'intent.refused', 'intent-1', { tx_hash: '0xabc', reason: 'gas_limit', intent_id: 'intent-1' });
    f.webhook('capture-same-tx', 'payment.captured', 'another-payment', { tx_hash: '0xABC' });
    f.webhook('other-object', 'intent.refused', 'another-object', { tx_hash: '0xABC', reason: 'gas_limit', intent_id: 'other-intent' });
    f.intent('fallback-intent', 'deadline', '0xdef');
    f.refusal('offline-1', 'payment-1', 'refund_limit', null);
    f.refusal('offline-2', 'payment-1', 'refund_limit', null);
    f.webhook('other-merchant', 'payment.captured', 'private', { tx_hash: '0xdef' }, timestamp, f.otherKeys.merchantId);
    f.refusal('other-attempt', 'private', 'deadline', '0xdef', timestamp, f.otherKeys.merchantId);
    f.intent('other-intent-row', 'deadline', '0x999', timestamp, f.otherKeys.merchantId);
    const { recentActivity } = await f.summary();
    expect(recentActivity).toHaveLength(6);
    expect(recentActivity.filter(event => event.objectId === 'payment-1' && event.reason === 'gas_limit')).toHaveLength(1);
    expect(recentActivity.some(event => event.id === 'capture-same-tx')).toBe(true);
    expect(recentActivity.some(event => event.id === 'other-object')).toBe(true);
    expect(recentActivity.find(event => event.id === 'fallback-intent')).toEqual({ id: 'fallback-intent', type: 'intent.refused', objectId: 'fallback-intent', createdAt: timestamp, txHash: '0xdef', reason: 'deadline' });
    expect(recentActivity.filter(event => event.txHash === null).map(event => event.id).sort()).toEqual(['offline-1', 'offline-2']);
  });

  it('deduplicates a refused intent against an attempt when no webhook exists', async () => {
    const f = fixture();
    f.intent('intent', 'target_failed', '0xabc');
    f.refusal('attempt', 'payment', 'target_failed', '0xABC');
    expect((await f.summary()).recentActivity).toEqual([{ id: 'attempt', type: 'refusal', objectId: 'payment', createdAt: timestamp, txHash: '0xABC', reason: 'target_failed' }]);
  });

  it('deduplicates explicit intent identities without assuming unrelated offchain attempts are identical', async () => {
    const f = fixture();
    f.intent('intent', 'deadline', null);
    f.webhook('event', 'intent.refused', 'intent', { reason: 'deadline' });
    f.refusal('attempt', 'intent', 'deadline', null);
    const { recentActivity } = await f.summary();
    expect(recentActivity.map(event => event.id).sort()).toEqual(['attempt', 'event']);
  });

  it('selects the newest ten after deduplication, without synthesizing payment events or exposing payloads', async () => {
    const f = fixture();
    f.payment('silent-payment', '1000000', '0', 'captured');
    for (let i = 0; i < 12; i++) f.webhook(`event-${i}`, 'payment.captured', `payment-${i}`, { secret: 'never expose', tx_hash: `0x${i}` }, `2026-10-31T12:00:${String(i).padStart(2, '0')}.000Z`);
    f.webhook('malformed', 'webhook.test', 'test', '{broken', timestamp);
    f.webhook('duplicate-11', 'payment.captured', 'payment-11', { tx_hash: '0x11' }, '2026-10-31T12:00:11.000Z');
    const result = await f.summary();
    expect(result.recentActivity).toHaveLength(10);
    expect(result.recentActivity[0]).toEqual({ id: 'malformed', type: 'webhook.test', objectId: 'test', createdAt: timestamp, txHash: null, reason: null });
    expect(result.recentActivity.map(event => event.objectId)).toEqual(['test', ...Array.from({ length: 9 }, (_, i) => `payment-${11 - i}`)]);
    expect(JSON.stringify(result)).not.toContain('never expose');
    expect(JSON.stringify(result)).not.toContain('silent-payment');
  });

  it('registers a secret-only read-only route using the authenticated merchant, ignoring query overrides', async () => {
    const f = fixture();
    f.payment('mine', '2000000', '0', 'captured');
    f.payment('theirs', '99000000', '0', 'captured', timestamp, f.otherKeys.merchantId);
    const before = f.db.prepare('SELECT total_changes() AS count').get();
    expect((await f.app.request('/v1/dashboard')).status).toBe(401);
    expect((await f.get('invalid')).status).toBe(401);
    expect((await f.get(f.keys.publishableKey)).status).toBe(403);
    expect(f.termsRead).not.toHaveBeenCalled();
    const response = await f.get(f.keys.secretKey, `/v1/dashboard?merchantId=${f.otherKeys.merchantId}&address=${other}`);
    expect(response.status).toBe(200);
    expect((await response.json()).metrics.capturedUsdt).toBe('2.000000');
    expect(f.termsRead).toHaveBeenCalledExactlyOnceWith(merchant);
    expect(f.chain.sent).toEqual([]);
    expect(f.db.prepare('SELECT total_changes() AS count').get()).toEqual(before);
    expect((await (await f.get(f.otherKeys.secretKey)).json()).metrics.capturedUsdt).toBe('99.000000');
  });
});
