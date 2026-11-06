import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { decodeAbiParameters, decodeFunctionData, keccak256, parseAbi, toHex, type Address, type Hex } from 'viem';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain, MULTICALL3, escrowAbi } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { createApp } from '../src/app.js';
import { IdentityError, type PrivyIdentity } from '../src/identity.js';
import { ApprovalService } from '../src/approval.js';
import { PERMIT2 } from '../src/x402/constants.js';
import { encodeAuth, P256_N, splitDer, verifyAssertion, keyFromSpki, base64url } from '../src/passkeys/webauthn.js';
import { replaySafeHash } from '../src/passkeys/digests.js';
import type { PasskeyChain } from '../src/passkeys/service.js';

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const escrow = address(2), factory = address(0xf1);
const origin = 'http://localhost:3000', rpId = 'localhost';
const customerWallet = address(0xc0ffee);
const sha256 = (...parts: Uint8Array[]) => { const h = createHash('sha256'); for (const p of parts) h.update(p); return new Uint8Array(h.digest()); };

/** A browser's platform authenticator, in miniature: a P-256 key that answers WebAuthn requests. */
function authenticator() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const credentialId = base64url(new Uint8Array(Buffer.from(keccak256(toHex(Math.random().toString())).slice(2, 34), 'hex')));
  return {
    credentialId, privateKey,
    spki: base64url(new Uint8Array(publicKey.export({ format: 'der', type: 'spki' }))),
    register(challenge: string) {
      return { credentialId, publicKey: this.spki, clientDataJSON: base64url(new TextEncoder().encode(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }))) };
    },
    /** `navigator.credentials.get`, then split the DER signature and normalize s, as the web client does. */
    assert(challenge: string, options: { flags?: number; type?: string; key?: KeyObject; highS?: boolean; rp?: string } = {}) {
      const authData = new Uint8Array([...sha256(new TextEncoder().encode(options.rp ?? rpId)), options.flags ?? 0x05, 0, 0, 0, 1]);
      const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: options.type ?? 'webauthn.get', challenge, origin, crossOrigin: false }));
      const der = sign('sha256', Buffer.concat([Buffer.from(authData), Buffer.from(sha256(clientDataJSON))]), options.key ?? privateKey);
      let { r, s } = splitDer(new Uint8Array(der));
      if (options.highS) s = toHex(P256_N - BigInt(s), { size: 32 });
      return JSON.stringify({ credentialId, authenticatorData: base64url(authData), clientDataJSON: base64url(clientDataJSON), r, s });
    },
  };
}

function fixture() {
  const db = openDb(), chain = new FakeChain(true), merchant = seedMerchant(db, address(0xaa));
  const deployed = new Set<string>();
  const accounts: PasskeyChain = {
    accountAddress: async (x, y, salt) => `0x${keccak256(`${x}${y.slice(2)}${toHex(salt, { size: 32 }).slice(2)}` as Hex).slice(26)}` as Address,
    isDeployed: async account => deployed.has(account.toLowerCase()),
  };
  const identity = { async authenticate(token: string) {
    if (token !== 'payer') throw new IdentityError('invalid_identity_token', 401);
    return { userId: 'did:privy:payer', sessionId: 'session', expiresAt: Math.floor(Date.now() / 1000) + 300, email: 'payer@example.test', wallet: { address: customerWallet, id: null } };
  }, async merchantFor() { throw new IdentityError('merchant_not_registered', 403); } } as unknown as PrivyIdentity;
  const approval = new ApprovalService(db, chain, { enabled: true, escrow, minimumAmount: 1_000_000n });
  const app = createApp({ db, chain, identity, approval, escrow, relayer: new Relayer(chain, address(1), allowedTargets({ escrow, subscription: address(3) })),
    passkeys: { chain: accounts, config: { factory, escrow, permit2: PERMIT2, origin, rpId } } });
  const req = async (path: string, token: string, body?: unknown, key = 'checkout-1') => {
    const r = await app.request(`/v1/commerce${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  const device = authenticator();
  const register = async () => {
    const options = (await req('/me/passkey-account/options', 'payer', {})).body;
    expect(options).toMatchObject({ rp: { id: rpId }, pubKeyCredParams: [{ alg: -7 }], authenticatorSelection: { userVerification: 'required' } });
    const created = await req('/me/passkey-account', 'payer', device.register(options.challenge));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    chain.merchantBalances.set(created.body.account.account.toLowerCase(), 50_000_000n);
    return created.body.account.account as Address;
  };
  const checkout = async (key = 'checkout-1') => {
    const product = (await req('/products', merchant.secretKey, { name: 'Design package', description: 'Identity', status: 'active', prices: [{ currency: 'USDT', amountMinor: '2000000' }] }, key)).body;
    const session = (await req('/checkout-sessions', 'payer', { productId: product.id, rail: 'whitechain' }, key)).body;
    return `/checkout-sessions/${session.session.id}/passkey-intent`;
  };
  return { db, chain, req, device, register, checkout, deployed };
}
const multicallAbi = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])']);

describe('passkey accounts', () => {
  it('registers a passkey: stores its P-256 key and the counterfactual account address', async () => {
    const f = fixture();
    const account = await f.register();
    expect(account).toMatch(/^0x[0-9a-f]{40}$/);
    const view = (await f.req('/me/passkey-account', 'payer')).body.account;
    expect(view).toMatchObject({ account, deployed: false, balanceMinor: '50000000' });
    const stored = f.db.prepare('SELECT x,y FROM passkey_accounts').get() as { x: Hex; y: Hex };
    expect(stored).toEqual(keyFromSpki(Buffer.from(f.device.spki, 'base64url')));
    // A replayed or foreign registration challenge is refused.
    expect((await f.req('/me/passkey-account', 'payer', f.device.register('bm90LWlzc3VlZA'))).status).toBe(422);
  });
  it('pays a checkout with one passkey confirmation, deploying the account in the same transaction', async () => {
    const f = fixture();
    const account = await f.register();
    const path = await f.checkout();
    const offer = (await f.req(path, 'payer')).body;
    expect(offer.intent).toMatchObject({ kind: 'passkey', account });
    expect(offer.passkey).toMatchObject({ rpId, userVerification: 'required', allowCredentials: [f.device.credentialId] });
    // The challenge is the account's replay-safe hash of the exact Permit2 witness transfer.
    const { hashTypedData } = await import('viem');
    const typed = offer.typedData;
    const digest = hashTypedData({ ...typed, domain: { ...typed.domain, chainId: Number(typed.domain.chainId) }, message: { ...typed.message, permitted: { ...typed.message.permitted, amount: BigInt(typed.message.permitted.amount) }, nonce: BigInt(typed.message.nonce), deadline: BigInt(typed.message.deadline), witness: { ...typed.message.witness, amount: BigInt(typed.message.witness.amount) } } });
    expect(offer.passkey.challenge).toBe(base64url(Buffer.from(replaySafeHash(account, digest).slice(2), 'hex')));
    expect(typed.message).toMatchObject({ spender: escrow, witness: { payer: account, amount: '2000000' } });

    const sent = await f.req(path, 'payer', { data: offer.data, intent: offer.intent, signature: f.device.assert(offer.passkey.challenge) });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);
    expect(sent.body.status).toBe('submitted');
    // Not deployed yet: one Multicall3 transaction creates the account, then charges through Permit2.
    expect(f.chain.relayed.map(r => r.to)).toEqual([MULTICALL3]);
    const batch = decodeFunctionData({ abi: multicallAbi, data: f.chain.relayed[0].data }).args![0] as readonly { target: Address; callData: Hex }[];
    expect(batch.map(c => c.target)).toEqual([factory, escrow]);
    const charge = decodeFunctionData({ abi: escrowAbi, data: batch[1].callData });
    expect(charge.functionName).toBe('chargeWithPermit2');
    expect((charge.args![0] as { payer: Address }).payer.toLowerCase()).toBe(account.toLowerCase());
    // The signature is abi.encode(WebAuthn.Auth) with UP|UV, low s and the challenge offsets.
    const [auth] = decodeAbiParameters([{ type: 'tuple', components: [{ name: 'authenticatorData', type: 'bytes' }, { name: 'clientDataJSON', type: 'string' }, { name: 'challengeIndex', type: 'uint256' }, { name: 'typeIndex', type: 'uint256' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }] }], charge.args![2] as Hex);
    expect(auth.clientDataJSON.slice(Number(auth.typeIndex), Number(auth.typeIndex) + 21)).toBe('"type":"webauthn.get"');
    expect(auth.clientDataJSON.slice(Number(auth.challengeIndex))).toMatch(new RegExp(`^"challenge":"${offer.passkey.challenge}"`));
    expect(BigInt(auth.s) <= P256_N / 2n).toBe(true);
    // The fake chain settles the Multicall3 batch (deploy, then chargeWithPermit2) at once: the charge is confirmed.
    expect(f.db.prepare('SELECT signer,status FROM intents').get()).toEqual({ signer: account.toLowerCase(), status: 'confirmed' });
    expect(f.db.prepare('SELECT status,captured_minor FROM payments').get()).toEqual({ status: 'captured', captured_minor: '2000000' });
    expect((f.db.prepare('SELECT payer FROM payments').get() as { payer: string }).payer).toBe(account.toLowerCase());
    // The same assertion again is the same submission, never a second charge.
    const again = await f.req(path, 'payer', { data: offer.data, intent: offer.intent, signature: f.device.assert(offer.passkey.challenge) });
    expect(again.body.id).toBe(sent.body.id);
    expect(f.chain.relayed).toHaveLength(1);
  });
  it('charges a deployed account directly at the escrow', async () => {
    const f = fixture();
    const account = await f.register();
    f.deployed.add(account.toLowerCase());
    const path = await f.checkout();
    const offer = (await f.req(path, 'payer')).body;
    expect((await f.req(path, 'payer', { data: offer.data, intent: offer.intent, signature: f.device.assert(offer.passkey.challenge) })).status).toBe(200);
    expect(f.chain.relayed.map(r => r.to)).toEqual([escrow]);
    expect(decodeFunctionData({ abi: escrowAbi, data: f.chain.relayed[0].data }).functionName).toBe('chargeWithPermit2');
  });
  it.each([
    ['a different challenge', { challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, 'challenge_mismatch'],
    ['a high s', { highS: true }, 'high_s'],
    ['no user verification', { flags: 0x01 }, 'user_not_verified'],
    ['another key', { otherKey: true }, 'invalid_signature'],
    ['another site', { rp: 'evil.example' }, 'rp_mismatch'],
    ['a registration instead of an assertion', { type: 'webauthn.create' }, 'invalid_signature'],
  ] as const)('refuses an assertion with %s before anything is sent', async (_name, tamper, code) => {
    const f = fixture();
    await f.register();
    const path = await f.checkout();
    const offer = (await f.req(path, 'payer')).body;
    const t = tamper as { challenge?: string; highS?: boolean; flags?: number; otherKey?: boolean; rp?: string; type?: string };
    const signature = f.device.assert(t.challenge ?? offer.passkey.challenge, { highS: t.highS, flags: t.flags, rp: t.rp, type: t.type, key: t.otherKey ? generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey : undefined });
    const refused = await f.req(path, 'payer', { data: offer.data, intent: offer.intent, signature });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe(code);
    expect(f.chain.relayed).toHaveLength(0);
    expect(f.db.prepare('SELECT * FROM intents').all()).toHaveLength(0);
  });
  it('refuses a payment the account cannot cover, and a customer without a passkey', async () => {
    const f = fixture();
    const path = await f.checkout();
    expect((await f.req(path, 'payer')).body.error.code).toBe('passkey_required');
    const account = await f.register();
    f.chain.merchantBalances.set(account.toLowerCase(), 1_000_000n);
    const offer = (await f.req(path, 'payer')).body;
    const refused = await f.req(path, 'payer', { data: offer.data, intent: offer.intent, signature: f.device.assert(offer.passkey.challenge) });
    expect(refused.body.error.code).toBe('insufficient_funds');
    expect(f.chain.relayed).toHaveLength(0);
  });
});

describe('passkey checkout settlement', () => {
  it('settles the passkey charge from the escrow Charged event, with the account as payer', async () => {
    const { Indexer } = await import('../src/indexer.js');
    const f = fixture();
    const account = await f.register();
    f.deployed.add(account.toLowerCase());
    const path = await f.checkout();
    const offer = (await f.req(path, 'payer')).body;
    const sent = await f.req(path, 'payer', { data: offer.data, intent: offer.intent, signature: f.device.assert(offer.passkey.challenge) });
    const hash = sent.body.txHash as Hex;
    const paymentId = (f.db.prepare('SELECT id FROM payments').get() as { id: Hex }).id;
    f.chain.emit({ id: `${hash}:charge`, txHash: hash, contract: 'escrow', name: 'Charged', args: { id: paymentId, payer: account, merchant: address(0xaa), amount: 2_000_000n, fee: 150_000n, product: 0, refundDeadline: 0n, refundWindow: 86400, feeRecipient: f.chain.feeRecipient } });
    f.chain.block += 2n; await new Indexer(f.db, f.chain, 0n, 1n).poll();
    expect(f.db.prepare('SELECT status,payer FROM payments').get()).toEqual({ status: 'captured', payer: account.toLowerCase() });
    expect(f.db.prepare('SELECT status FROM intents').get()).toEqual({ status: 'confirmed' });
  });
});

describe('WebAuthn encoding', () => {
  it('round-trips WebAuthn.Auth and matches what the account decodes', () => {
    const device = authenticator();
    const challenge = new Uint8Array(32).fill(7);
    const key = keyFromSpki(Buffer.from(device.spki, 'base64url'));
    const auth = verifyAssertion(JSON.parse(device.assert(base64url(challenge))), challenge, key, { origin, rpId });
    const [decoded] = decodeAbiParameters([{ type: 'tuple', components: [{ name: 'authenticatorData', type: 'bytes' }, { name: 'clientDataJSON', type: 'string' }, { name: 'challengeIndex', type: 'uint256' }, { name: 'typeIndex', type: 'uint256' }, { name: 'r', type: 'bytes32' }, { name: 's', type: 'bytes32' }] }], encodeAuth(auth));
    expect(decoded).toEqual(auth);
  });
});
