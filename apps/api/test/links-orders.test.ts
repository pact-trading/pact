import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain } from '../src/chain.js';
import { createApp } from '../src/app.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { Identities } from '../src/identity.js';
import { WalletIdentity } from '../src/wallet-identity.js';

const router = '0x0000000000000000000000000000000000000001', escrow = '0x0000000000000000000000000000000000000002', subscription = '0x0000000000000000000000000000000000000003';
function fixture() {
  const db = openDb(), chain = new FakeChain(true);
  const keys = seedMerchant(db, '0x00000000000000000000000000000000000000aa');
  const wallet = new WalletIdentity(db, { origin: 'http://localhost:3000', allowLocalEmail: true });
  const app = createApp({ db, chain, wallet, identity: new Identities(wallet), relayer: new Relayer(chain, router, allowedTargets({ escrow: escrow, subscription: subscription })), router, escrow, subscription });
  const call = async (path: string, token: string, body?: unknown) => {
    const r = await app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  const signIn = async (account: PrivateKeyAccount, email: string) => {
    const challenge = (await call('/v1/auth/wallet/nonce', '', {})).body;
    const message = createSiweMessage({ ...challenge, address: account.address, version: '1', issuedAt: new Date() });
    return (await call('/v1/auth/wallet/verify', '', { message, signature: await account.signMessage({ message }), email })).body.token as string;
  };
  return { keys, call, signIn };
}

describe('payment links and manual orders (live mode)', () => {
  it('serves a public link, starts a payer-owned payment and keeps link fields', async () => {
    const f = fixture();
    const link = (await f.call('/v1/payment-links', f.keys.secretKey, { kind: 'product', name: 'Audit', amount: '3', description: 'One-off audit', singleUse: true, expiresOn: '2099-12-31' })).body;
    const extras = (await f.call('/v1/payment-links/extras', f.keys.secretKey)).body.data[link.id];
    expect(extras).toMatchObject({ description: 'One-off audit', singleUse: true, state: 'active', payments: 0 });
    const page = (await f.call(`/v1/commerce/links/${link.id}`, '')).body;
    expect(page).toMatchObject({ name: 'Audit', amountMinor: '3000000', state: 'active', yourPayment: null });
    const token = await f.signIn(privateKeyToAccount(generatePrivateKey()), 'buyer@example.test');
    const started = await f.call(`/v1/commerce/me/links/${link.id}/payments`, token, {});
    expect(started.status).toBe(201);
    expect((await f.call(`/v1/commerce/me/payments/${started.body.paymentId}`, token)).body).toMatchObject({ amountMinor: '3000000', description: 'Audit' });
    await f.call(`/v1/payment-links/${link.id}/deactivate`, f.keys.secretKey, {});
    expect((await f.call(`/v1/commerce/me/links/${link.id}/payments`, token, {})).status).toBe(409);
    await f.call(`/v1/payment-links/${link.id}/reactivate`, f.keys.secretKey, {});
    expect((await f.call(`/v1/commerce/links/${link.id}`, '')).body.state).toBe('active');
  });

  it('creates a manual order only its customer can open and pay', async () => {
    const f = fixture();
    const created = await f.call('/v1/manual-orders', f.keys.secretKey, { customer: { kind: 'new', name: 'Jordan Lee', email: 'jordan@acme.test' }, lines: [{ productId: null, description: 'Consulting', quantity: 2, unitMinor: '1500000' }], note: 'Thanks' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ totalMinor: '3000000', customerEmail: 'jordan@acme.test' });
    const orderId = created.body.orderId;
    expect((await f.call('/v1/manual-orders', f.keys.secretKey)).body.data[0]).toMatchObject({ id: orderId, status: 'open', customerName: 'Jordan Lee' });
    expect((await f.call(`/v1/commerce/orders/${orderId}/public`, '')).body).toMatchObject({ access: 'sign_in', order: null });
    const stranger = await f.signIn(privateKeyToAccount(generatePrivateKey()), 'someone@else.test');
    expect((await f.call(`/v1/commerce/orders/${orderId}/public`, stranger)).body.access).toBe('other');
    expect((await f.call(`/v1/commerce/me/orders/${orderId}/pay`, stranger, {})).status).toBe(403);
    const customer = await f.signIn(privateKeyToAccount(generatePrivateKey()), 'jordan@acme.test');
    expect((await f.call(`/v1/commerce/orders/${orderId}/public`, customer)).body).toMatchObject({ access: 'payer', order: { totalMinor: '3000000', note: 'Thanks' } });
    expect((await f.call(`/v1/commerce/me/orders/${orderId}/pay`, customer, {})).body.paymentId).toBe(orderId);
    expect((await f.call(`/v1/commerce/me/payments/${orderId}`, customer)).status).toBe(200);
    expect((await f.call('/v1/manual-orders', f.keys.secretKey, { customer: { kind: 'new', name: 'X', email: 'x@y.test' }, lines: [{ description: 'Tiny', quantity: 1, unitMinor: '10' }] })).body.error.code).toBe('invalid_total');
  });
});
