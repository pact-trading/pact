import { subscriptionV2Abi } from '../../src/chain.js';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeFunctionData, hashTypedData, keccak256, toHex } from 'viem';
import { PactClient, fetchTransport, intentTypedData, mandateTypedData, hashMandate, mandateV2TypedData, hashMandateV2, sponsorshipConsentV2TypedData, cancellationV2TypedData, type SubscriptionV2Request } from '@pactagent/core';
import { cancellationTypedData as apiCancel, consentTypedData as apiConsent, mandateTypedData as apiMandate } from '../../src/typed-data.js';
import { apiFixture, router, signer, merchantSigner, subscriptionV2, v2Mandate } from './api-fixture.js';
const fixtures: ReturnType<typeof apiFixture>[] = [];
function fixture() {
  const f = apiFixture(true, false, 2, merchantSigner.address); fixtures.push(f);
  const client = new PactClient({ apiKey: f.keys.secretKey, transport: fetchTransport('http://sdk.test', f.fetcher) });
  return { ...f, client };
}
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
async function request(c: PactClient, nonce = 0n): Promise<SubscriptionV2Request> {
  const plan = await c.subscriptions.createPlan({ name: 'V2', amount: '2', periodSeconds: 86400, maxPeriods: 12 });
  const mandate = v2Mandate(plan.id, nonce);
  const deadline = BigInt(Math.floor(Date.now()/1000) + 300);
  return { planId: plan.id, mandate, signature: await signer.signTypedData(mandateV2TypedData(mandate, subscriptionV2)), merchantConsent: { deadline, signature: await merchantSigner.signTypedData(sponsorshipConsentV2TypedData(mandate, deadline, subscriptionV2)) } };
}
describe('explicit SDK V2 against the real API', () => {
  it('matches API digests, preserves V1 domains and binds every consent field', async () => {
    const f = fixture(), body = await request(f.client), { mandate, merchantConsent } = body;
    const v2 = hashMandateV2(mandate, subscriptionV2);
    expect(v2).toBe(hashTypedData(apiMandate(mandate, subscriptionV2, '2')));
    expect(hashMandate(mandate, subscriptionV2)).toBe(hashTypedData(apiMandate(mandate, subscriptionV2)));
    expect(hashMandate(mandate, subscriptionV2)).not.toBe(v2);
    const consent = sponsorshipConsentV2TypedData(mandate, merchantConsent.deadline, subscriptionV2);
    expect(consent.message.mandateHash).toBe(v2);
    expect(hashTypedData(consent)).toBe(hashTypedData(apiConsent(v2, merchantConsent.deadline, subscriptionV2)));
    for (const change of [
      { payer: merchantSigner.address }, { merchant: signer.address }, { planId: keccak256(toHex('other')) },
      { amountCap: mandate.amountCap + 1n }, { periodSeconds: mandate.periodSeconds + 1n },
      { maxPeriods: mandate.maxPeriods + 1 }, { endTime: mandate.endTime + 1n }, { nonce: mandate.nonce + 1n },
    ]) expect(hashTypedData(sponsorshipConsentV2TypedData({ ...mandate, ...change }, merchantConsent.deadline, subscriptionV2))).not.toBe(hashTypedData(consent));
    expect(hashTypedData(sponsorshipConsentV2TypedData(mandate, merchantConsent.deadline + 1n, subscriptionV2))).not.toBe(hashTypedData(consent));
    expect(hashTypedData(sponsorshipConsentV2TypedData(mandate, merchantConsent.deadline, merchantSigner.address))).not.toBe(hashTypedData(consent));
    expect(hashTypedData(cancellationV2TypedData(v2, merchantConsent.deadline, subscriptionV2))).toBe(hashTypedData(apiCancel(v2, merchantConsent.deadline, subscriptionV2)));
  });
  it('registers with two signers and exact bigints, rejects unconfigured renewal, then cancels with an empty tank', async () => {
    const f = fixture(), c = f.client;
    const nonce = 9007199254740993n;
    f.chain.mandateNonces.set(signer.address.toLowerCase(), nonce);
    const body = await request(c, BigInt((await c.subscriptions.nonce(signer.address)).nonce));
    const created = await c.subscriptions.createV2(body);
    expect(created.status).toBe('active');
    const sent = JSON.parse(f.requests.at(-1)!.body!);
    expect(sent.mandate.nonce).toBe(nonce.toString());
    expect(sent.merchantConsent.deadline).toBe(body.merchantConsent.deadline.toString());
    await expect(c.subscriptions.renew(created.id)).rejects.toMatchObject({ status: 422, code: 'automatic_funded_renewal_disabled' });
    expect(await c.subscriptions.renewalStatus(created.id)).toMatchObject({ state: 'disabled' });
    f.chain.tank.set(merchantSigner.address.toLowerCase(), { balanceWei: 0n, dailyCapWei: 0n, spentTodayWei: 0n });
    const deadline = BigInt(Math.floor(Date.now()/1000) + 120);
    const signature = await signer.signTypedData(cancellationV2TypedData(created.chainId, deadline, subscriptionV2));
    const pub = new PactClient({ apiKey: f.keys.publishableKey, transport: fetchTransport('http://sdk.test', f.fetcher) });
    expect((await pub.subscriptions.cancelV2(created.id, { deadline, signature })).status).toBe('submitted');
    expect(JSON.parse(f.requests.at(-1)!.body!)).toEqual({ deadline: deadline.toString(), signature });
    expect((await c.subscriptions.list()).data[0].status).toBe('cancelled');
    expect(f.chain.writer.rows().every(r => r.phase === 'confirmed')).toBe(true);
    await expect(pub.subscriptions.cancelV2(created.id, { deadline, signature })).rejects.toMatchObject({ status: 422, code: 'cancelled' });
  });
  it('replaces the mandate through a signed Router call and returns the same result on replay', async () => {
    const f = fixture(), c = f.client;
    const original = await c.subscriptions.createV2(await request(c));
    const body = await request(c, 1n);
    const data = encodeFunctionData({ abi: subscriptionV2Abi, functionName: 'replace', args: [original.chainId, body.mandate, body.signature, body.merchantConsent.deadline, body.merchantConsent.signature] });
    const intent = { signer: signer.address, merchant: merchantSigner.address, target: subscriptionV2, dataHash: keccak256(data), amount: body.mandate.amountCap, feeUSDT: 10_000n, nonce: 10n, deadline: body.merchantConsent.deadline, maxGas: 500_000 };
    const signed = { planId: body.planId, intent, data, signature: await signer.signTypedData(intentTypedData(intent, router)) };
    const replacement = await c.subscriptions.replace(original.id, signed);
    expect(replacement.replaces).toBe(original.id);
    const subs = (await c.subscriptions.list()).data;
    expect(subs.find(s => s.id === original.id)?.status).toBe('cancelled');
    expect(subs.find(s => s.id === replacement.id)?.status).toBe('active');
    expect((await c.subscriptions.replace(original.id, signed)).id).toBe(replacement.id);
    expect(f.chain.sent).toHaveLength(1);
  });
  it('rejects missing consent locally, wrong consent, changed deadline and V1 signatures before any write', async () => {
    const f = fixture(), c = f.client, body = await request(c);
    const { merchantConsent: _consent, ...v1Body } = body;
    // @ts-expect-error V2 requires a signed merchant consent even when V1 types compile.
    expect(() => c.subscriptions.createV2(v1Body)).toThrow('Merchant consent');
    for (const invalid of [
      { ...body, merchantConsent: { ...body.merchantConsent, signature: await signer.signTypedData(sponsorshipConsentV2TypedData(body.mandate, body.merchantConsent.deadline, subscriptionV2)) } },
      { ...body, merchantConsent: { ...body.merchantConsent, deadline: body.merchantConsent.deadline - 1n } },
      { ...body, merchantConsent: { ...body.merchantConsent, deadline: 1n } },
    ]) await expect(c.subscriptions.createV2(invalid)).rejects.toMatchObject({ status: 422, code: 'invalid_merchant_consent' });
    await expect(c.subscriptions.createV2({ ...body, signature: await signer.signTypedData(mandateTypedData(body.mandate, subscriptionV2)) })).rejects.toMatchObject({ status: 422, code: 'invalid_signature' });
    expect(f.chain.writer.rows()).toHaveLength(0);
  });
  it('rejects cancellation with wrong signer/contract/id and expired or excessive deadline without writes', async () => {
    const f = fixture(), c = f.client, created = await c.subscriptions.createV2(await request(c));
    const deadline = BigInt(Math.floor(Date.now()/1000) + 120);
    const typed = cancellationV2TypedData(created.chainId, deadline, subscriptionV2);
    for (const signature of [
      await signer.signTypedData({ ...typed, domain: { ...typed.domain, version: '1' } }),
      await signer.signTypedData({ ...typed, domain: { ...typed.domain, chainId: 1 } }),
      await merchantSigner.signTypedData(cancellationV2TypedData(created.chainId, deadline, subscriptionV2)),
      await signer.signTypedData(cancellationV2TypedData(created.chainId, deadline, merchantSigner.address)),
      await signer.signTypedData(cancellationV2TypedData(keccak256(toHex('wrong id')), deadline, subscriptionV2)),
    ]) await expect(c.subscriptions.cancelV2(created.id, { deadline, signature })).rejects.toMatchObject({ status: 422, code: 'invalid_signature' });
    for (const invalid of [1n, BigInt(Math.floor(Date.now()/1000) + 600)]) {
      const signature = await signer.signTypedData(cancellationV2TypedData(created.chainId, invalid, subscriptionV2));
      await expect(c.subscriptions.cancelV2(created.id, { deadline: invalid, signature })).rejects.toMatchObject({ status: 422, code: 'invalid_cancellation' });
    }
    expect(f.chain.writer.rows()).toHaveLength(1);
    expect((await c.subscriptions.list()).data[0].status).toBe('active');
  });
});
