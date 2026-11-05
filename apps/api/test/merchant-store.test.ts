import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { Address } from 'viem';
import { fulfill, initFulfillment } from '../../../examples/merchant-store/fulfillment.ts';
import { forward } from '../../../examples/merchant-store/lib/proxy.ts';
import { STORE_ITEM } from '../../../examples/merchant-store/lib/store.ts';
import { FakeChain } from '../src/chain.js';
import { createApp } from '../src/app.js';
import { openDb, seedMerchant } from '../src/db.js';
import { IdentityError, type PrivyIdentity } from '../src/identity.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { signWebhook } from '../src/webhooks.js';

const env = { PACT_SECRET_KEY: 'sk_test_server_only', PACT_API_URL: 'http://upstream.test' };
const post = (body: unknown, headers: Record<string, string> = {}) => new Request('http://store.test/api/pact/v1/payments', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer browser-token', cookie: 'session=abc', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const upstream = (response = Response.json({ id: 'pay_1', checkoutUrl: 'https://pay.test/pay/pay_1' }, { status: 200 })) => vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => response);
const sent = (fetcher: ReturnType<typeof upstream>) => ({ url: String(fetcher.mock.calls[0][0]), init: fetcher.mock.calls[0][1]!, body: JSON.parse(String(fetcher.mock.calls[0][1]!.body)) });

describe('merchant store proxy route', () => {
  it('forwards the checkout request with the server secret and the server price, and no browser credentials', async () => {
    const fetcher = upstream();
    const response = await forward(post({ amount: '12.5', currency: 'USDT', email: 'ana@example.test', description: 'free stuff', metadata: { company: 'Acme' } }, { 'idempotency-key': 'k1' }), ['v1', 'payments'], env, fetcher as typeof fetch);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ checkoutUrl: 'https://pay.test/pay/pay_1' });
    const { url, init, body } = sent(fetcher);
    expect(url).toBe('http://upstream.test/v1/payments');
    expect(init.headers).toEqual({ 'content-type': 'application/json', authorization: 'Bearer sk_test_server_only', 'idempotency-key': 'k1' });
    expect(body).toEqual({ amount: STORE_ITEM.amount, currency: 'USDT', description: STORE_ITEM.name, email: 'ana@example.test', metadata: { company: 'Acme', store_item: STORE_ITEM.id } });
  });
  it('defaults to the production API', async () => {
    const fetcher = upstream();
    await forward(post({ amount: STORE_ITEM.amount }), ['v1', 'payments'], { PACT_SECRET_KEY: 'sk' }, fetcher as typeof fetch);
    expect(sent(fetcher).url).toBe('https://api.pactagent.app/v1/payments');
  });
  it.each([
    ['GET', ['v1', 'payments']], ['GET', ['v1', 'payments', 'pay_1']], ['POST', ['v1', 'payments', 'pay_1', 'refund']],
    ['POST', ['v1', 'api-keys']], ['POST', ['v1', 'invoices']], ['GET', ['v1', 'dashboard']], ['POST', ['v1', 'payments', '..', 'api-keys']],
  ])('refuses %s %j without calling Pact', async (method, path) => {
    const fetcher = upstream();
    const response = await forward(new Request('http://store.test/x', { method, ...(method === 'POST' ? { body: '{}' } : {}) }), path, env, fetcher as typeof fetch);
    expect(response.status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    ['a lower price', { amount: '0.01' }, 'invalid_amount'],
    ['a higher price', { amount: '13' }, 'invalid_amount'],
    ['no price', {}, 'invalid_amount'],
    ['an unparseable price', { amount: 'free' }, 'invalid_amount'],
    ['an invoice payment', { amount: STORE_ITEM.amount, metadata: { invoiceId: 'inv_1' } }, 'invalid_metadata'],
    ['a payment link', { amount: STORE_ITEM.amount, metadata: { paymentLinkId: 'link_1' } }, 'invalid_metadata'],
    ['a forged store item', { amount: STORE_ITEM.amount, metadata: { store_item: 'other' } }, 'invalid_metadata'],
    ['metadata that is a list', { amount: STORE_ITEM.amount, metadata: ['x'] }, 'invalid_metadata'],
    ['broken JSON', '{', 'invalid_json'],
  ])('refuses %s without calling Pact', async (_name, body, code) => {
    const fetcher = upstream();
    const response = await forward(post(body), ['v1', 'payments'], env, fetcher as typeof fetch);
    expect(response.status).toBe(400);
    expect((await response.json() as { error: { code: string } }).error.code).toBe(code);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses an oversized body, reports a missing key, and keeps upstream failures generic', async () => {
    const fetcher = upstream();
    expect((await forward(post({ amount: STORE_ITEM.amount, pad: 'x'.repeat(70_000) }), ['v1', 'payments'], env, fetcher as typeof fetch)).status).toBe(413);
    expect((await forward(post({ amount: STORE_ITEM.amount }), ['v1', 'payments'], {}, fetcher as typeof fetch)).status).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
    const down = await forward(post({ amount: STORE_ITEM.amount }), ['v1', 'payments'], env, (async () => { throw new Error('secret http://internal.test'); }) as typeof fetch);
    expect(down.status).toBe(502);
    expect(await down.text()).not.toContain('internal.test');
  });
  it('passes on what Pact refuses, and drops upstream headers such as cookies', async () => {
    const response = await forward(post({ amount: STORE_ITEM.amount }), ['v1', 'payments'], env, upstream(Response.json({ error: { code: 'invalid_metadata' } }, { status: 422, headers: { 'set-cookie': 'x=1' } })) as typeof fetch);
    expect(response.status).toBe(422);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
  it('works against the real API route with a real secret key', async () => {
    const db = openDb(), chain = new FakeChain(true), keys = seedMerchant(db, `0x${'b'.repeat(40)}`);
    const app = createApp({ db, chain, relayer: new Relayer(chain, `0x${'1'.repeat(40)}` as Address, allowedTargets(`0x${'2'.repeat(40)}` as Address, `0x${'3'.repeat(40)}` as Address)) });
    const response = await forward(post({ amount: STORE_ITEM.amount, email: 'ana@example.test' }), ['v1', 'payments'], { PACT_SECRET_KEY: keys.secretKey, PACT_API_URL: 'http://api.test' }, ((url: string, init: RequestInit) => app.request(new URL(url).pathname, init)) as unknown as typeof fetch);
    expect(response.status).toBe(200);
    const created = await response.json() as { id: string; checkoutUrl: string };
    expect(created.checkoutUrl).toContain(`/pay/${created.id}`);
    expect(db.prepare('SELECT amount_minor,description,customer,custom_metadata FROM payments').get()).toEqual({ amount_minor: STORE_ITEM.amountMinor, description: STORE_ITEM.name, customer: 'ana@example.test', custom_metadata: JSON.stringify({ store_item: STORE_ITEM.id }) });
    db.close();
  });
});

describe('merchant store embedded fulfillment', () => {
  const secret = 'whsec_local_fixture', embedded = { item: STORE_ITEM.id, amountMinor: STORE_ITEM.amountMinor };
  const captured = (overrides: Record<string, unknown> = {}, id = 'evt_1') => JSON.stringify({ id, type: 'payment.captured', object_id: 'pay_1', amount_minor: STORE_ITEM.amountMinor, metadata: { store_item: STORE_ITEM.id }, ...overrides });
  const send = (db: Database.Database, raw: string, id = 'evt_1', key = secret) => fulfill(db, raw, signWebhook(raw, key), id, secret, '', embedded);
  const fresh = () => { const db = new Database(':memory:'); initFulfillment(db); return db; };
  it('records a signed capture of this store item once, across retries and new event IDs', async () => {
    const db = fresh();
    expect(await send(db, captured())).toEqual({ status: 200, result: 'recorded' });
    expect((await send(db, captured())).result).toBe('duplicate');
    await send(db, captured({}, 'evt_2'), 'evt_2');
    expect(db.prepare('SELECT order_id,product_id,amount_minor FROM fulfillment').all()).toEqual([{ order_id: 'pay_1', product_id: STORE_ITEM.id, amount_minor: STORE_ITEM.amountMinor }]);
  });
  it('refuses a bad signature and the wrong amount, and ignores other payments', async () => {
    const db = fresh();
    expect((await send(db, captured(), 'evt_1', 'wrong')).status).toBe(401);
    expect((await send(db, captured({ amount_minor: '1' }))).status).toBe(400);
    expect((await send(db, captured({ metadata: { store_item: 'other' } }))).result).toBe('ignored');
    expect((await send(db, captured({ metadata: {} }))).result).toBe('ignored');
    expect(db.prepare('SELECT * FROM fulfillment').all()).toEqual([]);
  });
  it('ignores order.paid when no hosted product is configured', async () => {
    const db = fresh(), raw = JSON.stringify({ id: 'evt_1', type: 'order.paid', object_id: 'ord_1', order: { id: 'ord_1', productId: 'prod_x' } });
    expect((await send(db, raw)).result).toBe('ignored');
  });
});

describe('hosted page for a plain payment', () => {
  const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
  function fixture() {
    const db = openDb(), chain = new FakeChain(true), keys = seedMerchant(db, address(11));
    const users: Record<string, object> = { ana: { userId: 'ana', email: 'ana@example.test', sessionId: 's', expiresAt: 9e9, wallet: { address: address(22), id: null } }, eve: { userId: 'eve', email: 'eve@example.test', sessionId: 's', expiresAt: 9e9, wallet: { address: address(33), id: null } } };
    const identity = { handles: () => true, async authenticate(token: string) { if (!users[token]) throw new IdentityError('invalid_identity_token', 401); return users[token]; }, async merchantFor() { throw new IdentityError('merchant_not_registered', 403); } } as unknown as PrivyIdentity;
    const app = createApp({ db, chain, identity, relayer: new Relayer(chain, address(1), allowedTargets(address(2), address(3))) });
    const call = async (path: string, token: string, body?: unknown) => { const r = await app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: r.status, body: await r.json() as any }; };
    return { db, keys, call };
  }
  it('lets only the customer with the payment\'s email see and pay it', async () => {
    const f = fixture();
    const payment = (await f.call('/v1/payments', f.keys.secretKey, { amount: '12.50', description: 'Pass', email: 'Ana@Example.test' })).body;
    const page = (token: string) => f.call(`/v1/commerce/orders/${payment.id}/public`, token);
    expect((await page('')).body).toMatchObject({ access: 'sign_in', order: null });
    expect((await page('eve')).body).toMatchObject({ access: 'other', order: null });
    expect((await page('ana')).body).toMatchObject({ access: 'payer', order: { totalMinor: '12500000', description: 'Pass', status: 'open' } });
    expect((await f.call(`/v1/commerce/me/orders/${payment.id}/pay`, 'eve', {})).status).toBe(403);
    expect((await f.call(`/v1/commerce/me/orders/${payment.id}/pay`, 'ana', {})).body).toEqual({ paymentId: payment.id });
    expect((await f.call(`/v1/commerce/me/payments/${payment.id}`, 'ana')).body).toMatchObject({ amountMinor: '12500000' });
    expect((await f.call(`/v1/commerce/me/payments/${payment.id}`, 'eve')).status).toBe(404);
    f.db.close();
  });
  it('keeps link, invoice and product payments off this page', async () => {
    const f = fixture();
    const invoice = (await f.call('/v1/invoices', f.keys.secretKey, { customerEmail: 'ana@example.test', lines: [{ description: 'S', unitAmount: '3', quantity: 1 }], status: 'sent' })).body;
    const invoicePayment = (await f.call('/v1/payments', f.keys.secretKey, { amount: '3', email: 'ana@example.test', metadata: { invoiceId: invoice.id } })).body;
    expect((await f.call(`/v1/commerce/orders/${invoicePayment.id}/public`, 'ana')).status).toBe(404);
    const link = (await f.call('/v1/payment-links', f.keys.secretKey, { kind: 'product', name: 'Audit', amount: '3' })).body;
    const linkPayment = (await f.call(`/v1/commerce/me/links/${link.id}/payments`, 'ana', {})).body;
    expect((await f.call(`/v1/commerce/orders/${linkPayment.paymentId}/public`, 'ana')).status).toBe(404);
    f.db.close();
  });
});
