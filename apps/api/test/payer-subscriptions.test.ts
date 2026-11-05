import { describe, expect, it } from 'vitest';
import { keccak256, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain } from '../src/chain.js';
import { createApp } from '../src/app.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { Identities } from '../src/identity.js';
import { WalletIdentity } from '../src/wallet-identity.js';
import { APPROVER, ApprovalService } from '../src/approval.js';
import { KeeperRenewals } from '../src/subscriptions-live.js';
import { updateMerchantSettings } from '../src/merchant-settings.js';

const router = '0x0000000000000000000000000000000000000001', escrow = '0x0000000000000000000000000000000000000002', subscription = '0x0000000000000000000000000000000000000003';
const runtime = '0x60006000' as Hex;
const merchant = privateKeyToAccount(generatePrivateKey());

async function fixture() {
  const db = openDb(), chain = new FakeChain(true);
  const keys = seedMerchant(db, merchant.address.toLowerCase());
  const wallet = new WalletIdentity(db, { origin: 'http://localhost:3000' });
  const relayer = new Relayer(chain, router, allowedTargets(escrow, subscription));
  const approval = new ApprovalService(db, chain, { enabled: true, delegate: APPROVER, runtimeHash: keccak256(runtime), escrow, minimumAmount: 1_000_000n, confirmations: 1n });
  const renewals = new KeeperRenewals(db, chain);
  const app = createApp({ db, chain, relayer, approval, renewals, wallet, identity: new Identities(wallet), router, escrow, subscription });
  const call = async (path: string, token: string, body?: unknown) => {
    const r = await app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body, (_, v) => typeof v === 'bigint' ? v.toString() : v) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  const signIn = async (account: PrivateKeyAccount) => {
    const challenge = (await call('/v1/auth/wallet/nonce', '', {})).body;
    const message = createSiweMessage({ ...challenge, address: account.address, version: '1', issuedAt: new Date() });
    return (await call('/v1/auth/wallet/verify', '', { message, signature: await account.signMessage({ message }) })).body.token as string;
  };
  return { db, chain, keys, call, signIn };
}

describe('customer subscriptions (live mode, SubscriptionManager V1)', () => {
  it('subscribes with a relayed approval and a signed mandate, renews, refuses early and cancels', async () => {
    const f = await fixture(), customer = privateKeyToAccount(generatePrivateKey());
    const plan = (await f.call('/v1/subscriptions/plans', f.keys.secretKey, { name: 'API Growth', description: 'Monthly API access', amount: '5', periodSeconds: 120, maxPeriods: 6 })).body;
    expect(plan).toMatchObject({ name: 'API Growth', description: 'Monthly API access', activeSubscribers: 0, status: 'active' });
    // Public offer for the hosted page.
    expect((await f.call(`/v1/commerce/plans/${plan.id}`, '')).body.plan).toMatchObject({ id: plan.id, amountMinor: '5000000' });

    const token = await f.signIn(customer);
    // Allowance short: the intent asks for the one-time approval first.
    const first = (await f.call(`/v1/commerce/plans/${plan.id}/subscription-intent`, token, {})).body;
    expect(first.approval.status).toBe('needs_approval');
    expect(first.approval.amount).toBe('30000000'); // 6 periods of 5 USDT
    // Once approved (simulated on the fake chain), the same key is ready and the mandate can be signed.
    f.chain.approval.state.allowance = 30_000_000n;
    const ready = (await f.call(`/v1/commerce/plans/${plan.id}/subscription-intent`, token, { approvalKey: first.approvalKey })).body;
    expect(ready.approval.status).toBe('ready');
    const typed = ready.typedData;
    const mandate = { ...ready.mandate, amountCap: BigInt(ready.mandate.amountCap), periodSeconds: BigInt(ready.mandate.periodSeconds), endTime: BigInt(ready.mandate.endTime), nonce: BigInt(ready.mandate.nonce) };
    const signature = await customer.signTypedData({ domain: { ...typed.domain, chainId: Number(typed.domain.chainId) }, types: { Mandate: typed.types.Mandate }, primaryType: 'Mandate', message: mandate });
    const created = await f.call(`/v1/commerce/plans/${plan.id}/subscribe`, token, { mandate: ready.mandate, signature });
    expect(created.status).toBe(201);

    // Another customer cannot submit someone else's mandate.
    const other = await f.signIn(privateKeyToAccount(generatePrivateKey()));
    expect((await f.call(`/v1/commerce/plans/${plan.id}/subscribe`, other, { mandate: ready.mandate, signature })).status).toBe(403);

    const mine = (await f.call('/v1/commerce/me/subscriptions', token)).body.data;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ planId: plan.id, status: 'active', mandate: { amountCap: '5.000000', maxPeriods: 6 } });
    expect((await f.call('/v1/commerce/me/subscriptions', other)).body.data).toHaveLength(0);

    // The merchant's "Run renewal now" goes to the contract and reports its verdict.
    const renewed = (await f.call(`/v1/subscriptions/${created.body.id}/renew`, f.keys.secretKey, {})).body;
    expect(renewed).toMatchObject({ status: 'charged', refusal: null });
    expect(renewed.subscription.periodsCharged).toBe(1);
    expect((await f.call('/v1/subscriptions/plans', f.keys.secretKey)).body.data[0]).toMatchObject({ activeSubscribers: 1 });

    // Customer cancels with a signed intent the relayer sends.
    const intent = (await f.call(`/v1/commerce/me/subscriptions/${created.body.id}/cancel-intent`, token, {})).body;
    const t = intent.typedData;
    const message = Object.fromEntries(Object.entries(t.message).map(([k, v]) => [k, ['signer', 'merchant', 'target', 'dataHash'].includes(k) ? v : k === 'maxGas' ? Number(v) : BigInt(v as string)]));
    const cancelSig = await customer.signTypedData({ domain: { ...t.domain, chainId: Number(t.domain.chainId) }, types: { Intent: t.types.Intent }, primaryType: 'Intent', message: message as never });
    const cancelled = await f.call(`/v1/commerce/me/subscriptions/${created.body.id}/cancel`, token, { intent: intent.intent, data: intent.data, signature: cancelSig });
    expect(cancelled.status).toBe(200);
    expect((await f.call(`/v1/commerce/me/subscriptions/${created.body.id}`, token)).body.status).toBe('cancelled');
  });

  it('changes plan: a new mandate and a signed replace intent, old cancelled and new active', async () => {
    const f = await fixture(), customer = privateKeyToAccount(generatePrivateKey());
    const basic = (await f.call('/v1/subscriptions/plans', f.keys.secretKey, { name: 'Basic', amount: '2', periodSeconds: 120, maxPeriods: 6 })).body;
    const pro = (await f.call('/v1/subscriptions/plans', f.keys.secretKey, { name: 'Pro', amount: '4', periodSeconds: 120, maxPeriods: 6 })).body;
    const token = await f.signIn(customer);
    f.chain.approval.state.allowance = 100_000_000n;
    const signMandate = async (intent: { typedData: { domain: Record<string, unknown>; types: { Mandate: never } }; mandate: Record<string, string> }) => customer.signTypedData({ domain: { ...intent.typedData.domain, chainId: Number(intent.typedData.domain.chainId) } as never, types: { Mandate: intent.typedData.types.Mandate }, primaryType: 'Mandate',
      message: { ...intent.mandate, amountCap: BigInt(intent.mandate.amountCap), periodSeconds: BigInt(intent.mandate.periodSeconds), maxPeriods: Number(intent.mandate.maxPeriods), endTime: BigInt(intent.mandate.endTime), nonce: BigInt(intent.mandate.nonce) } as never });
    const first = (await f.call(`/v1/commerce/plans/${basic.id}/subscription-intent`, token, {})).body;
    const created = (await f.call(`/v1/commerce/plans/${basic.id}/subscribe`, token, { mandate: first.mandate, signature: await signMandate(first) })).body;
    const change = (await f.call(`/v1/commerce/me/subscriptions/${created.id}/change-intent`, token, { planId: pro.id })).body;
    expect(change.approval.status).toBe('ready');
    const route = (await f.call(`/v1/commerce/me/subscriptions/${created.id}/change-route`, token, { planId: pro.id, mandate: change.mandate, signature: await signMandate(change) })).body;
    const t = route.typedData;
    const message = Object.fromEntries(Object.entries(t.message).map(([k, v]) => [k, ['signer', 'merchant', 'target', 'dataHash'].includes(k) ? v : k === 'maxGas' ? Number(v) : BigInt(v as string)]));
    const signature = await customer.signTypedData({ domain: { ...t.domain, chainId: Number(t.domain.chainId) }, types: { Intent: t.types.Intent }, primaryType: 'Intent', message: message as never });
    const replaced = await f.call(`/v1/commerce/me/subscriptions/${created.id}/change`, token, { planId: pro.id, intent: route.intent, data: route.data, signature });
    expect(replaced.status).toBe(200);
    const mine = (await f.call('/v1/commerce/me/subscriptions', token)).body.data as Array<{ planId: string; status: string }>;
    expect(mine.find(s => s.planId === basic.id)?.status).toBe('cancelled');
    expect(mine.find(s => s.planId === pro.id)?.status).toBe('active');
    expect((await f.call(`/v1/commerce/me/subscriptions/${created.id}/change-intent`, token, { planId: basic.id })).status).toBe(409);
  });

  it('archived plans take no new signups but keep their subscribers', async () => {
    const f = await fixture();
    const plan = (await f.call('/v1/subscriptions/plans', f.keys.secretKey, { name: 'Old plan', amount: '2', periodSeconds: 60 })).body;
    expect((await f.call(`/v1/subscriptions/plans/${plan.id}/archive`, f.keys.secretKey, {})).body).toMatchObject({ status: 'archived' });
    const token = await f.signIn(privateKeyToAccount(generatePrivateKey()));
    expect((await f.call(`/v1/commerce/plans/${plan.id}/subscription-intent`, token, {})).body.error.code).toBe('plan_archived');
    expect((await f.call(`/v1/subscriptions/plans/${plan.id}/restore`, f.keys.secretKey, {})).body).toMatchObject({ status: 'active' });
  });

  it('lists active plans only from businesses the customer already uses', async () => {
    const f = await fixture(), customer = privateKeyToAccount(generatePrivateKey());
    updateMerchantSettings(f.db, f.keys.merchantId, { brandName: 'Acme' });
    const growth = (await f.call('/v1/subscriptions/plans', f.keys.secretKey, { name: 'Growth', description: 'More calls', amount: '5', periodSeconds: 86400, trialDays: 14 })).body;
    const old = (await f.call('/v1/subscriptions/plans', f.keys.secretKey, { name: 'Old', amount: '1', periodSeconds: 86400 })).body;
    await f.call(`/v1/subscriptions/plans/${old.id}/archive`, f.keys.secretKey, {});
    // A business this customer never paid: its plans stay out of their list.
    const stranger = seedMerchant(f.db, privateKeyToAccount(generatePrivateKey()).address.toLowerCase());
    await f.call('/v1/subscriptions/plans', stranger.secretKey, { name: 'Elsewhere', amount: '9', periodSeconds: 86400 });

    expect((await f.call('/v1/commerce/me/available-plans', '')).status).toBe(401);
    const token = await f.signIn(customer);
    expect((await f.call('/v1/commerce/me/available-plans', token)).body.data).toEqual([]);

    // A purchase makes them Acme's customer.
    f.db.prepare('INSERT INTO commerce_customers VALUES (?,?,?,?,?,?,?)').run('cus_test', f.keys.merchantId, 'sub_other_login', customer.address.toLowerCase(), null, null, new Date().toISOString());
    const listed = (await f.call('/v1/commerce/me/available-plans', token)).body.data;
    expect(listed).toEqual([{
      plan: expect.objectContaining({ id: growth.id, name: 'Growth', description: 'More calls', amount: '5.000000', periodSeconds: 86400, trialDays: 14, status: 'active' }),
      merchant: { id: f.keys.merchantId, name: 'Acme', logoUrl: null },
    }]);
    // The merchant's own figures never reach a customer.
    expect(listed[0].plan).not.toHaveProperty('activeSubscribers');
    expect(listed[0].plan).not.toHaveProperty('monthlyRecurringMinor');
    // Someone else still sees nothing.
    expect((await f.call('/v1/commerce/me/available-plans', await f.signIn(privateKeyToAccount(generatePrivateKey())))).body.data).toEqual([]);
  });
});
