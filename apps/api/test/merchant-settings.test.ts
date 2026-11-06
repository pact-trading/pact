import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { openDb, seedMerchant } from '../src/db.js';
import { createApp } from '../src/app.js';
import { FakeChain, escrowAbi } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { intentTypedData } from '../src/typed-data.js';
import { Indexer } from '../src/indexer.js';

const router = toHex(1, { size: 20 }), escrow = toHex(2, { size: 20 }), subscription = toHex(3, { size: 20 });
const payer = privateKeyToAccount(toHex(77, { size: 32 }));
function fixture(db = openDb()) {
  const merchant = seedMerchant(db, toHex(4, { size: 20 }), { webhookUrl: 'https://merchant.test/hook', webhookSecret: 'whsec_private' });
  const other = seedMerchant(db, toHex(5, { size: 20 })), chain = new FakeChain(true);
  const app = createApp({ db, chain, relayer: new Relayer(chain, router, allowedTargets({ escrow: escrow, subscription: subscription })) });
  const req = (path: string, body?: unknown, key = merchant.secretKey, idem?: string) => app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': idem } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body, (_, v) => typeof v === 'bigint' ? String(v) : v) }) });
  async function signed(id: Hex, window: bigint, nonce: bigint, authorize = false) {
    const data = encodeFunctionData({ abi: escrowAbi, functionName: authorize ? 'authorize' : 'charge', args: authorize ? [id, toHex(4, { size: 20 }), 2_000_000n, BigInt(Math.floor(Date.now() / 1000) + 3600), window] : [id, toHex(4, { size: 20 }), 2_000_000n, window] });
    const intent = { signer: payer.address, merchant: toHex(4, { size: 20 }), target: escrow, dataHash: keccak256(data), amount: 2_000_000n, nonce, deadline: BigInt(Math.floor(Date.now() / 1000) + 120), maxGas: 300_000 };
    return { intent, data, signature: await payer.signTypedData(intentTypedData(intent, router)) };
  }
  return { db, merchant, other, chain, req, signed };
}
describe('merchant settings and payment refund policy', () => {
  it('defaults to 30 days, keeps settings private and publishes only checkout branding', async () => {
    const f = fixture();
    const initial = await (await f.req('/v1/settings')).json();
    expect(initial).toMatchObject({ payoutAddress: toHex(4, { size: 20 }), refundWindowSeconds: 2592000, brandName: '', logoUrl: null, webhook: { url: 'https://merchant.test/hook', configured: true } });
    expect(JSON.stringify(initial)).not.toContain('whsec_private');
    expect((await f.req('/v1/settings', undefined, f.merchant.publishableKey)).status).toBe(403);
    expect((await f.req('/v1/settings', { brandName: 'Attacker' }, f.merchant.publishableKey)).status).toBe(403);
    expect((await f.req('/v1/settings', { brandName: 'Studio', logoUrl: 'https://assets.example/logo.png', refundWindowSeconds: 604800 })).status).toBe(200);
    const publicConfig = await (await f.req('/v1/config', undefined, f.merchant.publishableKey)).json();
    expect(publicConfig.checkout).toEqual({ brandName: 'Studio', logoUrl: 'https://assets.example/logo.png', refundWindowSeconds: 604800 });
    expect(JSON.stringify(publicConfig)).not.toContain('webhook');
    expect((await (await f.req('/v1/settings', undefined, f.other.secretKey)).json()).brandName).toBe('');
  });
  it('validates all fields before mutation and preserves idempotency and persistence', async () => {
    const f = fixture();
    for (const body of [{ brandName: 'x'.repeat(201) }, { logoUrl: 'javascript:alert(1)' }, { logoUrl: 'https://user:pass@example.test/logo' }, { logoUrl: 'http://localhost/logo' }, { refundWindowSeconds: 0 }, { refundWindowSeconds: 1.5 }, { refundWindowSeconds: 31536001 }, { payoutAddress: toHex(9, { size: 20 }) }, { brandName: 'Bad\u0000name' }]) expect((await f.req('/v1/settings', body)).status).toBe(400);
    expect((await (await f.req('/v1/settings')).json()).brandName).toBe('');
    const body = { brandName: 'Saved', refundWindowSeconds: 86400 };
    expect((await f.req('/v1/settings', body, f.merchant.secretKey, 'profile')).status).toBe(200);
    expect((await f.req('/v1/settings', body, f.merchant.secretKey, 'profile')).status).toBe(200);
    expect((await f.req('/v1/settings', { brandName: 'Other' }, f.merchant.secretKey, 'profile')).status).toBe(409);
    const reopened = openDb(f.db.serialize());
    expect(reopened.prepare('SELECT brand_name,refund_window_seconds FROM merchant_settings WHERE merchant_id=?').get(f.merchant.merchantId)).toEqual({ brand_name: 'Saved', refund_window_seconds: 86400 });
    reopened.close();
  });
  it('snapshots defaults for regular and invoice payments and rejects changed signed charge/authorize windows before sending', async () => {
    const f = fixture();
    const first = await (await f.req('/v1/payments', { amount: '2' })).json();
    expect(first.refundWindowSeconds).toBe(2592000);
    await f.req('/v1/settings', { refundWindowSeconds: 86400 });
    const invoice = await (await f.req('/v1/invoices', { amount: '2', customerEmail: 'buyer@example.test' })).json();
    const invoicePayment = await (await f.req(`/v1/invoices/${invoice.id}/payments`, {})).json();
    expect(invoicePayment.refundWindowSeconds).toBe(86400);
    const invoiceViaGeneric = await (await f.req('/v1/payments', { amount: '2' })).json();
    expect(invoiceViaGeneric.refundWindowSeconds).toBe(86400);
    for (const authorize of [false, true]) {
      const response = await f.req('/v1/intents', await f.signed(first.id, 86400n, authorize ? 2n : 1n, authorize));
      expect(response.status).toBe(422); expect((await response.json()).error.code).toBe('refund_window_mismatch');
    }
    expect(f.chain.writer.rows()).toHaveLength(0);
    expect((await f.req('/v1/intents', await f.signed(first.id, 2592000n, 3n))).status).toBe(200);
    const paid = await (await f.req(`/v1/payments/${first.id}`)).json();
    expect(paid.refundWindowSeconds).toBe(2592000);
    expect(Date.parse(paid.refundDeadline)).toBeGreaterThan(Date.now() + 29 * 86400000);
  });
  it('records the contract deadline unchanged across captures, duplicate indexing and settings changes', async () => {
    const f = fixture(), payment = await (await f.req('/v1/payments', { amount: '2' })).json();
    const deadline = '2027-01-31T00:00:00.000Z';
    f.db.prepare("UPDATE payments SET status='authorized' WHERE id=?").run(payment.id);
    for (const [i, amount] of [[1, 1_000_000n], [2, 1_000_000n]] as const) {
      f.chain.emit({ id: `capture-${i}`, txHash: toHex(i + 100, { size: 32 }), contract: 'escrow', name: 'Captured', args: { id: payment.id, amount }, timestamp: '2027-01-01T00:00:00.000Z', paymentTerms: { refundWindowSeconds: '2592000', refundDeadlineUnix: String(Date.parse(deadline) / 1000) } });
    }
    f.chain.block += 2n;
    const indexer = new Indexer(f.db, f.chain); await indexer.poll(); await indexer.poll();
    await f.req('/v1/settings', { refundWindowSeconds: 60 });
    const detail = await (await f.req(`/v1/payments/${payment.id}`)).json();
    expect(detail).toMatchObject({ captured: '2.000000', refundDeadline: deadline, refundWindowSeconds: 2592000 });
  });
  it('preserves legacy payment compatibility without inventing a historical policy', async () => {
    const f = fixture(), payment = await (await f.req('/v1/payments', { amount: '2' })).json();
    f.db.prepare('DELETE FROM payment_policies WHERE payment_id=?').run(payment.id);
    expect((await (await f.req(`/v1/payments/${payment.id}`)).json()).refundWindowSeconds).toBeNull();
    expect((await f.req('/v1/intents', await f.signed(payment.id, 3600n, 7n))).status).toBe(200);
    expect(await (await f.req(`/v1/payments/${payment.id}`)).json()).toMatchObject({ refundWindowSeconds: null, onchainRefundWindowSeconds: '3600' });
  });
  it('matches the contract refund deadline boundary and retains exact timestamps beyond JavaScript Date', async () => {
    const f = fixture(), payment = await (await f.req('/v1/payments', { amount: '2' })).json();
    const deadline = BigInt(Math.floor(Date.now() / 1000));
    f.chain.emit({ id: 'charge-boundary', txHash: toHex(200, { size: 32 }), contract: 'escrow', name: 'Charged', args: { id: payment.id, merchant: toHex(4, { size: 20 }), payer: payer.address, amount: 2_000_000n }, paymentTerms: { refundWindowSeconds: '2592000', refundDeadlineUnix: String(deadline) } });
    f.chain.block += 2n; await new Indexer(f.db, f.chain).poll();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Number(deadline) * 1000 + 500);
      expect((await (await f.req(`/v1/payments/${payment.id}/refund`, { amount: '1' })).json()).error.code).toBe('signed_intent_required');
      vi.setSystemTime(Number(deadline + 1n) * 1000);
      expect((await (await f.req(`/v1/payments/${payment.id}/refund`, { amount: '1' })).json()).error.code).toBe('refund_window_closed');
    } finally { vi.useRealTimers(); }
    const second = await (await f.req('/v1/payments', { amount: '2' })).json();
    f.chain.emit({ id: 'charge-large-time', txHash: toHex(201, { size: 32 }), contract: 'escrow', name: 'Charged', args: { id: second.id, merchant: toHex(4, { size: 20 }), payer: payer.address, amount: 2_000_000n }, paymentTerms: { refundWindowSeconds: '2592000', refundDeadlineUnix: '18446744073709551615' } });
    f.chain.block += 2n; await new Indexer(f.db, f.chain).poll();
    expect(await (await f.req(`/v1/payments/${second.id}`)).json()).toMatchObject({ refundDeadline: null, refundDeadlineUnix: '18446744073709551615' });
  });
});
