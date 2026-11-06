import { subscriptionAbi } from '../../src/chain.js';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeFunctionData, hashTypedData, keccak256, toHex } from 'viem';
import { PactClient, fetchTransport, intentTypedData, mandateTypedData, hashMandate, cancellationTypedData, type SubscriptionRequest } from '@pactagent/core';
import { cancellationTypedData as apiCancel, mandateTypedData as apiMandate } from '../../src/typed-data.js';
import { apiFixture, router, signer, merchantSigner, subscription, v2Mandate } from './api-fixture.js';
const fixtures: ReturnType<typeof apiFixture>[] = [];
function fixture() {
  const f = apiFixture(true, false, merchantSigner.address); fixtures.push(f);
  const client = new PactClient({ apiKey: f.keys.secretKey, transport: fetchTransport('http://sdk.test', f.fetcher) });
  return { ...f, client };
}
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
async function request(c: PactClient, nonce = 0n): Promise<SubscriptionRequest> {
  const plan = await c.subscriptions.createPlan({ name: 'Monthly', amount: '2', periodSeconds: 86400, maxPeriods: 12 });
  const mandate = v2Mandate(plan.id, nonce);
  return { planId: plan.id, mandate, signature: await signer.signTypedData(mandateTypedData(mandate, subscription)) };
}
describe('SDK subscriptions against the real API', () => {
  it('matches the API digests and binds every mandate field and the manager', async () => {
    const f = fixture(), { mandate } = await request(f.client);
    const digest = hashMandate(mandate, subscription);
    expect(digest).toBe(hashTypedData(apiMandate(mandate, subscription)));
    expect(mandateTypedData(mandate, subscription).domain).toMatchObject({ name: 'Settle Subscription', version: '2', chainId: 1874 });
    for (const change of [
      { payer: merchantSigner.address }, { merchant: signer.address }, { planId: keccak256(toHex('other')) },
      { amountCap: mandate.amountCap + 1n }, { periodSeconds: mandate.periodSeconds + 1n },
      { maxPeriods: mandate.maxPeriods + 1 }, { endTime: mandate.endTime + 1n }, { nonce: mandate.nonce + 1n },
    ]) expect(hashMandate({ ...mandate, ...change }, subscription)).not.toBe(digest);
    expect(hashMandate(mandate, merchantSigner.address)).not.toBe(digest);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    expect(hashTypedData(cancellationTypedData(digest, deadline, subscription))).toBe(hashTypedData(apiCancel(digest, deadline, subscription)));
  });
  it('registers from the payer signature alone with exact bigints, renews, then cancels for free', async () => {
    const f = fixture(), c = f.client;
    const nonce = 9007199254740993n;
    f.chain.mandateNonces.set(signer.address.toLowerCase(), nonce);
    const body = await request(c, BigInt((await c.subscriptions.nonce(signer.address)).nonce));
    const created = await c.subscriptions.create(body);
    expect(created.status).toBe('active');
    const sent = JSON.parse(f.requests.at(-1)!.body!);
    expect(sent.mandate.nonce).toBe(nonce.toString());
    expect(sent).not.toHaveProperty('merchantConsent');
    expect(await c.subscriptions.renew(created.id)).toMatchObject({ status: 'charged', refusal: null });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    const signature = await signer.signTypedData(cancellationTypedData(created.chainId, deadline, subscription));
    const pub = new PactClient({ apiKey: f.keys.publishableKey, transport: fetchTransport('http://sdk.test', f.fetcher) });
    expect((await pub.subscriptions.cancel(created.id, { deadline, signature })).status).toBe('submitted');
    expect(JSON.parse(f.requests.at(-1)!.body!)).toEqual({ deadline: deadline.toString(), signature });
    expect((await c.subscriptions.list()).data[0].status).toBe('cancelled');
    expect(f.chain.writer.rows().every(r => r.phase === 'confirmed')).toBe(true);
    await expect(pub.subscriptions.cancel(created.id, { deadline, signature })).rejects.toMatchObject({ status: 422, code: 'cancelled' });
  });
  it('replaces the mandate through a signed Router call and returns the same result on replay', async () => {
    const f = fixture(), c = f.client;
    const original = await c.subscriptions.create(await request(c));
    const body = await request(c, 1n);
    const data = encodeFunctionData({ abi: subscriptionAbi, functionName: 'replace', args: [original.chainId, body.mandate, body.signature] });
    const intent = { signer: signer.address, merchant: merchantSigner.address, target: subscription, dataHash: keccak256(data), amount: body.mandate.amountCap, nonce: 10n, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), maxGas: 500_000 };
    const signed = { planId: body.planId, intent, data, signature: await signer.signTypedData(intentTypedData(intent, router)) };
    const replacement = await c.subscriptions.replace(original.id, signed);
    expect(replacement.replaces).toBe(original.id);
    const subs = (await c.subscriptions.list()).data;
    expect(subs.find(s => s.id === original.id)?.status).toBe('cancelled');
    expect(subs.find(s => s.id === replacement.id)?.status).toBe('active');
    expect((await c.subscriptions.replace(original.id, signed)).id).toBe(replacement.id);
    expect(f.chain.sent).toHaveLength(1);
  });
  it('rejects a mandate signed by anyone but the payer, or for another manager, before any write', async () => {
    const f = fixture(), c = f.client, body = await request(c);
    for (const signature of [
      await merchantSigner.signTypedData(mandateTypedData(body.mandate, subscription)),
      await signer.signTypedData(mandateTypedData(body.mandate, merchantSigner.address)),
      await signer.signTypedData({ ...mandateTypedData(body.mandate, subscription), domain: { ...mandateTypedData(body.mandate, subscription).domain, version: '1' } }),
    ]) await expect(c.subscriptions.create({ ...body, signature })).rejects.toMatchObject({ status: 422, code: 'invalid_signature' });
    expect(f.chain.writer.rows()).toHaveLength(0);
  });
  it('rejects cancellation with wrong signer/contract/id and expired or excessive deadline without writes', async () => {
    const f = fixture(), c = f.client, created = await c.subscriptions.create(await request(c));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    const typed = cancellationTypedData(created.chainId, deadline, subscription);
    for (const signature of [
      await signer.signTypedData({ ...typed, domain: { ...typed.domain, version: '1' } }),
      await signer.signTypedData({ ...typed, domain: { ...typed.domain, chainId: 1 } }),
      await merchantSigner.signTypedData(cancellationTypedData(created.chainId, deadline, subscription)),
      await signer.signTypedData(cancellationTypedData(created.chainId, deadline, merchantSigner.address)),
      await signer.signTypedData(cancellationTypedData(keccak256(toHex('wrong id')), deadline, subscription)),
    ]) await expect(c.subscriptions.cancel(created.id, { deadline, signature })).rejects.toMatchObject({ status: 422, code: 'invalid_signature' });
    for (const invalid of [1n, BigInt(Math.floor(Date.now() / 1000) + 600)]) {
      const signature = await signer.signTypedData(cancellationTypedData(created.chainId, invalid, subscription));
      await expect(c.subscriptions.cancel(created.id, { deadline: invalid, signature })).rejects.toMatchObject({ status: 422, code: 'invalid_cancellation' });
    }
    expect(f.chain.writer.rows()).toHaveLength(1);
    expect((await c.subscriptions.list()).data[0].status).toBe('active');
  });
});
