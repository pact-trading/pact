import { describe, expect, it } from 'vitest';
import { PactClient } from '../src/index.js';

describe('backend client contract', () => {
  it('provides payment reads and refuses unsigned refund requests locally', async () => {
    const calls: string[] = [];
    const client = new PactClient({ transport: async r => { calls.push(r.path); return { status: 200, body: {} }; } });
    await client.payments.get('pay/1');
    await client.payments.list();
    expect(calls).toEqual(['/v1/payments/pay%2F1', '/v1/payments']);
    // @ts-expect-error The backend requires the entire signed intent.
    expect(() => client.payments.refund('pay', { amount: '1' })).toThrow('Signed intent');
    expect(calls).toHaveLength(2);
  });
});

const signature = `0x${'ab'.repeat(65)}` as const;

describe('invoice financing', () => {
  it('prepares signed orders and relays them with their signatures', async () => {
    const requests: import('../src/index.js').TransportRequest[] = [];
    const client = new PactClient({ apiKey: 'sk_test', transport: async r => { requests.push(r); return { status: 200, body: {} }; } });
    await client.financing.overview();
    await client.financing.invoice('inv/1');
    await client.financing.prepareListing('inv_1');
    await client.financing.relayListing('inv_1', { order: { face: '1' }, signatures: [signature] });
    await client.financing.prepareCancel('inv_1');
    await client.financing.relayCancel('inv_1', { order: { claimId: '1' }, signatures: [signature] });
    await client.financing.prepareBuyBack('inv_1');
    await client.financing.relayBuyBack('inv_1', { order: { claimId: '1', permits: 'router' }, signatures: [signature, signature] });
    expect(requests.map(r => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/financing', 'GET /v1/financing/invoices/inv%2F1',
      'POST /v1/financing/invoices/inv_1/list', 'POST /v1/financing/invoices/inv_1/list/relay',
      'POST /v1/financing/invoices/inv_1/cancel', 'POST /v1/financing/invoices/inv_1/cancel/relay',
      'POST /v1/financing/invoices/inv_1/buy-back', 'POST /v1/financing/invoices/inv_1/buy-back/relay',
    ]);
    expect(JSON.parse(requests[3].body!)).toEqual({ order: { face: '1' }, signatures: [signature] });
    expect(() => client.financing.relayListing('inv_1', { order: {}, signatures: ['0x1'] })).toThrow('signatures');
    expect(requests).toHaveLength(8);
  });
});

describe('fees', () => {
  it('reads terms and permits and sends only signatures', async () => {
    const requests: import('../src/index.js').TransportRequest[] = [];
    const client = new PactClient({ apiKey: 'sk_test', transport: async r => { requests.push(r); return { status: 200, body: {} }; } });
    await client.fees.get();
    await client.fees.ledger(20);
    await client.fees.terms();
    await client.fees.acceptTerms({ version: 1, deadline: 1_800_000_000n, signature });
    await client.fees.permit('escrow');
    await client.fees.submitPermit('router', { deadline: 1_800_000_000n, signature, nonce: 0n });
    await client.fees.preview(250_000);
    expect(requests.map(r => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/fees', 'GET /v1/fees/ledger?limit=20', 'GET /v1/fees/terms', 'POST /v1/fees/terms/accept',
      'GET /v1/fees/permits/escrow', 'POST /v1/fees/permits/router', 'GET /v1/fees/preview?maxGas=250000',
    ]);
    expect(JSON.parse(requests[3].body!)).toEqual({ version: 1, deadline: '1800000000', signature });
    expect(JSON.parse(requests[5].body!)).toEqual({ deadline: '1800000000', signature, nonce: '0' });
    // @ts-expect-error Only the escrow and Router are merchant spenders.
    expect(() => client.fees.permit('dex')).toThrow('Spender');
    expect(() => client.fees.submitPermit('escrow', { deadline: 1n, signature: '0x01' })).toThrow('signature');
    expect(() => client.fees.acceptTerms({ version: 0, deadline: 1n, signature })).toThrow('version');
    expect(requests).toHaveLength(7);
  });
});

describe('signed approvals and cancellations', () => {
  it('sends the payer permit without any authorization field', async () => {
    const requests: import('../src/index.js').TransportRequest[] = [];
    const client = new PactClient({ transport: async r => { requests.push(r); return { status: 200, body: {} }; } });
    const payer = '0x0000000000000000000000000000000000000001' as const;
    await client.payments.approve('pay_1', { payer, deadline: 1_800_000_000n, signature });
    expect(JSON.parse(requests[0].body!)).toEqual({ payer, deadline: '1800000000', signature });
    expect(() => client.payments.approve('pay_1', { payer, deadline: 'soon', signature })).toThrow('deadline');
  });
  it('cancels with the payer signature, or as the merchant', async () => {
    const requests: import('../src/index.js').TransportRequest[] = [];
    const client = new PactClient({ apiKey: 'sk_test', transport: async r => { requests.push(r); return { status: 200, body: {} }; } });
    await client.subscriptions.cancel('sub_1', { deadline: 1_800_000_000n, signature });
    await client.subscriptions.cancelAsMerchant('sub_1');
    await client.subscriptions.renew('sub_1');
    expect(requests.map(r => `${r.method} ${r.path} ${r.body}`)).toEqual([
      `POST /v1/subscriptions/sub_1/cancel {"deadline":"1800000000","signature":"${signature}"}`,
      'POST /v1/subscriptions/sub_1/cancel {"by":"merchant"}',
      'POST /v1/subscriptions/sub_1/renew {}',
    ]);
    // @ts-expect-error The deadline is bigint Unix seconds.
    expect(() => client.subscriptions.cancel('sub_1', { deadline: 1, signature })).toThrow('deadline');
  });
});

describe('request controls and compatibility', () => {
  it('forwards legacy signals, explicit idempotency and bound export calls', async () => {
    const requests: import('../src/index.js').TransportRequest[] = [];
    const client = new PactClient({ apiKey: 'sk_test', transport: async r => { requests.push(r); return { status: 200, body: {} }; } });
    const signal = new AbortController().signal;
    await client.payments.create({ amount: '1' }, signal);
    await client.payments.create({ amount: '1' }, { signal, idempotencyKey: 'order-1' });
    expect(requests[0].signal).toBe(signal);
    expect(requests[1]).toMatchObject({ signal, headers: { authorization: 'Bearer sk_test', 'idempotency-key': 'order-1' } });
    const { export: exportReport } = client;
    await exportReport({ format: 'csv', from: '2026-11-01' });
    expect(requests[2].path).toBe('/v1/export?format=csv&from=2026-11-01');
    await expect(client.payments.create({ amount: '1' }, { idempotencyKey: '' })).rejects.toThrow('Idempotency');
    expect(requests).toHaveLength(3);
  });
});

describe('configuration', () => {
  it('returns the configured contracts, including the FeeSchedule', async () => {
    const body: import('../src/index.js').ApiConfig = { chainId: 1874, merchant: '0x01', router: '0x02', escrow: '0x03', subscription: '0x04', fees: '0x05' };
    const client = new PactClient({ transport: async () => ({ status: 200, body }) });
    expect(await client.config.get()).toEqual(body);
  });
});
