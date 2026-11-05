import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { runKeeper } from '../src/keeper.js';
import { Indexer } from '../src/indexer.js';
import { encodeFunctionData } from 'viem';
import { subscriptionAbi } from '../src/chain.js';
import { intentTypedData } from '../src/typed-data.js';
import { KeeperRenewals } from '../src/subscriptions-live.js';

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
  return { db, chain, keys, call, signIn, renewals };
}


const start = new Date('2026-11-06T00:00:00.000Z');
const DAY = 86_400_000;
afterEach(() => vi.useRealTimers());
async function trialFixture(days = 14) {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start);
  const f = await fixture(), customer = privateKeyToAccount(generatePrivateKey());
  const plan = (await f.call('/v1/subscriptions/plans', f.keys.secretKey, { name: 'Trial', amount: '5', periodSeconds: 30 * 86400, maxPeriods: 6, trialDays: days })).body;
  const token = await f.signIn(customer);
  f.chain.approval.state.allowance = 100_000_000n;
  const signMandate = async (ready: any) => customer.signTypedData({ domain: { ...ready.typedData.domain, chainId: Number(ready.typedData.domain.chainId) }, types: { Mandate: ready.typedData.types.Mandate }, primaryType: 'Mandate', message: { ...ready.mandate, amountCap: BigInt(ready.mandate.amountCap), periodSeconds: BigInt(ready.mandate.periodSeconds), endTime: BigInt(ready.mandate.endTime), nonce: BigInt(ready.mandate.nonce) } });
  const subscribe = async (planId = plan.id) => {
    const ready = (await f.call(`/v1/commerce/plans/${planId}/subscription-intent`, token, {})).body;
    return (await f.call(`/v1/commerce/plans/${planId}/subscribe`, token, { mandate: ready.mandate, signature: await signMandate(ready) })).body;
  };
  const created = await subscribe();
  const detail = async () => (await f.call(`/v1/subscriptions/${created.id}`, f.keys.secretKey)).body;
  const signIntent = async (ready: any) => customer.signTypedData({ domain: { ...ready.typedData.domain, chainId: Number(ready.typedData.domain.chainId) }, types: { Intent: ready.typedData.types.Intent }, primaryType: 'Intent', message: Object.fromEntries(Object.entries(ready.typedData.message).map(([k,v]) => [k, ['signer','merchant','target','dataHash'].includes(k) ? v : k === 'maxGas' ? Number(v) : BigInt(v as string)])) as never });
  return { ...f, customer, plan, token, created, subscribe, detail, signMandate, signIntent };
}

describe('free trials', () => {
  it('validates 0..365 whole days and returns trials on all plan reads', async () => {
    const f = await fixture();
    for (const trialDays of [-1,366,1.5,'14',null]) {
      const r = await f.call('/v1/subscriptions/plans', f.keys.secretKey, { name: 'Trial', amount: '5', periodSeconds: 86400, trialDays });
      expect(r.status).toBe(422); expect(r.body.error.code).toBe('invalid_trial_days');
    }
    for (const trialDays of [0,365,'',undefined]) {
      const r = await f.call('/v1/subscriptions/plans', f.keys.secretKey, { name: 'Trial', amount: '5', periodSeconds: 86400, trialDays });
      expect(r.status).toBe(200);
      expect(r.body.trialDays).toBe(typeof trialDays === 'number' ? trialDays : 0);
      expect((await f.call(`/v1/subscriptions/plans/${r.body.id}`, f.keys.secretKey)).body.trialDays).toBe(r.body.trialDays);
      expect((await f.call(`/v1/commerce/plans/${r.body.id}`, '')).body.plan.trialDays).toBe(r.body.trialDays);
    }
    f.db.close();
  });
  it('registers trialing without any charge, preserves end time, and refuses forced early renewal', async () => {
    const f = await trialFixture(), renew = vi.spyOn(f.chain, 'renew');
    const end = new Date(start.getTime() + 14 * DAY).toISOString();
    expect(f.created).toMatchObject({ status: 'trialing', trialEndsAt: end });
    expect(await f.detail()).toMatchObject({ status: 'trialing', trialEndsAt: end, nextChargeAt: end, periodsCharged: 0 });
    expect((await f.call('/v1/commerce/me/subscriptions', f.token)).body.data[0]).toMatchObject({ status: 'trialing', trialEndsAt: end });
    expect((await f.call('/v1/subscriptions', f.keys.secretKey)).body.data[0]).toMatchObject({ status: 'trialing', trialEndsAt: end });
    const event = f.db.prepare("SELECT payload FROM webhook_events WHERE type='subscription.created'").get() as { payload: string };
    expect(JSON.parse(event.payload)).toMatchObject({ status: 'trialing', trialEndsAt: end });
    await runKeeper(f.db, f.chain, start, f.renewals);
    expect(renew).not.toHaveBeenCalled();
    const manual = await f.call(`/v1/subscriptions/${f.created.id}/renew`, f.keys.secretKey, {});
    expect(manual.body.error.code).toBe('too_early');
    await expect(f.renewals.renew(f.created.id, { force: true })).rejects.toMatchObject({ code: 'too_early' });
    expect(renew).not.toHaveBeenCalled(); f.db.close();
  });
  it('charges exactly when the trial ends, then anchors the cycle to that charge', async () => {
    const f = await trialFixture(), renew = vi.spyOn(f.chain, 'renew');
    vi.setSystemTime(start.getTime() + 14 * DAY - 1);
    await runKeeper(f.db, f.chain, new Date(), f.renewals); expect(renew).not.toHaveBeenCalled();
    vi.setSystemTime(start.getTime() + 14 * DAY);
    await runKeeper(f.db, f.chain, new Date(), f.renewals);
    expect(renew).toHaveBeenCalledTimes(1);
    await new Indexer(f.db, f.chain).poll();
    expect(await f.detail()).toMatchObject({ status: 'active', periodsCharged: 1, nextChargeAt: new Date(start.getTime() + 44 * DAY).toISOString() });
    await runKeeper(f.db, f.chain, new Date(), f.renewals); expect(renew).toHaveBeenCalledTimes(1);
    expect(f.db.prepare("SELECT * FROM webhook_events WHERE type='subscription.renewed'").all()).toHaveLength(1); f.db.close();
  });
  it('sends trial_will_end once at three days remaining, even across repeated keeper runs', async () => {
    const f = await trialFixture();
    await runKeeper(f.db, f.chain, new Date(start.getTime() + 11 * DAY - 1), f.renewals);
    expect(f.db.prepare("SELECT * FROM webhook_events WHERE type='subscription.trial_will_end'").all()).toHaveLength(0);
    for (const days of [11,11,12,13]) await runKeeper(f.db, f.chain, new Date(start.getTime() + days * DAY), f.renewals);
    const rows = f.db.prepare("SELECT payload FROM webhook_events WHERE type='subscription.trial_will_end'").all() as { payload: string }[];
    expect(rows).toHaveLength(1); expect(JSON.parse(rows[0].payload).trialEndsAt).toBe(f.created.trialEndsAt);
    f.db.close();
  });
  it('lets the payer cancel a trial and never charges it afterwards', async () => {
    const f = await trialFixture(), renew = vi.spyOn(f.chain, 'renew');
    const ready = (await f.call(`/v1/commerce/me/subscriptions/${f.created.id}/cancel-intent`, f.token, {})).body;
    const result = await f.call(`/v1/commerce/me/subscriptions/${f.created.id}/cancel`, f.token, { intent: ready.intent, data: ready.data, signature: await f.signIntent(ready) });
    expect(result.status).toBe(200); expect((await f.detail()).status).toBe('cancelled');
    vi.setSystemTime(start.getTime() + 20 * DAY);
    await runKeeper(f.db, f.chain, new Date(), f.renewals); expect(renew).not.toHaveBeenCalled();
    expect(f.db.prepare("SELECT * FROM webhook_events WHERE type='subscription.cancelled'").all()).toHaveLength(1);
    f.db.close();
  });
  it('moves a trial into the normal past_due flow on insufficient funds', async () => {
    const f = await trialFixture(); vi.setSystemTime(start.getTime() + 14 * DAY);
    const hash = keccak256('0x1234');
    f.chain.emit({ id: `${hash}:refused`, txHash: hash, contract: 'subscription', name: 'Refused', args: { id: f.created.chainId, reason: 5 } }); f.chain.block += 2n;
    await new Indexer(f.db, f.chain).poll();
    expect(await f.detail()).toMatchObject({ status: 'past_due', retryCount: 0, nextChargeAt: new Date(start.getTime() + 15 * DAY).toISOString() });
    expect(f.db.prepare("SELECT * FROM webhook_events WHERE type='subscription.past_due'").all()).toHaveLength(1); f.db.close();
  });
  it('allows one trial per customer and plan after cancellation', async () => {
    const f = await trialFixture();
    expect((await f.call(`/v1/subscriptions/${f.created.id}/cancel`, f.keys.secretKey, { by: 'merchant' })).status).toBe(200);
    // A customer's history survives a change of wallet.
    f.db.prepare('UPDATE subscriptions SET payer=? WHERE id=?').run(escrow, f.created.id);
    const again = await f.subscribe(); expect(again).toMatchObject({ status: 'active', trialEndsAt: null }); f.db.close();
  });
  it.each(['trial','cancelled'])('blocks generic subscription charge intents for %s subscriptions', async state => {
    const f = await trialFixture();
    if (state === 'cancelled') await f.call(`/v1/subscriptions/${f.created.id}/cancel`, f.keys.secretKey, { by: 'merchant' });
    const data = encodeFunctionData({ abi: subscriptionAbi, functionName: 'charge', args: [f.created.chainId, 5_000_000n] });
    const intent = { signer: merchant.address, merchant: merchant.address, target: subscription as Hex, dataHash: keccak256(data), amount: 5_000_000n, feeUSDT: 10_000n, nonce: 12345n, deadline: BigInt(Math.floor(Date.now()/1000)+300), maxGas: 400_000 };
    const signature = await merchant.signTypedData(intentTypedData(intent, router));
    const r = await f.call('/v1/intents', f.keys.secretKey, { intent, data, signature });
    expect(r.body.error.code).toBe(state === 'trial' ? 'too_early' : 'cancelled');
    expect(f.chain.sent).toHaveLength(0); f.db.close();
  });

  it('does not require a funded balance to approve a free trial', async () => {
    const f = await trialFixture(); f.chain.approval.state.balance = 0n;
    const otherPlan = (await f.call('/v1/subscriptions/plans', f.keys.secretKey, { name: 'Another trial', amount: '5', periodSeconds: 86400, trialDays: 7 })).body;
    const intent = await f.call(`/v1/commerce/plans/${otherPlan.id}/subscription-intent`, f.token, {});
    expect(intent.body.approval.status).toBe('ready'); f.db.close();
  });
  it('makes a pending generic charge visible to merchant cancellation', async () => {
    const f = await trialFixture(0);
    const data = encodeFunctionData({ abi: subscriptionAbi, functionName: 'charge', args: [f.created.chainId, 5_000_000n] });
    const intent = { signer: merchant.address, merchant: merchant.address, target: subscription as Hex, dataHash: keccak256(data), amount: 5_000_000n, feeUSDT: 10_000n, nonce: 12345n, deadline: BigInt(Math.floor(Date.now()/1000)+300), maxGas: 400_000 };
    const signature = await merchant.signTypedData(intentTypedData(intent, router));
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const preparing = new Promise<void>(resolve => { entered = resolve; });
    const original = f.chain.prepareIntent.bind(f.chain);
    vi.spyOn(f.chain, 'prepareIntent').mockImplementation(async (...args) => { entered(); await blocked; return original(...args); });
    const sending = f.call('/v1/intents', f.keys.secretKey, { intent, data, signature });
    await preparing;
    const cancel = await f.call(`/v1/subscriptions/${f.created.id}/cancel`, f.keys.secretKey, { by: 'merchant' });
    expect(cancel.body.error.code).toBe('subscription_pending');
    release(); expect((await sending).status).toBe(200);
    expect(f.chain.sent).toHaveLength(1); f.db.close();
  });
  it('keeps the reminder deduplication after reopening the database', async () => {
    const f = await trialFixture();
    const at = new Date(start.getTime() + 11 * DAY);
    await runKeeper(f.db, f.chain, at, f.renewals);
    const db = openDb(f.db.serialize()), chain = new FakeChain(true);
    chain.writer.bind(db);
    await runKeeper(db, chain, at, new KeeperRenewals(db, chain));
    expect(db.prepare("SELECT * FROM webhook_events WHERE type='subscription.trial_will_end'").all()).toHaveLength(1);
    db.close(); f.db.close();
  });
  it('carries the original trial end through a change to a plan without a trial', async () => {
    const f = await trialFixture();
    await runKeeper(f.db, f.chain, new Date(start.getTime() + 11 * DAY), f.renewals);
    const pro = (await f.call('/v1/subscriptions/plans', f.keys.secretKey, { name: 'Pro', amount: '8', periodSeconds: 86400, maxPeriods: 6 })).body;
    f.chain.approval.state.balance = 0n;
    const ready = (await f.call(`/v1/commerce/me/subscriptions/${f.created.id}/change-intent`, f.token, { planId: pro.id })).body;
    expect(ready.approval.status).toBe('ready');
    const polled = (await f.call(`/v1/commerce/me/subscriptions/${f.created.id}/change-approval/${ready.approvalKey}?planId=${pro.id}`, f.token)).body;
    expect(polled.status).toBe('ready');
    expect(BigInt(ready.mandate.endTime)).toBeGreaterThan(BigInt(Date.parse(f.created.trialEndsAt)/1000));
    const route = (await f.call(`/v1/commerce/me/subscriptions/${f.created.id}/change-route`, f.token, { planId: pro.id, mandate: ready.mandate, signature: await f.signMandate(ready) })).body;
    const changed = await f.call(`/v1/commerce/me/subscriptions/${f.created.id}/change`, f.token, { planId: pro.id, intent: route.intent, data: route.data, signature: await f.signIntent(route) });
    expect(changed.status).toBe(200);
    const detail = (await f.call(`/v1/commerce/me/subscriptions/${changed.body.id}`, f.token)).body;
    expect(detail).toMatchObject({ status: 'trialing', trialEndsAt: f.created.trialEndsAt, nextChargeAt: f.created.trialEndsAt, periodsCharged: 0 });
    await runKeeper(f.db, f.chain, new Date(start.getTime() + 11 * DAY), f.renewals);
    expect(f.db.prepare("SELECT * FROM webhook_events WHERE type='subscription.trial_will_end'").all()).toHaveLength(1);
    f.db.close();
  });
  it('checks trial eligibility by account subject even when the wallet history is empty', async () => {
    const f = await trialFixture();
    expect((await f.call(`/v1/commerce/plans/${f.plan.id}/trial-eligibility`, f.token)).body.trialDays).toBe(0);
    f.db.prepare('UPDATE subscriptions SET payer=? WHERE id=?').run(escrow, f.created.id);
    expect((await f.call(`/v1/commerce/plans/${f.plan.id}/trial-eligibility`, f.token)).body.trialDays).toBe(0);
    f.db.close();
  });
});
