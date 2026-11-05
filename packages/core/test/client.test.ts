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

describe('invoice financing', () => {
  it('prepares the merchant wallet transactions and submits their hashes', async () => {
    const requests: import('../src/index.js').TransportRequest[] = [];
    const client = new PactClient({ apiKey: 'sk_test', transport: async r => { requests.push(r); return { status: 200, body: {} }; } });
    await client.financing.overview();
    await client.financing.invoice('inv/1');
    await client.financing.prepareListing('inv_1');
    await client.financing.prepareCancel('inv_1');
    await client.financing.prepareBuyBack('inv_1');
    const hash = `0x${'a'.repeat(64)}`;
    await client.financing.submitTransactions('inv_1', [hash]);
    expect(requests.map(r => `${r.method} ${r.path}`)).toEqual([
      'GET /v1/financing', 'GET /v1/financing/invoices/inv%2F1', 'POST /v1/financing/invoices/inv_1/list',
      'POST /v1/financing/invoices/inv_1/cancel', 'POST /v1/financing/invoices/inv_1/buy-back', 'POST /v1/financing/invoices/inv_1/transactions',
    ]);
    expect(JSON.parse(requests[5].body!)).toEqual({ hashes: [hash] });
    expect(() => client.financing.submitTransactions('inv_1', ['0x1'])).toThrow('Transaction hashes');
    expect(requests).toHaveLength(6);
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
    await exportReport({ format: 'csv', from: '2026-11-06' });
    expect(requests[2].path).toBe('/v1/export?format=csv&from=2026-11-06');
    await expect(client.payments.create({ amount: '1' }, { idempotencyKey: '' })).rejects.toThrow('Idempotency');
    expect(requests).toHaveLength(3);
  });
  it('rejects unsafe authorization nonces before serializing them', () => {
    const client = new PactClient({ transport: async () => { throw new Error('Must not send'); } });
    const address = '0x0000000000000000000000000000000000000001' as const;
    expect(() => client.payments.approve('p', {
      payer: address, approvalNonce: 0n, deadline: 1n, signature: '0x01',
      authorization: { address, chainId: 1874, nonce: Number.MAX_SAFE_INTEGER + 1, yParity: 0, r: '0x01', s: '0x01' },
    })).toThrow('safe nonce');
  });
});

describe('subscription configuration compatibility', () => {
  it.each([undefined, 1, 2] as const)('preserves subscriptionVersion=%s without inventing a version', async subscriptionVersion => {
    const body: import('../src/index.js').ApiConfig = {
      chainId: 1874, merchant: '0x01', router: '0x02', escrow: '0x03', subscription: '0x04',
      ...(subscriptionVersion === undefined ? {} : { subscriptionVersion }),
    };
    const client = new PactClient({ transport: async () => ({ status: 200, body }) });
    expect(await client.config.get()).toEqual(body);
    expect((await client.config.get()).subscriptionVersion).toBe(subscriptionVersion);
  });
});
