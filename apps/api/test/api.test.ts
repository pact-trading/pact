import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, keccak256, parseUnits, toHex, type Address, type Hex } from 'viem';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain, escrowAbi, subscriptionAbi } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { createApp } from '../src/app.js';
import { Indexer } from '../src/indexer.js';
import { deliverWebhooks, signWebhook } from '../src/webhooks.js';
import { cancellationTypedData, intentTypedData, mandateTypedData } from '../src/typed-data.js';
import { runLegacyTestKeeper as runKeeper } from './helpers/legacy-keeper.js';

const router = '0x0000000000000000000000000000000000000001' as Address;
const escrow = '0x0000000000000000000000000000000000000002' as Address;
const subscription = '0x0000000000000000000000000000000000000003' as Address;
const merchant = '0x0000000000000000000000000000000000000004' as Address;
const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
function fixture(merchantAddress = merchant, autoSettle = false) {
  const db = openDb();
  const chain = new FakeChain(autoSettle);
  chain.accepted.set(merchantAddress.toLowerCase(), 1);
  // Refunds pay their gas in USDT on top: the merchant holds USDT and allows the Router.
  chain.approval.state = { balance: 100_000_000n, allowance: 2n ** 256n - 1n, nonce: 0n };
  const keys = seedMerchant(db, merchantAddress, { webhookUrl: 'https://example.test/hook', webhookSecret: 'whsec_test' });
  const relayer = new Relayer(chain, router, allowedTargets({ escrow: escrow, subscription: subscription }));
  const app = createApp({ db, chain, relayer });
  const post = (path: string, body: unknown, key = keys.secretKey, idem?: string) => app.request(path, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': idem } : {}) }, body: JSON.stringify(body, (_, value: unknown) => typeof value === 'bigint' ? value.toString() : value) });
  const get = (path: string, key = keys.secretKey) => app.request(path, { headers: { authorization: `Bearer ${key}` } });
  return { db, chain, keys, app, post, get };
}
async function signed(paymentId: Hex, nonce: bigint, merchantAddress = merchant) {
  const data = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [paymentId, merchantAddress, 2_000_000n, 2_592_000n] });
  const intent = { signer: account.address, merchant: merchantAddress, target: escrow, dataHash: keccak256(data), amount: 2_000_000n, nonce, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), maxGas: 300_000 };
  const signature = await account.signTypedData(intentTypedData(intent, router));
  return { intent: JSON.parse(JSON.stringify(intent, (_, x: unknown) => typeof x === 'bigint' ? x.toString() : x)), signature, data };
}

describe('Settle API', () => {
  it('creates, resolves and deactivates merchant payment links', async () => {
    const f = fixture();
    expect((await f.post('/v1/payment-links', { kind: 'product', name: 'GOL product', amount: '4.25' }, f.keys.publishableKey)).status).toBe(403);
    expect((await f.get('/v1/payment-links', f.keys.publishableKey)).status).toBe(403);
    const created = await f.post('/v1/payment-links', { kind: 'product', name: 'GOL product', amount: '4.25' }, f.keys.secretKey, 'link-1');
    expect(created.status).toBe(200);
    const link = await created.json();
    expect(link.amount).toBe('4.250000');
    expect(link.url).toMatch(new RegExp(`/l/${link.id}$`));
    expect((await (await f.post('/v1/payment-links', { kind: 'product', name: 'GOL product', amount: '4.25' }, f.keys.secretKey, 'link-1')).json()).id).toBe(link.id);
    expect((await f.get(`/v1/payment-links/${link.id}`, f.keys.publishableKey)).status).toBe(200);
    expect((await (await f.get('/v1/payment-links')).json()).data[0].visits).toBe(1);
    const payment = await f.post('/v1/payments', { amount: '4.25', description: link.name, metadata: { paymentLinkId: link.id } });
    expect(payment.status).toBe(200);
    expect((await payment.json()).amount).toBe('4.250000');
    const tip = await (await f.post('/v1/payment-links', { kind: 'tip', name: 'GOL tip' })).json();
    expect(tip.amount).toBeNull();
    const unsupportedSubscription = await f.post('/v1/payment-links', { kind: 'subscription', name: 'GOL plan', amount: '2', periodSeconds: 2592000 });
    expect(unsupportedSubscription.status).toBe(400);
    expect((await unsupportedSubscription.json()).error.message).toMatch(/plan subscribe URL/);
    expect((await f.post('/v1/payment-links', { kind: 'subscription', name: 'Invalid', amount: '2', periodSeconds: 0 })).status).toBe(400);
    f.db.prepare('INSERT INTO payment_links(id,merchant_id,kind,name,amount_minor,period_seconds,status,visits,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('link_legacy_subscription', f.keys.merchantId, 'subscription', 'Old plan link', '2000000', 2592000, 'active', 0, new Date().toISOString());
    expect((await (await f.get('/v1/payment-links')).json()).data.some((item: { id: string }) => item.id === 'link_legacy_subscription')).toBe(false);
    expect((await f.get('/v1/payment-links/link_legacy_subscription')).status).toBe(410);
    expect((await f.post('/v1/payment-links/link_legacy_subscription/reactivate', {})).status).toBe(404);
    expect((await f.post(`/v1/payment-links/${link.id}/deactivate`, {}, f.keys.publishableKey)).status).toBe(403);
    expect((await f.post(`/v1/payment-links/${link.id}/deactivate`, {})).status).toBe(200);
    expect((await f.get(`/v1/payment-links/${link.id}`, f.keys.publishableKey)).status).toBe(410);
    expect((await f.post('/v1/payments', { amount: '4.25', metadata: { paymentLinkId: link.id } })).status).toBe(422);
    expect((await (await f.get('/v1/payment-links')).json()).data.find((item: { id: string }) => item.id === link.id).status).toBe('inactive');
    const other = fixture();
    expect((await other.get(`/v1/payment-links/${link.id}`)).status).toBe(404);
  });
  it('captures and refunds on the offline adapter, including the final refusal', async () => {
    const merchantSigner = privateKeyToAccount(`0x${'3'.repeat(64)}`);
    const f = fixture(merchantSigner.address, true);
    const payment = await (await f.post('/v1/payments', { amount: '2.000000' })).json() as { id: Hex };
    expect((await f.post('/v1/intents', await signed(payment.id, 1n, merchantSigner.address), f.keys.publishableKey)).status).toBe(200);
    expect((await (await f.get(`/v1/payments/${payment.id}`)).json()).financialStatus).toBe('captured');
    for (const [index, amount] of ['1.000000', '1.000000', '1.000000'].entries()) {
      const data = encodeFunctionData({ abi: escrowAbi, functionName: 'refund', args: [payment.id, parseUnits(amount, 6), keccak256(toHex('Customer request'))] });
      const intent = { signer: merchantSigner.address, merchant: merchantSigner.address, target: escrow, dataHash: keccak256(data), amount: parseUnits(amount, 6), nonce: BigInt(index + 2), deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), maxGas: 300_000 };
      const signature = await merchantSigner.signTypedData(intentTypedData(intent, router));
      const response = await f.post(`/v1/payments/${payment.id}/refund`, { amount, reason: 'Customer request', intent, signature, data });
      expect(response.status).toBe(index === 2 ? 422 : 200);
      if (index === 2) expect((await response.json()).error.code).toBe('refund_limit');
    }
    expect((await (await f.get(`/v1/payments/${payment.id}`)).json()).financialStatus).toBe('refunded');
    expect((await (await f.get('/v1/refunds')).json()).data).toHaveLength(2);
    expect((await (await f.get('/v1/refusals')).json()).data[0].reason).toBe('refund_limit');
  });
  it('registers a signed mandate, renews it, records an early refusal and cancels', async () => {
    const merchantSigner = privateKeyToAccount(`0x${'3'.repeat(64)}`);
    const f = fixture(merchantSigner.address, true);
    const plan = await (await f.post('/v1/subscriptions/plans', { name: 'Monthly', amount: '2', periodSeconds: 86400, maxPeriods: 12 })).json() as { id: string };
    const publicPlan = await f.get(`/v1/subscriptions/plans/${plan.id}`, f.keys.publishableKey);
    expect(publicPlan.status).toBe(200);
    expect((await publicPlan.json()).amount).toBe('2.000000');
    expect((await f.get('/v1/subscriptions/plans/plan_unknown', f.keys.publishableKey)).status).toBe(404);
    const mandate = { payer: account.address, merchant: merchantSigner.address, planId: keccak256(toHex(plan.id)), amountCap: 2_000_000n, periodSeconds: 86400n, maxPeriods: 12, endTime: BigInt(Math.floor(Date.now()/1000)+86400*13), nonce: 0n };
    const signature = await account.signTypedData(mandateTypedData(mandate, subscription));
    const created = await f.post('/v1/subscriptions', { planId: plan.id, mandate, signature }, f.keys.publishableKey);
    expect(created.status).toBe(200);
    const sub = await created.json() as { id: string; chainId: Hex };
    expect((await (await f.get('/v1/subscriptions')).json()).data[0].status).toBe('active');
    await runKeeper(f.db, f.chain);
    await new Indexer(f.db, f.chain).poll();
    // "Run renewal now" goes to the contract, which refuses a second pull in the same period.
    f.chain.renewalRefusals.push(2);
    const early = await f.post(`/v1/subscriptions/${sub.id}/renew`, {});
    expect(early.status).toBe(200);
    expect(await early.json()).toMatchObject({ status: 'refused', refusal: 'too_early' });
    expect((await (await f.get('/v1/refusals')).json()).data[0].reason).toBe('too_early');
    // The payer signs a Cancel message and Pact's relayer submits it.
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    const cancelSignature = await account.signTypedData(cancellationTypedData(sub.chainId, deadline, subscription));
    expect((await f.post(`/v1/subscriptions/${sub.id}/cancel`, { deadline, signature: cancelSignature }, f.keys.publishableKey)).status).toBe(200);
    expect((await (await f.get('/v1/subscriptions')).json()).data[0].status).toBe('cancelled');
    // A pull after the payer cancelled is refused by the contract, and recorded.
    const cancelledRenewal = await f.post(`/v1/subscriptions/${sub.id}/renew`, {});
    expect(await cancelledRenewal.json()).toMatchObject({ status: 'refused', refusal: 'cancelled' });
    const reasons = (await (await f.get('/v1/refusals')).json()).data.filter((item: {objectId:string}) => item.objectId === sub.id).map((item: {reason:string}) => item.reason);
    expect(reasons).toEqual(expect.arrayContaining(['too_early', 'cancelled']));
  });
  it('scopes keys, deduplicates create and never marks a payment paid before confirmation', async () => {
    const f = fixture();
    const input = { amount: '2.000000', email: 'a@example.com' };
    const first = await f.post('/v1/payments', input, f.keys.publishableKey, 'order-1');
    expect(first.status).toBe(200);
    const p = await first.json() as { id: Hex; financialStatus: string };
    expect((await (await f.post('/v1/payments', input, f.keys.publishableKey, 'order-1')).json()).id).toBe(p.id);
    expect((await f.post('/v1/payments', { amount: '3' }, f.keys.publishableKey, 'order-1')).status).toBe(409);
    expect((await f.get('/v1/export', f.keys.publishableKey)).status).toBe(403);
    expect((await (await f.get(`/v1/payments/${p.id}`)).json()).financialStatus).toBe('open');
    f.chain.emit({ id: 'e1', txHash: `0x${'a'.repeat(64)}`, contract: 'escrow', name: 'Charged', args: { id: p.id, payer: account.address, merchant, amount: 2_000_000n } });
    f.chain.block += 2n;
    expect(await new Indexer(f.db, f.chain).poll()).toBe(1);
    expect(await new Indexer(f.db, f.chain).poll()).toBe(0);
    expect((await (await f.get(`/v1/payments/${p.id}`)).json()).financialStatus).toBe('captured');
    const exportData = await (await f.get('/v1/export?from=2020-01-01&to=2100-01-01&format=json')).json() as { rows: unknown[]; totals: { netUSDT: string } };
    expect(exportData.totals.netUSDT).toBe('2.000000');
    expect(exportData.rows).toHaveLength(1);
    expect((await (await f.post(`/v1/payments/${p.id}/refund`, { amount: '3' })).json()).error.code).toBe('refund_limit');
    expect((await (await f.post(`/v1/payments/${p.id}/refund`, { amount: '1' })).json()).error.code).toBe('signed_intent_required');
    expect((await f.get('/v1/export?from=2020-01-01&to=2100-01-01&format=csv')).status).toBe(200);
  });
  it('checks a signed intent, replay and drain guards before sending', async () => {
    const f = fixture();
    const p = await (await f.post('/v1/payments', { amount: '2' })).json() as { id: Hex };
    const request = await signed(p.id, 1n);
    expect((await f.post('/v1/intents', request)).status).toBe(200);
    expect(f.chain.sent).toHaveLength(1);
    const duplicate = await f.post('/v1/intents', request);
    expect((await duplicate.json()).status).toBe('submitted');
    expect(f.chain.sent).toHaveLength(1);
    const dust = await signed(p.id, 2n);
    dust.intent.amount = '1';
    expect((await (await f.post('/v1/intents', dust)).json()).error.code).toBe('dust');
    const arbitrary = await signed(p.id, 3n);
    arbitrary.data = '0xdeadbeef';
    expect((await (await f.post('/v1/intents', arbitrary)).json()).error.code).toBe('wrong_selector');
  });
  it('rejects another merchant reusing a payer nonce without revealing the original intent', async () => {
    const f = fixture();
    const firstPayment = await (await f.post('/v1/payments', { amount: '2' })).json();
    const original = await (await f.post('/v1/intents', await signed(firstPayment.id, 71n))).json();
    const otherAddress = '0x0000000000000000000000000000000000000005';
    const other = seedMerchant(f.db, otherAddress);
    const otherPayment = await (await f.post('/v1/payments', { amount: '2' }, other.secretKey)).json();
    const response = await f.post('/v1/intents', await signed(otherPayment.id, 71n, otherAddress), other.secretKey);
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error.code).toBe('replay');
    expect(JSON.stringify(body)).not.toContain(original.id);
    expect(JSON.stringify(body)).not.toContain(original.txHash);
    expect(f.chain.sent).toHaveLength(1);
  });
  it('rejects a changed payload at an existing nonce even within the same merchant', async () => {
    const f = fixture();
    const first = await (await f.post('/v1/payments', { amount: '2' })).json();
    const second = await (await f.post('/v1/payments', { amount: '2' })).json();
    const request = await signed(first.id, 72n);
    expect((await f.post('/v1/intents', request)).status).toBe(200);
    for (const changed of [await signed(second.id, 72n), { ...request, signature: `0x${'00'.repeat(65)}` }]) {
      const response = await f.post('/v1/intents', changed);
      expect(response.status).toBe(422);
      expect((await response.json()).error.code).toBe('replay');
    }
    expect(f.chain.sent).toHaveLength(1);
  });
  it('returns the original confirmed result on an identical retry without submitting again', async () => {
    const f = fixture(merchant, true);
    const payment = await (await f.post('/v1/payments', { amount: '2' })).json();
    const request = await signed(payment.id, 73n);
    const original = await (await f.post('/v1/intents', request)).json();
    const response = await f.post('/v1/intents', request);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: original.id, status: 'confirmed', txHash: original.txHash });
    expect(f.chain.sent).toHaveLength(1);
  });
  it('signs webhook deliveries, retries and replays with one event id', async () => {
    const f = fixture();
    const p = await (await f.post('/v1/payments', { amount: '2' })).json() as { id: Hex };
    f.chain.emit({ id: 'e2', txHash: `0x${'b'.repeat(64)}`, contract: 'escrow', name: 'Charged', args: { id: p.id, amount: 2_000_000n } });
    f.chain.block += 2n;
    await new Indexer(f.db, f.chain).poll();
    let attempts = 0;
    const fetcher = async (_url: RequestInfo | URL, options?: RequestInit) => {
      attempts++;
      expect(options?.headers && (options.headers as Record<string, string>)['x-settle-signature']).toBe(signWebhook(String(options?.body), 'whsec_test'));
      return new Response('', { status: attempts === 1 ? 503 : 200 });
    };
    expect(await deliverWebhooks(f.db, fetcher as typeof fetch)).toBe(1);
    expect(await deliverWebhooks(f.db, fetcher as typeof fetch, new Date(Date.now() + 2000))).toBe(1);
    const deliveries = await (await f.get('/v1/webhooks/deliveries')).json() as { data: Array<{ status: string }> };
    expect(deliveries.data[0].status).toBe('delivered');
    const events = await (await f.get('/v1/webhooks/events')).json() as { data: Array<{ id: string }> };
    expect((await f.post(`/v1/webhooks/events/${events.data[0].id}/replay`, {})).status).toBe(200);
  });
  it('emits reminders once and keeps x402 closed without a settlement rail', async () => {
    const f = fixture();
    expect((await f.post('/v1/invoices', { customerEmail: 'buyer@example.com', amount: '3', dueAt: new Date(Date.now() - 86400000).toISOString() })).status).toBe(200);
    await runKeeper(f.db, f.chain);
    await runKeeper(f.db, f.chain);
    expect((f.db.prepare("SELECT COUNT(*) n FROM webhook_events WHERE type='invoice.overdue'").get() as { n: number }).n).toBe(1);
    expect((await (await f.app.request('/supported')).json()).networks).toEqual([]);
    expect((await f.app.request('/settle', { method: 'POST' })).status).toBe(501);
    expect((await f.post('/v1/invoices/missing/list', { advance_price: '1' })).status).toBe(501);
  });
  it('does not advance renewal date until a confirmed chain event', async () => {
    const f = fixture();
    const plan = await (await f.post('/v1/subscriptions/plans', { name: 'Monthly', amount: '2', periodSeconds: 86400 })).json() as { id: string };
    const chainId = `0x${'c'.repeat(64)}`;
    f.db.prepare('INSERT INTO subscriptions(id,merchant_id,plan_id,chain_id,status,next_charge_at,retry_count,created_at) VALUES (?,?,?,?,?,?,?,?)').run('sub_1', f.keys.merchantId, plan.id, chainId, 'active', '2020-01-01T00:00:00.000Z', 0, '2020-01-01T00:00:00.000Z');
    await runKeeper(f.db, f.chain);
    const before = f.db.prepare('SELECT next_charge_at,pending_tx_hash FROM subscriptions WHERE id=?').get('sub_1') as { next_charge_at: string; pending_tx_hash: string };
    expect(before.next_charge_at).toBe('2020-01-01T00:00:00.000Z');
    expect(before.pending_tx_hash).toMatch(/^0x/);
    f.chain.emit({ id: 's1', txHash: before.pending_tx_hash as Hex, contract: 'subscription', name: 'Charged', args: { id: chainId, amount: 2_000_000n, period: 1 } });
    f.chain.block += 2n;
    await new Indexer(f.db, f.chain).poll();
    const after = f.db.prepare('SELECT next_charge_at,pending_tx_hash FROM subscriptions WHERE id=?').get('sub_1') as { next_charge_at: string; pending_tx_hash: string | null };
    expect(after.pending_tx_hash).toBeNull();
    expect(new Date(after.next_charge_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('ties a confirmed payment to an invoice and keeps webhook settings secret', async () => {
    const f = fixture();
    const invoice = await (await f.post('/v1/invoices', { customerEmail: 'buyer@example.com', amount: '2' })).json() as { id: string };
    const p = await (await f.post('/v1/payments', { amount: '2', metadata: { invoiceId: invoice.id } })).json() as { id: Hex };
    expect((await f.post('/v1/webhooks/config', { url: 'https://merchant.example/hook' }, f.keys.publishableKey)).status).toBe(403);
    const configured = await (await f.post('/v1/webhooks/config', { url: 'https://merchant.example/hook' })).json() as { signingSecret: string };
    expect(configured.signingSecret).toMatch(/^whsec_/);
    f.chain.emit({ id: 'invoice-pay', txHash: `0x${'e'.repeat(64)}`, contract: 'escrow', name: 'Charged', args: { id: p.id, amount: 2_000_000n } });
    f.chain.block += 2n;
    await new Indexer(f.db, f.chain).poll();
    expect((f.db.prepare('SELECT status FROM invoices WHERE id=?').get(invoice.id) as { status: string }).status).toBe('paid');
    expect((f.db.prepare("SELECT COUNT(*) n FROM webhook_events WHERE type='invoice.paid'").get() as { n: number }).n).toBe(1);
    const exported = await (await f.get('/v1/export?from=2020-01-01&to=2100-01-01')).json() as { rows: Array<Record<string, string>> };
    expect(exported.rows.some(r => r.Type === 'Invoice' && r['Payment or Invoice ID'] === invoice.id)).toBe(true);
  });

  it('records a mined Router refusal and fails the unpaid payment without inventing money', async () => {
    const f = fixture();
    const payment = await (await f.post('/v1/payments', { amount: '2' })).json();
    const submitted = await (await f.post('/v1/intents', await signed(payment.id, 21n))).json();
    f.chain.emit({ id: 'router-refusal', txHash: submitted.txHash, contract: 'router', name: 'Refused', args: { signer: account.address, merchant, nonce: 21n, reason: 7 } });
    f.chain.block += 2n;
    const indexer = new Indexer(f.db, f.chain);
    await indexer.poll(); await indexer.poll();
    expect(await (await f.get(`/v1/payments/${payment.id}`)).json()).toMatchObject({ status: 'failed', financialStatus: 'failed', captured: '0.000000', refunded: '0.000000' });
    expect((await (await f.get('/v1/refusals')).json()).data).toMatchObject([{ objectId: payment.id, reason: 'gas_limit', txHash: submitted.txHash }]);
    expect(f.db.prepare('SELECT status,reason FROM intents WHERE id=?').get(submitted.id)).toEqual({ status: 'refused', reason: 'gas_limit' });
    expect(f.db.prepare("SELECT * FROM accounting_entries WHERE kind='Fee'").all()).toHaveLength(0);
  });

  it('releases a refused refund reservation, matches settlement by tx and preserves captured balances', async () => {
    const f = fixture(account.address);
    const p = await (await f.post('/v1/payments', { amount: '2' })).json();
    f.chain.emit({ id: 'capture-refund', txHash: `0x${'c'.repeat(64)}`, contract: 'escrow', name: 'Charged', args: { id: p.id, amount: 2_000_000n } });
    f.chain.block += 2n;
    await new Indexer(f.db, f.chain).poll();
    async function refund(nonce: bigint, expectedStatus = 200) {
      const data = encodeFunctionData({ abi: escrowAbi, functionName: 'refund', args: [p.id, 1_000_000n, keccak256(toHex('reason'))] });
      const intent = { signer: account.address, merchant: account.address, target: escrow, dataHash: keccak256(data), amount: 1_000_000n, nonce, deadline: BigInt(Math.floor(Date.now()/1000)+3600), maxGas: 400_000 };
      const signature = await account.signTypedData(intentTypedData(intent, router));
      const response = await f.post(`/v1/payments/${p.id}/refund`, { amount: '1', reason: 'reason', intent, signature, data });
      expect(response.status).toBe(expectedStatus);
      return response.json();
    }
    const first = await refund(30n);
    f.chain.emit({ id: 'refund-refused', txHash: first.txHash, contract: 'router', name: 'Refused', args: { signer: account.address, merchant: account.address, nonce: 30n, reason: 12 } });
    f.chain.block += 2n;
    await new Indexer(f.db, f.chain).poll();
    expect((await (await f.get('/v1/refunds')).json()).data[0].status).toBe('failed');
    expect(await (await f.get(`/v1/payments/${p.id}`)).json()).toMatchObject({ financialStatus: 'captured', refunded: '0.000000' });
    expect((await refund(30n, 422)).error.code).toBe('replay');
    expect(f.chain.sent).toHaveLength(1);
    const second = await refund(31n);
    f.chain.emit({ id: 'refund-ok', txHash: second.txHash, contract: 'escrow', name: 'Refunded', args: { id: p.id, amount: 1_000_000n, reason: keccak256(toHex('reason')) } });
    f.chain.emit({ id: 'router-ok', txHash: second.txHash, contract: 'router', name: 'Executed', args: { signer: account.address, merchant: account.address, nonce: 31n, target: escrow, gasFee: 10_000n } });
    f.chain.block += 2n;
    await new Indexer(f.db, f.chain).poll();
    expect(await (await f.get(`/v1/payments/${p.id}`)).json()).toMatchObject({ status: 'succeeded', financialStatus: 'partially_refunded', captured: '2.000000', refunded: '1.000000' });
    expect(f.db.prepare('SELECT status FROM refunds WHERE id=?').get(first.id)).toEqual({ status: 'failed' });
    expect(f.db.prepare('SELECT status FROM refunds WHERE id=?').get(second.id)).toEqual({ status: 'succeeded' });
    expect(f.db.prepare('SELECT status FROM intents WHERE tx_hash=?').get(second.txHash)).toEqual({ status: 'confirmed' });
    const exported = await (await f.get('/v1/export')).json();
    expect(exported.totals.netUSDT).toBe('0.990000');
  });

  it('ignores a refusal from another transaction with the same signer and nonce', async () => {
    const f = fixture();
    const p = await (await f.post('/v1/payments', { amount: '2' })).json();
    const submitted = await (await f.post('/v1/intents', await signed(p.id, 42n))).json();
    f.chain.emit({ id: 'unrelated-refusal', txHash: `0x${'f'.repeat(64)}`, contract: 'router', name: 'Refused', args: { signer: account.address, merchant, nonce: 42n, reason: 7 } });
    f.chain.block += 2n;
    await new Indexer(f.db, f.chain).poll();
    expect(f.db.prepare('SELECT status FROM intents WHERE id=?').get(submitted.id)).toEqual({ status: 'submitted' });
    expect((await (await f.get(`/v1/payments/${p.id}`)).json()).financialStatus).toBe('open');
    expect((await (await f.get('/v1/refusals')).json()).data).toHaveLength(0);
  });

});
