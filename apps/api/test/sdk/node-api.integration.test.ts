import { afterEach, describe, expect, it } from 'vitest';
import { createPactNodeClient, PactApiError, mandateV2TypedData, sponsorshipConsentV2TypedData, cancellationV2TypedData } from '@pactagent/node';
import { apiFixture, signedCall, signer, merchantSigner, subscriptionV2, v2Mandate } from './api-fixture.js';
const fixtures: ReturnType<typeof apiFixture>[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.close(); });
describe('node wrapper against the real in-process API', () => {
  it('uses injected fetch and preserves signed charge/refund, invoice and status methods', async () => {
    const f = apiFixture(); fixtures.push(f);
    const c = createPactNodeClient({ apiKey: f.keys.secretKey, baseUrl: 'http://sdk.test/', fetch: f.fetcher });
    const p = await c.payments.create({ amount: '2' });
    await c.intents.create(await signedCall(p.id, 9007199254740993n));
    await c.payments.refund(p.id, { amount: '1', ...await signedCall(p.id, 2n, 'refund', 1_000_000n) });
    expect(await c.payments.get(p.id)).toMatchObject({ financialStatus: 'partially_refunded', captured: '2.000000', refunded: '1.000000' });
    const invoice = await c.invoices.create({ amount: '3', customerEmail: 'buyer@example.test' });
    expect((await c.invoices.get(invoice.id)).id).toBe(invoice.id);
    try { await c.payments.get('missing'); throw new Error('Expected API failure'); }
    catch (error) { expect(error).toBeInstanceOf(PactApiError); expect(error).toMatchObject({ status: 404 }); }
  });
  it('re-exports V2 signing helpers and registers/cancels through the actual V2 API', async () => {
    const f = apiFixture(true, false, 2, merchantSigner.address); fixtures.push(f);
    const c = createPactNodeClient({ apiKey: f.keys.secretKey, baseUrl: 'http://sdk.test', fetch: f.fetcher });
    const plan = await c.subscriptions.createPlan({ name: 'Node V2', amount: '2', periodSeconds: 86400 });
    const mandate = v2Mandate(plan.id);
    const deadline = BigInt(Math.floor(Date.now()/1000) + 120);
    const sub = await c.subscriptions.createV2({
      planId: plan.id, mandate, signature: await signer.signTypedData(mandateV2TypedData(mandate, subscriptionV2)),
      merchantConsent: { deadline, signature: await merchantSigner.signTypedData(sponsorshipConsentV2TypedData(mandate, deadline, subscriptionV2)) },
    });
    expect(sub.status).toBe('active');
    await c.subscriptions.cancelV2(sub.id, { deadline, signature: await signer.signTypedData(cancellationV2TypedData(sub.chainId, deadline, subscriptionV2)) });
    expect((await c.subscriptions.list()).data[0].status).toBe('cancelled');
  });
  it('requires explicit endpoint and does not retry ambiguous transport failures', async () => {
    expect(() => createPactNodeClient({ apiKey: '' })).toThrow('key');
    expect(() => createPactNodeClient({ apiKey: 'sk_test' })).toThrow('baseUrl or transport');
    let calls = 0;
    const c = createPactNodeClient({ apiKey: 'sk_test', transport: async () => { calls++; throw new Error('accepted but response lost'); } });
    await expect(c.payments.create({ amount: '2' })).rejects.toThrow('response lost');
    expect(calls).toBe(1);
  });
});
