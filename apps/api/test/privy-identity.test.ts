import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { PrivyClient } from '@privy-io/node';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain } from '../src/chain.js';
import { createApp } from '../src/app.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { PrivyIdentity, identityConfig } from '../src/identity.js';
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const verificationKey = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const appId = 'test-app', wallet = '0x0000000000000000000000000000000000000011';
function token(overrides: Record<string, unknown> = {}, key = pair.privateKey) {
  const at = Math.floor(Date.now() / 1000);
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  const message = `${b64({ alg: 'ES256', typ: 'JWT' })}.${b64({ iss: 'privy.io', aud: appId, sub: 'did:privy:alice', sid: 'session', iat: at, exp: at + 300, ...overrides })}`;
  return `${message}.${sign('sha256', Buffer.from(message), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
function fixture(enabled = true) {
  const db = openDb(), chain = new FakeChain(true);
  let user: Record<string, unknown> = { id: 'did:privy:alice', created_at: 1, linked_accounts: [{ type: 'email', address: 'alice@example.test', verified_at: 1 }, { type: 'wallet', address: wallet, chain_type: 'ethereum', wallet_client_type: 'privy', connector_type: 'embedded', wallet_index: 0, id: 'wallet-1', user_can_sign: true }] };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin).toBe('https://api.privy.io'); expect(decodeURIComponent(url.pathname)).toBe('/v1/users/did:privy:alice');
    return new Response(JSON.stringify(user), { headers: { 'content-type': 'application/json' } });
  });
  const client = new PrivyClient({ appId, appSecret: 'synthetic-test-secret', jwtVerificationKey: verificationKey, fetch: fetcher, maxRetries: 0 });
  const identity = new PrivyIdentity(db, { appId, appSecret: 'synthetic-test-secret', verificationKey }, client);
  const app = createApp({ db, chain, identity: enabled ? identity : undefined, relayer: new Relayer(chain, '0x0000000000000000000000000000000000000001', allowedTargets({ escrow: '0x0000000000000000000000000000000000000002', subscription: '0x0000000000000000000000000000000000000003' })) });
  const req = (path: string, accessToken = token(), body?: unknown) => app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { app, db, chain, identity, req, fetcher, setUser: (next: Record<string, unknown>) => { user = next; }, user: () => user };
}
describe('Privy verified identity and merchant ownership', () => {
  it('uses verified access token and authoritative embedded wallet, without creating a merchant on session reads', async () => {
    const f = fixture(), response = await f.req('/v1/auth/session');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ userId: 'did:privy:alice', wallet: { address: wallet, id: 'wallet-1' }, email: 'alice@example.test' });
    expect(f.db.prepare('SELECT * FROM merchants').all()).toHaveLength(0);
    expect(f.chain.writer.rows()).toHaveLength(0);
  });
  it('rejects tampered, expired, wrong-app, wrong-issuer and future-issued tokens before user lookups', async () => {
    const f = fixture(), at = Math.floor(Date.now() / 1000);
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    for (const value of [token({ exp: at - 1 }), token({ aud: 'another-app' }), token({ iss: 'attacker.test' }), token({ iat: at + 600 }), token({}, other.privateKey), 'not-a-token']) expect((await f.req('/v1/auth/session', value)).status).toBe(401);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('requires a user-controlled primary embedded Ethereum wallet and matching verified user ID', async () => {
    const f = fixture(), original = f.user();
    for (const linked_accounts of [[], [{ type: 'wallet', address: wallet, chain_type: 'ethereum', wallet_client_type: 'metamask', connector_type: 'injected' }], [{ type: 'wallet', address: wallet, chain_type: 'ethereum', wallet_client_type: 'privy', connector_type: 'embedded', wallet_index: 0, user_can_sign: false }]]) {
      f.setUser({ ...original, linked_accounts }); expect((await f.req('/v1/auth/session')).status).toBe(409);
    }
    f.setUser({ ...original, id: 'did:privy:bob' }); expect((await f.req('/v1/auth/session')).status).toBe(401);
  });
  it('registers once without issuing long-lived secrets and authorizes only its own merchant', async () => {
    const f = fixture();
    expect((await f.req('/v1/payments')).status).toBe(403);
    const response = await f.req('/v1/auth/merchant', token(), {});
    expect(response.status).toBe(200); const merchant = await response.json();
    expect(merchant).toMatchObject({ created: true, address: wallet });
    expect(merchant.secretKey).toBeUndefined();
    expect((await (await f.req('/v1/auth/merchant', token(), {})).json()).created).toBe(false);
    expect(f.db.prepare('SELECT * FROM merchants').all()).toHaveLength(1);
    const payment = await f.req('/v1/payments', token(), { amount: '2' }); expect(payment.status).toBe(200);
    const other = seedMerchant(f.db, '0x0000000000000000000000000000000000000012');
    const otherPayment = await f.req('/v1/payments', other.secretKey, { amount: '3' });
    const list = await (await f.req('/v1/payments')).json(); expect(list.data).toHaveLength(1);
    expect(list.data[0].id).not.toBe((await otherPayment.json()).id);
    expect((await f.req('/v1/api-keys', token(), { kind: 'publishable' })).status).toBe(200);
  });
  it('rejects client-supplied ownership and never auto-claims existing treasury rows', async () => {
    const f = fixture();
    expect((await f.req('/v1/auth/merchant', token(), { address: wallet, email: 'fake@example.test' })).status).toBe(400);
    seedMerchant(f.db, wallet);
    expect((await f.req('/v1/auth/merchant', token(), {})).status).toBe(409);
    expect(f.db.prepare('SELECT * FROM privy_merchants').all()).toHaveLength(0);
  });
  it('fails closed on wallet changes and provider failures without caching a previous identity', async () => {
    const f = fixture(); await f.req('/v1/auth/merchant', token(), {});
    const original = f.user();
    f.setUser({ ...original, linked_accounts: [{ ...(original.linked_accounts as Record<string, unknown>[])[1], address: '0x0000000000000000000000000000000000000099' }] });
    expect((await f.req('/v1/payments')).status).toBe(409);
    f.fetcher.mockRejectedValueOnce(new Error('provider down with secret material'));
    const response = await f.req('/v1/auth/session'); expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain('secret material');
  });
  it('requires complete explicit configuration', () => {
    expect(identityConfig({})).toBeUndefined();
    expect(() => identityConfig({ PRIVY_APP_ID: appId })).toThrow('PRIVY_APP_SECRET');
    expect(identityConfig({ PRIVY_APP_ID: appId, PRIVY_APP_SECRET: 'secret' })).toMatchObject({ appId, appSecret: 'secret' });
  });
  it('keeps concurrent registration idempotent and omits unverified emails', async () => {
    const f = fixture(), original = f.user();
    f.setUser({ ...original, linked_accounts: [(original.linked_accounts as Record<string, unknown>[])[1], { type: 'email', address: 'unverified@example.test', verified_at: 0 }] });
    const responses = await Promise.all(Array.from({ length: 3 }, () => f.req('/v1/auth/merchant', token(), {})));
    const bodies = await Promise.all(responses.map(r => r.json()));
    expect(responses.every(r => r.status === 200)).toBe(true);
    expect(new Set(bodies.map(b => b.merchantId)).size).toBe(1);
    expect(bodies.filter(b => b.created)).toHaveLength(1);
    const session = await f.req('/v1/auth/session');
    expect(session.headers.get('cache-control')).toBe('no-store');
    expect((await session.json()).email).toBeNull();
  });
  it('rejects missing claims, duplicate primary wallets, deleted users and non-Bearer authentication', async () => {
    const f = fixture(), original = f.user();
    expect((await f.app.request('/v1/auth/session', { headers: { authorization: token() } })).status).toBe(401);
    for (const key of ['sub', 'exp', 'iat', 'sid']) expect((await f.req('/v1/auth/session', token({ [key]: undefined }))).status).toBe(401);
    expect(f.fetcher).not.toHaveBeenCalled();
    f.setUser({ ...original, linked_accounts: Array(2).fill((original.linked_accounts as unknown[])[1]) });
    expect((await f.req('/v1/auth/session')).status).toBe(409);
    f.fetcher.mockResolvedValueOnce(new Response('{}', { status: 404 }));
    expect((await f.req('/v1/auth/session')).status).toBe(401);
  });
  it('keeps identity unavailable until configured while preserving API-key integrations', async () => {
    const f = fixture(false), merchant = seedMerchant(f.db, wallet);
    expect((await f.req('/v1/auth/session')).status).toBe(503);
    expect((await f.req('/v1/auth/merchant', token(), {})).status).toBe(503);
    expect((await f.req('/v1/payments')).status).toBe(401);
    expect((await f.req('/v1/payments', merchant.secretKey)).status).toBe(200);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
