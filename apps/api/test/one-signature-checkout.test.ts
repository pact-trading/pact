import { describe, it, expect } from 'vitest';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { createApp } from '../src/app.js';
import { IdentityError, type PrivyIdentity } from '../src/identity.js';
import { Indexer } from '../src/indexer.js';
import { type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ApprovalService } from '../src/approval.js';
import { USDT_DOMAIN } from '../src/collector.js';

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const payerAccount = privateKeyToAccount(hash(22)), merchantAccount = privateKeyToAccount(hash(11)), stranger = privateKeyToAccount(hash(33));
const escrow = address(2);

function fixture() {
  const db = openDb(), chain = new FakeChain(true), a = seedMerchant(db, merchantAccount.address);
  // A payer with USDT and no allowance at all: one-signature checkout must not need one.
  chain.approval.state = { balance: 10_000_000n, allowance: 0n, nonce: 0n };
  const identity = { async authenticate(token: string) {
    if (token !== 'payer') throw new IdentityError('invalid_identity_token', 401);
    return { userId: 'did:privy:payer', sessionId: 'session', expiresAt: Math.floor(Date.now() / 1000) + 300, email: 'payer@example.test', wallet: { address: payerAccount.address, id: null } };
  }, async merchantFor() { throw new IdentityError('merchant_not_registered', 403); } } as unknown as PrivyIdentity;
  const approval = new ApprovalService(db, chain, { enabled: true, escrow, minimumAmount: 1_000_000n });
  const app = createApp({ db, chain, identity, approval, escrow, relayer: new Relayer(chain, address(1), allowedTargets({ escrow, subscription: address(3) })) });
  const req = (path: string, token: string, body?: unknown) => app.request(`/v1/commerce${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'checkout-1' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const checkout = async () => {
    const product = await (await req('/products', a.secretKey, { name: 'Design package', description: 'Identity', status: 'active', prices: [{ currency: 'USDT', amountMinor: '2000000' }] })).json();
    const session = await (await req('/checkout-sessions', 'payer', { productId: product.id, rail: 'whitechain' })).json();
    return `/checkout-sessions/${session.session.id}`;
  };
  const sign = (offer: { typedData: { domain: object; types: Record<string, unknown>; primaryType: string; message: Record<string, string> } }, account = payerAccount) => {
    const m = offer.typedData.message;
    const typed = { domain: offer.typedData.domain, types: offer.typedData.types, primaryType: 'ReceiveWithAuthorization', message: { ...m, value: BigInt(m.value), validAfter: BigInt(m.validAfter), validBefore: BigInt(m.validBefore) } };
    return (account.signTypedData as (t: unknown) => Promise<Hex>)(typed);
  };
  return { db, chain, a, req, checkout, sign };
}

describe('one-signature checkout (EIP-3009)', () => {
  it('is ready without any allowance, asks for one USDT authorization bound to the payment, and settles it', async () => {
    const f = fixture();
    const base = await f.checkout();
    expect((await (await f.req(`${base}/readiness`, 'payer')).json()).status).toBe('ready');
    const offer = await (await f.req(`${base}/intent`, 'payer')).json();
    expect(offer.intent.kind).toBe('authorization');
    expect(offer.typedData.domain).toEqual({ ...USDT_DOMAIN });
    expect(offer.typedData.primaryType).toBe('ReceiveWithAuthorization');
    expect(offer.typedData.message).toMatchObject({ from: payerAccount.address, to: escrow, value: '2000000', nonce: offer.intent.nonce });
    const sent = await f.req(`${base}/intent`, 'payer', { data: offer.data, intent: offer.intent, signature: await f.sign(offer) });
    expect(sent.status, await sent.clone().text()).toBe(200);
    const result = await sent.json();
    expect(result).toMatchObject({ status: 'submitted' });
    // One transaction, straight to the escrow: no permit, no Router intent.
    expect(f.chain.approval.broadcasts).toHaveLength(0);
    expect(f.chain.sent).toHaveLength(0);
    expect(f.chain.relayed.map(r => r.to)).toEqual([escrow]);
    f.chain.block += 2n; await new Indexer(f.db, f.chain).poll();
    const paid = await (await f.req(base, 'payer')).json();
    expect(paid.order.status).toBe('paid');
    expect(paid.payment).toMatchObject({ financialStatus: 'captured' });
    expect(f.db.prepare("SELECT kind,fee_minor FROM accounting_entries WHERE kind='Payment'").all()).toEqual([{ kind: 'Payment', fee_minor: '150000' }]);
    // Resubmitting the same authorization returns the same submission, never a second charge.
    const again = await (await f.req(`${base}/intent`, 'payer', { data: offer.data, intent: offer.intent, signature: await f.sign(offer) })).json();
    expect(again.id).toBe(result.id);
    expect(f.chain.relayed).toHaveLength(1);
  });
  it('refuses an authorization signed by someone else or for other terms, before anything is sent', async () => {
    const f = fixture();
    const base = await f.checkout();
    const offer = await (await f.req(`${base}/intent`, 'payer')).json();
    const forged = await f.req(`${base}/intent`, 'payer', { data: offer.data, intent: offer.intent, signature: await f.sign(offer, stranger) });
    expect(forged.status).toBe(422);
    expect((await forged.json()).error.code).toBe('invalid_signature');
    // The nonce binds the terms: a different amount or nonce in the posted intent is not accepted.
    const tampered = await f.req(`${base}/intent`, 'payer', { data: offer.data, intent: { ...offer.intent, nonce: hash(99) }, signature: await f.sign(offer) });
    expect(tampered.status).toBe(422);
    expect((await tampered.json()).error.code).toBe('intent_mismatch');
    expect(f.chain.relayed).toHaveLength(0);
    expect(f.db.prepare('SELECT * FROM intents').all()).toHaveLength(0);
  });
  it('lets the payer retry the same authorization after a failure that sent nothing', async () => {
    const f = fixture();
    const base = await f.checkout();
    const offer = await (await f.req(`${base}/intent`, 'payer')).json();
    const body = { data: offer.data, intent: offer.intent, signature: await f.sign(offer) };
    f.chain.relayRevert = 'InvalidPayment'; // the simulation refuses: nothing is signed or sent
    expect((await f.req(`${base}/intent`, 'payer', body)).status).toBe(422);
    f.chain.relayRevert = null;
    const retried = await f.req(`${base}/intent`, 'payer', body);
    expect(retried.status, await retried.clone().text()).toBe(200);
    expect(f.chain.relayed).toHaveLength(1);
  });
});
