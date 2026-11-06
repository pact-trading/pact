import { describe, expect, it } from 'vitest';
import { keccak256, type Address, type Hex } from 'viem';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { createApp } from '../src/app.js';
import { IdentityError, type PrivyIdentity } from '../src/identity.js';
import { Indexer } from '../src/indexer.js';

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const fields = [
  { key: 'company', label: 'Company name', type: 'text', required: true },
  { key: 'seats', label: 'Number of seats', type: 'number' },
  { key: 'terms', label: 'I accept the terms', type: 'checkbox', required: true },
];
function fixture() {
  const db = openDb(), chain = new FakeChain(true), keys = seedMerchant(db, address(11));
  const identity = { async authenticate(token: string) {
    if (token !== 'payer') throw new IdentityError('invalid_identity_token', 401);
    return { userId: 'person-1', sessionId: 'session', expiresAt: Math.floor(Date.now() / 1000) + 300, email: 'buyer@example.test', wallet: { address: address(22), id: null } };
  }, async merchantFor() { throw new IdentityError('merchant_not_registered', 403); } } as unknown as PrivyIdentity;
  const app = createApp({ db, chain, identity, relayer: new Relayer(chain, address(1), allowedTargets({ escrow: address(2), subscription: address(3) })) });
  let keyCount = 0;
  const request = async (path: string, token: string, body?: unknown, method?: string) => {
    const result = await app.request(path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': `key-${++keyCount}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json() as any };
  };
  const product = async () => (await request('/v1/commerce/products', keys.secretKey, { name: 'Widget', description: '', status: 'active', prices: [{ currency: 'USDT', amountMinor: '4000000' }], checkoutFields: fields })).body;
  const settle = async (id: string, amount: bigint) => {
    chain.emit({ id: `paid-${id}`, txHash: keccak256(id as Hex), contract: 'escrow', name: 'Charged', args: { id, amount, merchant: address(11), payer: address(22) } });
    chain.block += 2n; await new Indexer(db, chain).poll();
  };
  const event = (type: string) => JSON.parse((db.prepare('SELECT payload FROM webhook_events WHERE type=?').get(type) as { payload: string }).payload);
  return { db, app, keys, request, product, settle, event };
}
const answers = { company: 'Acme', seats: 3, terms: true };

describe('payment metadata', () => {
  it('round-trips flat metadata from POST /v1/payments into reads and the webhook', async () => {
    const f = fixture();
    const created = await f.request('/v1/payments', f.keys.secretKey, { amount: '2', metadata: { orderId: 'A-1042', seats: 3, gift: false } });
    expect(created.status).toBe(200);
    const metadata = { orderId: 'A-1042', seats: 3, gift: false };
    expect((await f.request(`/v1/payments/${created.body.id}`, f.keys.secretKey)).body.metadata).toEqual(metadata);
    expect((await f.request('/v1/payments', f.keys.secretKey)).body.data[0].metadata).toEqual(metadata);
    await f.settle(created.body.id, 2_000_000n);
    expect(f.event('payment.captured')).toMatchObject({ object_id: created.body.id, metadata, data: { amount: '2.000000', currency: 'USDT', tx_hash: expect.any(String), metadata } });
    f.db.close();
  });
  it('keeps metadata from publishable keys, which may read a payment by id', async () => {
    const f = fixture();
    const created = await f.request('/v1/payments', f.keys.publishableKey, { amount: '2', metadata: { company: 'Acme' } });
    expect(created.status).toBe(200);
    expect((await f.request(`/v1/payments/${created.body.id}`, f.keys.publishableKey)).body).not.toHaveProperty('metadata');
    expect((await f.request(`/v1/payments/${created.body.id}`, f.keys.secretKey)).body.metadata).toEqual({ company: 'Acme' });
    f.db.close();
  });
  it.each([
    ['an array', ['a']],
    ['a nested object', { a: { b: 1 } }],
    ['a null value', { a: null }],
    ['more than 20 keys', Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 1]))],
    ['a value over 500 characters', { a: 'x'.repeat(501) }],
    ['an unsafe key', { 'a.b': 'x' }],
    ['a reserved key', { linkId: 'link_x' }],
    ['a forged manual order', { manualOrder: 'x' }],
    ['a forged discount', { amountGrossMinor: '9' }],
  ])('refuses %s', async (_name, metadata) => {
    const f = fixture();
    const refused = await f.request('/v1/payments', f.keys.secretKey, { amount: '2', metadata });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('invalid_metadata');
    expect(f.db.prepare('SELECT count(*) n FROM payments').get()).toEqual({ n: 0 });
    f.db.close();
  });
  it('accepts exactly 20 keys and 500 characters', async () => {
    const f = fixture();
    const metadata = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, 'x'.repeat(500)]));
    expect((await f.request('/v1/payments', f.keys.secretKey, { amount: '2', metadata })).status).toBe(200);
    f.db.close();
  });
  it('does not let custom metadata count a payment toward a link', async () => {
    const f = fixture();
    const link = (await f.request('/v1/payment-links', f.keys.secretKey, { kind: 'product', name: 'Audit', amount: '3' })).body;
    const created = await f.request('/v1/payments', f.keys.secretKey, { amount: '3', metadata: { note: `"linkId":"${link.id}"` } });
    await f.settle(created.body.id, 3_000_000n);
    expect((await f.request('/v1/payment-links/extras', f.keys.secretKey)).body.data[link.id].payments).toBe(0);
    f.db.close();
  });
});

describe('product checkout fields', () => {
  it('saves fields on the revision, shows them publicly, and carries answers into order.paid', async () => {
    const f = fixture(), product = await f.product();
    expect(product.checkoutFields).toEqual(fields);
    expect((await f.request(`/v1/commerce/catalog/${product.id}`, '')).body.product.checkoutFields).toEqual(fields);
    const checkout = await f.request('/v1/commerce/checkout-sessions', 'payer', { productId: product.id, rail: 'whitechain', metadata: answers });
    expect(checkout.status).toBe(201);
    expect(checkout.body.order.metadata).toEqual(answers);
    const orderId = checkout.body.order.id;
    expect((await f.request(`/v1/commerce/orders/${orderId}`, f.keys.secretKey)).body.order.metadata).toEqual(answers);
    expect((await f.request(`/v1/commerce/me/orders/${orderId}`, 'payer')).body.order.metadata).toEqual(answers);
    await f.settle(checkout.body.order.paymentId, 4_000_000n);
    expect(f.event('order.paid')).toMatchObject({ order: { metadata: answers }, metadata: answers, data: { amount: '4.000000', customer: 'buyer@example.test', metadata: answers } });
    expect(f.event('payment.captured').metadata).toEqual(answers);
    f.db.close();
  });
  it('keeps old orders on the fields they were bought with and can remove fields', async () => {
    const f = fixture(), product = await f.product();
    const changed = await f.request(`/v1/commerce/products/${product.id}`, f.keys.secretKey, { checkoutFields: [] }, 'PATCH');
    expect(changed.status).toBe(200);
    expect(changed.body).not.toHaveProperty('checkoutFields');
    const checkout = await f.request('/v1/commerce/checkout-sessions', 'payer', { productId: product.id, rail: 'whitechain' });
    expect(checkout.status).toBe(201);
    expect(checkout.body.order.metadata).toEqual({});
    f.db.close();
  });
  it.each([
    ['a missing required answer', { company: 'Acme' }, 'checkout_field_required'],
    ['a blank required answer', { company: '  ', terms: true }, 'checkout_field_required'],
    ['an unticked required checkbox', { company: 'Acme', terms: false }, 'checkout_field_required'],
    ['an unknown key', { ...answers, role: 'admin' }, 'invalid_metadata'],
    ['a wrong type', { ...answers, seats: 'three' }, 'invalid_metadata'],
  ])('refuses %s without creating an order', async (_name, metadata, code) => {
    const f = fixture(), product = await f.product();
    const refused = await f.request('/v1/commerce/checkout-sessions', 'payer', { productId: product.id, rail: 'whitechain', metadata });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe(code);
    expect(f.db.prepare('SELECT count(*) n FROM commerce_orders').get()).toEqual({ n: 0 });
    f.db.close();
  });
  it('does not redeem a discount when the answers are refused', async () => {
    const f = fixture(), product = await f.product();
    await f.request('/v1/discounts', f.keys.secretKey, { code: 'SAVE', kind: 'percent', value: '2500', duration: 'once' });
    expect((await f.request('/v1/commerce/checkout-sessions', 'payer', { productId: product.id, rail: 'whitechain', discountCode: 'SAVE' })).status).toBe(422);
    expect(f.db.prepare('SELECT redemptions FROM discounts').get()).toEqual({ redemptions: 0 });
    f.db.close();
  });
  it('refuses reusing an idempotency key with different answers', async () => {
    const f = fixture(), product = await f.product();
    const send = (metadata: unknown) => f.app.request('/v1/commerce/checkout-sessions', { method: 'POST', headers: { authorization: 'Bearer payer', 'content-type': 'application/json', 'idempotency-key': 'same' }, body: JSON.stringify({ productId: product.id, rail: 'whitechain', metadata }) });
    expect((await send(answers)).status).toBe(201);
    expect((await send({ terms: true, seats: 3, company: 'Acme' })).status).toBe(201);
    expect((await send({ ...answers, company: 'Other' })).status).toBe(409);
    expect(f.db.prepare('SELECT count(*) n FROM commerce_orders').get()).toEqual({ n: 1 });
    f.db.close();
  });
  it.each([
    ['too many fields', Array.from({ length: 21 }, (_, i) => ({ key: `k${i}`, label: 'L', type: 'text' }))],
    ['a duplicate key', [{ key: 'a', label: 'A', type: 'text' }, { key: 'a', label: 'B', type: 'text' }]],
    ['an unknown type', [{ key: 'a', label: 'A', type: 'file' }]],
    ['an empty label', [{ key: 'a', label: ' ', type: 'text' }]],
    ['an unsafe key', [{ key: '__proto__', label: 'A', type: 'text' }]],
    ['an extra property', [{ key: 'a', label: 'A', type: 'text', hidden: true }]],
  ])('refuses a definition with %s', async (_name, checkoutFields) => {
    const f = fixture();
    const refused = await f.request('/v1/commerce/products', f.keys.secretKey, { name: 'Widget', description: '', status: 'active', prices: [{ currency: 'USDT', amountMinor: '4000000' }], checkoutFields });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('invalid_checkout_fields');
    f.db.close();
  });
});

describe('payment link checkout fields', () => {
  const link = (f: ReturnType<typeof fixture>) => f.request('/v1/payment-links', f.keys.secretKey, { kind: 'product', name: 'Audit', amount: '3', checkoutFields: fields });
  it('stores fields, shows them on the public link, and carries answers to the dashboard and webhook', async () => {
    const f = fixture(), created = await link(f);
    expect(created.status).toBe(200);
    expect((await f.request(`/v1/commerce/links/${created.body.id}`, '')).body.checkoutFields).toEqual(fields);
    expect((await f.request('/v1/payment-links/extras', f.keys.secretKey)).body.data[created.body.id].checkoutFields).toEqual(fields);
    const payment = await f.request(`/v1/commerce/me/links/${created.body.id}/payments`, 'payer', { metadata: answers });
    expect(payment.status).toBe(201);
    const row = f.db.prepare('SELECT metadata FROM payments WHERE id=?').get(payment.body.paymentId) as { metadata: string };
    expect(JSON.parse(row.metadata)).toMatchObject({ linkId: created.body.id });
    expect(JSON.parse(row.metadata)).not.toHaveProperty('company');
    await f.settle(payment.body.paymentId, 3_000_000n);
    expect((await f.request(`/v1/manual-orders/${payment.body.paymentId}`, f.keys.secretKey)).body.metadata).toEqual(answers);
    expect(f.event('payment.captured').data.metadata).toEqual(answers);
    f.db.close();
  });
  it('refuses a missing required answer and an unsupported subscription link', async () => {
    const f = fixture(), created = await link(f);
    const refused = await f.request(`/v1/commerce/me/links/${created.body.id}/payments`, 'payer', { metadata: { company: 'Acme' } });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('checkout_field_required');
    expect((await f.request('/v1/payment-links', f.keys.secretKey, { kind: 'subscription', name: 'Sub', amount: '3', periodSeconds: 86400, checkoutFields: fields })).body.error.code).toBe('invalid_request');
    f.db.close();
  });
});
