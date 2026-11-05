import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain } from '../src/chain.js';
import { createApp } from '../src/app.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { Identities } from '../src/identity.js';
import { WalletIdentity } from '../src/wallet-identity.js';

const origin = 'http://localhost:3000';
function fixture(options: { allowLocalEmail?: boolean } = {}) {
  const db = openDb(), chain = new FakeChain(true);
  const wallet = new WalletIdentity(db, { origin, ...options });
  const app = createApp({ db, chain, wallet, identity: new Identities(wallet), relayer: new Relayer(chain, '0x0000000000000000000000000000000000000001', allowedTargets('0x0000000000000000000000000000000000000002', '0x0000000000000000000000000000000000000003')) });
  const call = (path: string, { token, body, method }: { token?: string; body?: unknown; method?: string } = {}) =>
    app.request(path, { method: method ?? (body === undefined ? 'GET' : 'POST'), headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  async function message(account: PrivateKeyAccount, overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {}) {
    const challenge = await (await call('/v1/auth/wallet/nonce', { body: {} })).json();
    return createSiweMessage({ address: account.address, chainId: challenge.chainId, domain: challenge.domain, nonce: challenge.nonce, uri: challenge.uri, version: '1', statement: challenge.statement, issuedAt: new Date(), ...overrides });
  }
  async function signIn(account: PrivateKeyAccount, extra: Record<string, unknown> = {}) {
    const text = await message(account);
    const response = await call('/v1/auth/wallet/verify', { body: { message: text, signature: await account.signMessage({ message: text }), ...extra } });
    return { response, body: await response.json() };
  }
  return { db, app, call, message, signIn };
}

describe('wallet sign-in (EIP-4361)', () => {
  it('issues a session for a signed login message and registers the wallet as a merchant', async () => {
    const f = fixture(), account = privateKeyToAccount(generatePrivateKey());
    const { response, body } = await f.signIn(account);
    expect(response.status).toBe(200);
    expect(body.token).toMatch(/^pact_ws_/);
    expect(body.address).toBe(account.address.toLowerCase());
    const session = await (await f.call('/v1/auth/session', { token: body.token })).json();
    expect(session).toMatchObject({ userId: `wallet:${account.address.toLowerCase()}`, wallet: { address: account.address.toLowerCase() }, email: null, kind: 'wallet' });
    expect((await f.call('/v1/dashboard', { token: body.token })).status).toBe(403);
    const registered = await (await f.call('/v1/auth/merchant', { token: body.token, body: {} })).json();
    expect(registered).toMatchObject({ address: account.address.toLowerCase(), created: true });
    expect((await f.call('/v1/dashboard', { token: body.token })).status).toBe(200);
    expect(await (await f.call('/v1/auth/merchant', { token: body.token, body: {} })).json()).toMatchObject({ merchantId: registered.merchantId, created: false });
    // The token is never stored in clear.
    expect(JSON.stringify(f.db.prepare('SELECT * FROM wallet_sessions').all())).not.toContain(body.token);
  });

  it('keeps each wallet in its own merchant', async () => {
    const f = fixture();
    const a = (await f.signIn(privateKeyToAccount(generatePrivateKey()))).body.token;
    const b = (await f.signIn(privateKeyToAccount(generatePrivateKey()))).body.token;
    for (const token of [a, b]) await f.call('/v1/auth/merchant', { token, body: {} });
    const created = await (await f.call('/v1/payments', { token: a, body: { amount: '5.00', description: 'Only for A' } })).json();
    expect(created.id).toBeTruthy();
    expect((await (await f.call('/v1/payments', { token: a })).json()).data).toHaveLength(1);
    expect((await (await f.call('/v1/payments', { token: b })).json()).data).toHaveLength(0);
    expect((await f.call(`/v1/payments/${created.id}`, { token: b })).status).toBe(404);
  });

  it('binds an existing unbound merchant with the same address', async () => {
    const f = fixture(), account = privateKeyToAccount(generatePrivateKey());
    const seeded = seedMerchant(f.db, account.address.toLowerCase());
    const { body } = await f.signIn(account);
    expect(await (await f.call('/v1/auth/merchant', { token: body.token, body: {} })).json()).toMatchObject({ merchantId: seeded.merchantId, created: false });
  });

  it('refuses replays, other sites, other chains, stale messages and bad signatures', async () => {
    const f = fixture(), account = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
    const verify = async (message: string, signature?: `0x${string}`) =>
      (await f.call('/v1/auth/wallet/verify', { body: { message, signature: signature ?? await account.signMessage({ message }) } })).json();
    const once = await f.message(account);
    expect((await verify(once)).token).toBeTruthy();
    expect((await verify(once)).error.code).toBe('login_nonce_used');
    expect((await verify(await f.message(account, { domain: 'evil.example' }))).error.code).toBe('invalid_login_message');
    expect((await verify(await f.message(account, { uri: 'http://evil.example' }))).error.code).toBe('invalid_login_message');
    expect((await verify(await f.message(account, { chainId: 1 }))).error.code).toBe('invalid_login_message');
    expect((await verify(await f.message(account, { issuedAt: new Date(Date.now() - 3600_000) }))).error.code).toBe('login_message_expired');
    expect((await verify(await f.message(account, { expirationTime: new Date(Date.now() - 1000) }))).error.code).toBe('invalid_login_message');
    expect((await verify(await f.message(account, { nonce: 'madeupnonce123' }))).error.code).toBe('login_nonce_used');
    const text = await f.message(account);
    expect((await verify(text, await other.signMessage({ message: text }))).error.code).toBe('invalid_login_signature');
    expect((await f.call('/v1/auth/session', { token: 'pact_ws_' + 'a'.repeat(43) })).status).toBe(401);
  });

  it('accepts a test email only on a local fork, and logout revokes the session', async () => {
    const strict = fixture();
    expect((await strict.signIn(privateKeyToAccount(generatePrivateKey()), { email: 'buyer@example.test' })).body.error.code).toBe('email_not_allowed');
    const local = fixture({ allowLocalEmail: true });
    const { body } = await local.signIn(privateKeyToAccount(generatePrivateKey()), { email: 'Buyer@Example.test' });
    expect(body.email).toBe('buyer@example.test');
    expect((await (await local.call('/v1/auth/session', { token: body.token })).json()).email).toBe('buyer@example.test');
    expect((await local.call('/v1/auth/logout', { token: body.token, body: {} })).status).toBe(200);
    expect((await local.call('/v1/auth/session', { token: body.token })).status).toBe(401);
  });
});
