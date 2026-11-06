import { describe, it, expect } from 'vitest';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { createApp } from '../src/app.js';
import { IdentityError, type PrivyIdentity } from '../src/identity.js';
import { Indexer } from '../src/indexer.js';
import { accountantExport } from '../src/export.js';
import { keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ApprovalService } from '../src/approval.js';
import { intentTypedData } from '../src/typed-data.js';
import type { Intent } from '../src/types.js';
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const payerAccount = privateKeyToAccount(hash(22)), merchantAccount = privateKeyToAccount(hash(11));
function fixture(ready = false) {
  const db = openDb(), chain = new FakeChain(ready), a = seedMerchant(db, merchantAccount.address), b = seedMerchant(db, address(12));
  const identity = { async authenticate(token: string) {
    if (!['payer', 'other'].includes(token)) throw new IdentityError('invalid_identity_token', 401);
    return { userId: `did:privy:${token}`, sessionId: 'session', expiresAt: Math.floor(Date.now() / 1000) + 300, email: '=unsafe@example.test', wallet: { address: token === 'payer' ? payerAccount.address : address(23), id: null } };
  }, async merchantFor() { throw new IdentityError('merchant_not_registered', 403); } } as unknown as PrivyIdentity;
  if (ready) chain.approval.state.allowance = 10_000_000n;
  const approval = new ApprovalService(db, chain, { enabled: ready, escrow: address(2), minimumAmount: 1_000_000n });
  const app = createApp({ db, chain, identity, approval, relayer: new Relayer(chain, address(1), allowedTargets({ escrow: address(2), subscription: address(3) })) });
  const req = (path: string, token = a.secretKey, body?: unknown, method = body === undefined ? 'GET' : 'POST', key = 'checkout-1') => app.request(`/v1/commerce${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const createProduct = async () => (await (await req('/products', a.secretKey, { name: 'Design package', description: 'A complete identity', status: 'active', prices: [{ currency: 'USDT', amountMinor: '2000000' }, { currency: 'USD', amountMinor: '299' }] })).json());
  const buy = async (productId: string, key = 'checkout-1') => req('/checkout-sessions', 'payer', { productId, rail: 'whitechain' }, 'POST', key);
  const poll = async () => { chain.block += 2n; await new Indexer(db, chain).poll(); };
  return { db, chain, a, b, app, req, createProduct, buy, poll };
}
describe('commerce price, ownership and confirmed order contracts', () => {
  it('uses the server price, reserves one payment and rejects request changes', async () => {
    const f = fixture(), p = await f.createProduct();
    expect((await f.req('/checkout-sessions', 'payer', { productId: p.id, rail: 'whitechain', amountMinor: '1' })).status).toBe(400);
    const first = await (await f.buy(p.id)).json(), again = await (await f.buy(p.id)).json();
    expect(again).toEqual(first); expect(first.order.total).toEqual({ currency: 'USDT', amountMinor: '2000000' });
    expect(f.db.prepare('SELECT * FROM payments').all()).toHaveLength(1);
    expect(f.db.prepare('SELECT * FROM commerce_payment_attempts').all()).toHaveLength(1);
    expect((await f.req('/checkout-sessions', 'payer', { productId: p.id, rail: 'stripe' })).status).toBe(409);
    expect(f.db.prepare('SELECT * FROM merchants').all()).toHaveLength(2); // payer session did not onboard a merchant
    const other = await (await f.req('/checkout-sessions', 'other', { productId: p.id, rail: 'whitechain' })).json();
    expect(other.order.id).not.toBe(first.order.id);
  });
  it('preserves revisions and policy after price edits/archive and rejects stale edits', async () => {
    const f = fixture(), p = await f.createProduct(), checkout = await (await f.buy(p.id)).json();
    expect((await f.req(`/products/${p.id}`, f.a.secretKey, { revision: 1, prices: [{ currency: 'USDT', amountMinor: '3000000' }] }, 'PATCH')).status).toBe(200);
    expect((await f.req(`/products/${p.id}`, f.a.secretKey, { revision: 1, name: 'stale' }, 'PATCH')).status).toBe(409);
    await f.req(`/products/${p.id}`, f.a.secretKey, { status: 'archived' }, 'PATCH');
    expect((await f.buy(p.id, 'new-key')).status).toBe(409);
    expect((await f.req(`/catalog/${p.id}`, '')).status).toBe(404);
    const detail = await (await f.req(`/orders/${checkout.order.id}`)).json();
    expect(detail.order.total.amountMinor).toBe('2000000'); expect(detail.product.revision).toBe(1);
    expect(() => f.db.prepare("UPDATE commerce_orders SET amount_minor='1'").run()).toThrow('immutable');
    expect(() => f.db.prepare("DELETE FROM commerce_product_revisions").run()).toThrow('immutable');
    const copy = openDb(f.db.serialize()); expect(copy.prepare('PRAGMA foreign_key_check').all()).toEqual([]); expect(copy.prepare('SELECT * FROM commerce_orders').all()).toHaveLength(1); copy.close();
  });
  it('isolates merchant data, verified payer receipts and signing endpoints', async () => {
    const f = fixture(), p = await f.createProduct(), checkout = await (await f.buy(p.id)).json();
    for (const path of [`/products/${p.id}`, `/orders/${checkout.order.id}`, `/customers/${checkout.order.customerId}`]) expect((await f.req(path, f.b.secretKey)).status).toBe(404);
    expect((await f.req('/products', f.a.publishableKey)).status).toBe(403);
    expect((await f.req('/products', 'payer')).status).toBe(403);
    for (const path of [`/checkout-sessions/${checkout.session.id}`, `/checkout-sessions/${checkout.session.id}/readiness`, `/me/orders/${checkout.order.id}`]) expect((await f.req(path, 'other')).status).toBe(404);
    expect((await f.req(`/checkout-sessions/${checkout.session.id}/intent`, 'other', {})).status).toBe(404);
    expect((await f.req(`/checkout-sessions/${checkout.session.id}/intent`, 'payer', { intent: { signer: address(23), target: address(2) } })).status).toBe(400);
    expect((await f.req(`/me/orders/${checkout.order.id}`, 'payer')).status).toBe(200);
    expect((await (await f.req('/me/orders', 'other')).json()).data).toEqual([]);
    expect((await f.req('/checkout-sessions', f.a.secretKey, { productId: p.id, rail: 'whitechain' })).status).toBe(401);
  });
  it('projects paid/refunded only from confirmed events, deduplicates replay and aggregates beyond pagination', async () => {
    const f = fixture(), p = await f.createProduct(), checkout = await (await f.buy(p.id)).json(), paymentId = checkout.order.paymentId;
    const get = async () => (await (await f.req(`/orders/${checkout.order.id}?success=true`)).json()).order;
    expect((await get()).status).toBe('open');
    f.chain.emit({ id: 'paid', txHash: hash(1), contract: 'escrow', name: 'Charged', args: { id: paymentId, amount: 2_000_000n, payer: payerAccount.address, merchant: merchantAccount.address } });
    await new Indexer(f.db, f.chain).poll(); expect((await get()).status).toBe('open');
    await f.poll(); await f.poll(); expect((await get()).status).toBe('paid');
    expect(f.db.prepare("SELECT * FROM webhook_events WHERE type='order.paid'").all()).toHaveLength(1);
    f.chain.emit({ id: 'refund-1', txHash: hash(2), contract: 'escrow', name: 'Refunded', args: { id: paymentId, amount: 500_000n } });
    await f.poll(); expect((await get()).status).toBe('partially_refunded');
    await f.buy(p.id, 'unpaid-second');
    const customers = await (await f.req('/customers?limit=1')).json();
    expect(customers.data[0]).toMatchObject({ orderCount: 2, totals: [{ currency: 'USDT', amountMinor: '1500000' }] });
    const report = accountantExport(f.db, f.a.merchantId, {}); expect(report.totals.grossUSDT).toBe('1.500000'); expect(report.csv).toContain("'=unsafe");
    f.chain.emit({ id: 'refund-2', txHash: hash(3), contract: 'escrow', name: 'Refunded', args: { id: paymentId, amount: 1_500_000n } });
    await f.poll(); await f.poll(); expect((await get()).status).toBe('refunded');
    expect(f.db.prepare("SELECT * FROM webhook_events WHERE type='order.refunded'").all()).toHaveLength(2);
  });
  it('uses the same durable relayer for an owner-signed charge and refund, with exact retry and confirmed totals', async () => {
    const f = fixture(true); f.chain.collectorEnabled = false; // the Router intent path
    const p = await f.createProduct(), checkout = await (await f.buy(p.id)).json();
    const base = `/checkout-sessions/${checkout.session.id}`;
    const prepareResponse = await f.req(`${base}/intent`, 'payer'); expect(prepareResponse.status).toBe(200);
    const prepared = await prepareResponse.json();
    const asIntent = (v: Record<string, string | number>): Intent => ({ ...v, amount: BigInt(v.amount), nonce: BigInt(v.nonce), deadline: BigInt(v.deadline), maxGas: Number(v.maxGas) }) as Intent;
    const signature = await payerAccount.signTypedData(intentTypedData(asIntent(prepared.intent), address(1)));
    const signed = { data: prepared.data, intent: prepared.intent, signature };
    const sent = await f.req(`${base}/intent`, 'payer', signed); expect(sent.status, await sent.clone().text()).toBe(200);
    const retry = await f.req(`${base}/intent`, 'payer', signed); expect(retry.status).toBe(200); expect(f.chain.sent).toHaveLength(1);
    const detail = await (await f.req(`/orders/${checkout.order.id}`)).json(); expect(detail.order.status).toBe('paid');
    const prepareLegacy = (token: string, body: unknown) => f.app.request(`/v1/payments/${checkout.order.paymentId}/refund-intent`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await prepareLegacy(f.b.secretKey, { amount: '1', reason: 'Wrong merchant' })).status).toBe(404);
    expect((await prepareLegacy(f.a.secretKey, { amount: '1', reason: 'Customer request' })).status).toBe(200);
    expect((await prepareLegacy(f.a.secretKey, { amount: '1', reason: 'Customer request', signer: payerAccount.address })).status).toBe(400);
    const refundResponse = await f.req(`/orders/${checkout.order.id}/refund-intent`, f.a.secretKey, { amount: '1', reason: 'Customer request' }); expect(refundResponse.status).toBe(200);
    const refund = await refundResponse.json();
    const refundSignature = await merchantAccount.signTypedData(intentTypedData(asIntent(refund.intent), address(1)));
    const sendRefund = () => f.app.request(`/v1/payments/${checkout.order.paymentId}/refund`, { method: 'POST', headers: { authorization: `Bearer ${f.a.secretKey}`, 'content-type': 'application/json', 'idempotency-key': 'signed-refund-1' }, body: JSON.stringify({ intent: refund.intent, data: refund.data, signature: refundSignature, amount: refund.amount, reason: refund.reason }) });
    expect((await sendRefund()).status).toBe(200); expect((await sendRefund()).status).toBe(200); expect(f.chain.sent).toHaveLength(2);
    const after = await (await f.req(`/orders/${checkout.order.id}`)).json(); expect(after.order).toMatchObject({ status: 'partially_refunded', refundedMinor: '1000000' });
    expect((await f.req(`/orders/${checkout.order.id}/refund-intent`, f.a.secretKey, { amount: '2', reason: 'Too much' })).status).toBe(400);
    expect(accountantExport(f.db, f.a.merchantId, {}).rows.some(r => r['Order ID'] === checkout.order.id)).toBe(true);
  });
  it('validates catalog inputs and pagination without mutating stored products', async () => {
    const f = fixture();
    for (const change of [{ name: '' }, { imageUrl: 'javascript:alert(1)' }, { imageUrl: '//evil.test/logo' }, { prices: [{ currency: 'USDT', amountMinor: '1.25' }] }, { prices: [{ currency: 'USDT', amountMinor: '-1' }] }, { merchantId: f.b.merchantId }]) expect((await f.req('/products', f.a.secretKey, { name: 'Valid', prices: [{ currency: 'USDT', amountMinor: '2000000' }], ...change })).status).toBe(400);
    expect((await f.req('/products?limit=1000')).status).toBe(400);
    expect(f.db.prepare('SELECT * FROM commerce_products').all()).toHaveLength(0);
  });
});
