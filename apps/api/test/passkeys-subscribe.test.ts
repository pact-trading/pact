import { describe, expect, it } from 'vitest';
import { decodeFunctionData, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain, subscriptionAbi } from '../src/chain.js';
import { createApp } from '../src/app.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { Identities } from '../src/identity.js';
import { WalletIdentity } from '../src/wallet-identity.js';
import { ApprovalService } from '../src/approval.js';
import { KeeperRenewals } from '../src/subscriptions-live.js';

const router = '0x0000000000000000000000000000000000000001', escrow = '0x0000000000000000000000000000000000000002', subscription = '0x0000000000000000000000000000000000000003';
const merchant = privateKeyToAccount(generatePrivateKey());
const big = (_: string, v: unknown) => typeof v === 'bigint' ? v.toString() : v;

async function fixture() {
  const db = openDb(), chain = new FakeChain(true);
  const keys = seedMerchant(db, merchant.address.toLowerCase());
  const wallet = new WalletIdentity(db, { origin: 'http://localhost:3000' });
  const relayer = new Relayer(chain, router, allowedTargets({ escrow, subscription }));
  const approval = new ApprovalService(db, chain, { enabled: true, escrow, minimumAmount: 1_000_000n, confirmations: 1n });
  const app = createApp({ db, chain, relayer, approval, renewals: new KeeperRenewals(db, chain), wallet, identity: new Identities(wallet), router, escrow, subscription });
  const call = async (path: string, token: string, body?: unknown) => {
    const r = await app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body, big) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  const signIn = async (account: PrivateKeyAccount) => {
    const challenge = (await call('/v1/auth/wallet/nonce', '', {})).body;
    const message = createSiweMessage({ ...challenge, address: account.address, version: '1', issuedAt: new Date() });
    return (await call('/v1/auth/wallet/verify', '', { message, signature: await account.signMessage({ message }) })).body.token as string;
  };
  return { db, chain, keys, call, signIn };
}
/** Signs a JSON-safe EIP-712 request the API returned, as a wallet would. */
const signJson = (account: PrivateKeyAccount, typed: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }, message: Record<string, unknown>) =>
  (account.signTypedData as (t: unknown) => Promise<Hex>)({ domain: { ...typed.domain, chainId: Number(typed.domain.chainId) }, types: Object.fromEntries(Object.entries(typed.types).filter(([k]) => k !== 'EIP712Domain')), primaryType: typed.primaryType, message });

async function subscribeOffer(f: Awaited<ReturnType<typeof fixture>>, customer: PrivateKeyAccount) {
  const plan = (await f.call('/v1/subscriptions/plans', f.keys.secretKey, { name: 'API Growth', description: 'Monthly', amount: '5', periodSeconds: 120, maxPeriods: 6 })).body;
  const token = await f.signIn(customer);
  f.chain.approval.state = { balance: 100_000_000n, allowance: 0n, nonce: 3n };
  const offer = (await f.call(`/v1/commerce/plans/${plan.id}/subscription-intent`, token, {})).body;
  const mandate = { ...offer.mandate, amountCap: BigInt(offer.mandate.amountCap), periodSeconds: BigInt(offer.mandate.periodSeconds), endTime: BigInt(offer.mandate.endTime), nonce: BigInt(offer.mandate.nonce) };
  return { plan, token, offer, mandate };
}

describe('one-transaction subscribe (subscribeWithPermit)', () => {
  it('offers the mandate and the permit together, then sends one transaction that approves and subscribes', async () => {
    const f = await fixture(), customer = privateKeyToAccount(generatePrivateKey());
    const { plan, token, offer, mandate } = await subscribeOffer(f, customer);
    expect(offer.approval.status).toBe('needs_approval');
    expect(offer.permit).toMatchObject({ value: '30000000', nonce: '3' });
    const signature = await signJson(customer, offer.typedData, mandate);
    const m = offer.permit.typedData.message;
    const permitSignature = await signJson(customer, offer.permit.typedData, { ...m, value: BigInt(m.value), nonce: BigInt(m.nonce), deadline: BigInt(m.deadline) });
    const created = await f.call(`/v1/commerce/plans/${plan.id}/subscribe`, token, { mandate: offer.mandate, signature, permit: { value: offer.permit.value, deadline: offer.permit.deadline, signature: permitSignature } });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // One relayer transaction to the manager; no separate approval transaction.
    expect(f.chain.approval.broadcasts).toHaveLength(0);
    expect(f.chain.relayed).toHaveLength(1);
    const call = decodeFunctionData({ abi: subscriptionAbi, data: f.chain.relayed[0].data });
    expect(call.functionName).toBe('subscribeWithPermit');
    expect(call.args![2]).toBe(30_000_000n);
    expect(f.chain.relayed[0].to).toBe(subscription);
    expect(f.db.prepare('SELECT kind FROM relayer_operations').all()).toEqual([{ kind: 'subscribe' }]);
    expect(created.body.status).toMatch(/active|trialing/);
  });
  it('refuses a permit someone else signed, or for another amount, before anything is sent', async () => {
    const f = await fixture(), customer = privateKeyToAccount(generatePrivateKey()), other = privateKeyToAccount(generatePrivateKey());
    const { plan, token, offer, mandate } = await subscribeOffer(f, customer);
    const signature = await signJson(customer, offer.typedData, mandate);
    const m = offer.permit.typedData.message;
    const forged = await signJson(other, offer.permit.typedData, { ...m, value: BigInt(m.value), nonce: BigInt(m.nonce), deadline: BigInt(m.deadline) });
    const refused = await f.call(`/v1/commerce/plans/${plan.id}/subscribe`, token, { mandate: offer.mandate, signature, permit: { value: offer.permit.value, deadline: offer.permit.deadline, signature: forged } });
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('invalid_permit');
    const tooMuch = await f.call(`/v1/commerce/plans/${plan.id}/subscribe`, token, { mandate: offer.mandate, signature, permit: { value: '999000000', deadline: offer.permit.deadline, signature: forged } });
    expect(tooMuch.body.error.code).toBe('invalid_permit');
    expect(f.chain.relayed).toHaveLength(0);
    // Nothing was reserved: the payer can still subscribe with a correct permit.
    expect(f.db.prepare('SELECT * FROM subscriptions').all()).toHaveLength(0);
    const good = await signJson(customer, offer.permit.typedData, { ...m, value: BigInt(m.value), nonce: BigInt(m.nonce), deadline: BigInt(m.deadline) });
    expect((await f.call(`/v1/commerce/plans/${plan.id}/subscribe`, token, { mandate: offer.mandate, signature, permit: { value: offer.permit.value, deadline: offer.permit.deadline, signature: good } })).status).toBe(201);
  });
  it('keeps the plain subscribe when the allowance already covers the plan', async () => {
    const f = await fixture(), customer = privateKeyToAccount(generatePrivateKey());
    const { plan, token } = await subscribeOffer(f, customer);
    f.chain.approval.state.allowance = 30_000_000n;
    const offer = (await f.call(`/v1/commerce/plans/${plan.id}/subscription-intent`, token, {})).body;
    expect(offer.approval.status).toBe('ready');
    expect(offer.permit).toBeUndefined();
  });
});
