import { describe, expect, it } from 'vitest';
import { verifyTypedData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { formatUsdt, hashIntent, hashMandate, intentTypedData, mandateTypedData, parseUsdt, WHITECHAIN_CHAIN_ID, whitechainSepolia, PactClient, USDT_ADDRESS, webhooks, type Intent, type Mandate, type TransportRequest } from '../src/index.js';

const account = privateKeyToAccount('0x' + '11'.repeat(32) as `0x${string}`);
const contract = '0x2222222222222222222222222222222222222222';
const merchant = '0x3333333333333333333333333333333333333333';

const intent: Intent = {
  signer: account.address, merchant, target: contract, dataHash: `0x${'44'.repeat(32)}`,
  amount: 12_500_000n, feeUSDT: 50_000n, nonce: 1n, deadline: 1_800_000_000n, maxGas: 250_000,
};
const mandate: Mandate = {
  payer: account.address, merchant, planId: `0x${'55'.repeat(32)}`,
  amountCap: 12_500_000n, periodSeconds: 2_592_000n, maxPeriods: 12, endTime: 1_900_000_000n, nonce: 2n,
};

describe('USDT exact math', () => {
  it('uses six decimals without floating point', () => {
    expect(USDT_ADDRESS).toBe('0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7');
    expect(whitechainSepolia.name).toBe('Whitechain Sepolia');
    expect(whitechainSepolia.id).toBe(1874);
    expect(parseUsdt('12.000001')).toBe(12_000_001n);
    expect(formatUsdt(12_000_001n)).toBe('12.000001');
    expect(parseUsdt('0')).toBe(0n);
  });
  it.each(['1.0000001', '-1', '1e3', '1.2.3', '01', '1,000'])('rejects unsafe amount %s', (value) => {
    expect(() => parseUsdt(value)).toThrow(RangeError);
  });
});

describe('contract typed data', () => {
  it('signs router intents with exact domain and field order', async () => {
    const data = intentTypedData(intent, contract);
    expect(data.domain).toEqual({ name: 'Settle Router', version: '1', chainId: WHITECHAIN_CHAIN_ID, verifyingContract: contract });
    expect(data.types.Intent.map((field) => `${field.type} ${field.name}`).join(',')).toBe('address signer,address merchant,address target,bytes32 dataHash,uint256 amount,uint256 feeUSDT,uint256 nonce,uint64 deadline,uint32 maxGas');
    expect(hashIntent(intent, contract)).toMatch(/^0x[a-f\d]{64}$/);
    expect(hashIntent({ ...intent, signer: '0x1111111111111111111111111111111111111111' }, contract)).toBe('0x78139ca9987a8aba6ddbc99803988a341fd8b8efa860e46d24008b54ed0075ab');
    const signature = await account.signTypedData(data);
    expect(await verifyTypedData({ ...data, address: account.address, signature })).toBe(true);
    expect(await verifyTypedData({ ...data, message: { ...intent, amount: intent.amount + 1n }, address: account.address, signature })).toBe(false);
  });
  it('signs subscription mandates with exact domain and fields', async () => {
    const data = mandateTypedData(mandate, contract);
    expect(data.domain.name).toBe('Settle Subscription');
    expect(data.types.Mandate.map((field) => `${field.type} ${field.name}`).join(',')).toBe('address payer,address merchant,bytes32 planId,uint256 amountCap,uint64 periodSeconds,uint32 maxPeriods,uint64 endTime,uint256 nonce');
    expect(hashMandate(mandate, contract)).toMatch(/^0x[a-f\d]{64}$/);
    expect(hashMandate({ ...mandate, payer: '0x1111111111111111111111111111111111111111' }, contract)).toBe('0x68751188e605ef5da658b8f7f3ef62e0e8616c9c77002bc9a9a77976c5608912');
    const signature = await account.signTypedData(data);
    expect(await verifyTypedData({ ...data, address: account.address, signature })).toBe(true);
    expect(await verifyTypedData({ ...data, message: { ...mandate, nonce: 3n }, address: account.address, signature })).toBe(false);
  });
});

describe('webhook HMAC', () => {
  it('verifies raw bytes and rejects tampering', async () => {
    const raw = '{"id":"pay_1","status":"succeeded"}';
    const secret = 'test-secret';
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
    const signature = `sha256=${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    expect(await webhooks.verify(raw, signature, secret)).toBe(true);
    expect(await webhooks.verify(new TextEncoder().encode(raw), signature.slice(7), secret)).toBe(true);
    expect(await webhooks.verify(raw + ' ', signature, secret)).toBe(false);
    expect(await webhooks.verify(raw.replace('succeeded', 'failed'), signature, secret)).toBe(false);
    expect(await webhooks.verify(raw, signature, 'other-secret')).toBe(false);
    expect(await webhooks.verify(raw, `sha256=${'0'.repeat(64)}`, secret)).toBe(false);
    expect(await webhooks.verify(raw, signature.slice(7), '')).toBe(false);
    expect(await webhooks.verify(raw, `${signature}00`, secret)).toBe(false);
    expect(await webhooks.verify(raw, 'sha256=invalid', secret)).toBe(false);
  });
});

describe('mock transport routes', () => {
  it('supports invoice drafts, retrieval, sending and partial checkout', async () => {
    const calls: TransportRequest[] = [];
    const client = new PactClient({ transport: async request => { calls.push(request); return { status: 200, body: {} }; } });
    await client.invoices.create({ customerEmail: 'payer@example.com', status: 'draft', allowPartial: true, memo: 'Deposit', lines: [{ description: 'Design', quantity: 2, unitAmount: '1.000001' }] });
    await client.invoices.get('inv/1');
    await client.invoices.list();
    await client.invoices.send('inv/1');
    await client.invoices.createPayment('inv/1', { amount: '1' });
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual(['POST /v1/invoices', 'GET /v1/invoices/inv%2F1', 'GET /v1/invoices', 'POST /v1/invoices/inv%2F1/send', 'POST /v1/invoices/inv%2F1/payments']);
    expect(JSON.parse(calls[0].body!).lines[0].unitAmount).toBe('1.000001');
    expect(JSON.parse(calls[4].body!)).toEqual({ amount: '1' });
    expect(() => client.invoices.create({ customerEmail: 'payer@example.com' })).toThrow('amount or lines');
    expect(() => client.invoices.createPayment('inv', { amount: '1.0000001' })).toThrow();
    expect(() => client.invoices.create({ customerEmail: 'payer@example.com', lines: [{ description: 'A', unitAmount: '1', quantity: -1 }] })).toThrow('Quantity');
    expect(calls).toHaveLength(5);
  });
  it('maps every planned API route and serializes bigint safely', async () => {
    const calls: TransportRequest[] = [];
    const client = new PactClient({ apiKey: 'key', transport: async (request) => {
      calls.push(request);
      return { status: 200, body: { id: 'ok' } };
    } });
    await client.payments.create({ amount: '1.00' });
    await client.payments.refund('pay/1', { amount: '0.50', intent, signature: '0x1234', data: '0xabcd' });
    await client.invoices.create({ customerEmail: 'a@b.co', amount: '2' });
    await client.subscriptions.createPlan({ name: 'Monthly', amount: '3', periodSeconds: 30 });
    await client.export({ format: 'csv' });
    await client.intents.create({ intent, signature: '0x1234', data: '0xabcd' });
    await client.gasTank.get();
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /v1/payments', 'POST /v1/payments/pay%2F1/refund', 'POST /v1/invoices',
      'POST /v1/subscriptions/plans', 'GET /v1/export?format=csv', 'POST /v1/intents', 'GET /v1/gas-tank',
    ]);
    expect(calls[5].body).toContain('"amount":"12500000"');
    expect(calls[0].headers.authorization).toBe('Bearer key');
  });
});
