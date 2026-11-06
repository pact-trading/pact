import { describe, expect, it } from 'vitest';
import { concat, encodeAbiParameters, hashTypedData, keccak256, toHex, verifyTypedData, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { acceptTermsTypedData, cancellationTypedData, formatUsdt, hashIntent, hashMandate, intentTypedData, mandateTypedData, parseUsdt, permitTypedData, WHITECHAIN_CHAIN_ID, whitechainSepolia, PactClient, USDT_ADDRESS, webhooks, type Intent, type Mandate, type TransportRequest } from '../src/index.js';

/** The digest the contracts compute, from their Solidity type strings: independent of viem's encoder. */
function contractDigest(name: string, version: string, verifyingContract: Address, typeString: string, fields: Array<{ type: string; value: unknown }>): Hex {
  const domainType = keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
  const domain = keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
    [domainType, keccak256(toHex(name)), keccak256(toHex(version)), BigInt(WHITECHAIN_CHAIN_ID), verifyingContract]));
  const struct = keccak256(encodeAbiParameters([{ type: 'bytes32' }, ...fields.map(f => ({ type: f.type }))], [keccak256(toHex(typeString)), ...fields.map(f => f.value)]));
  return keccak256(concat(['0x1901', domain, struct]));
}

const account = privateKeyToAccount('0x' + '11'.repeat(32) as `0x${string}`);
const contract = '0x2222222222222222222222222222222222222222';
const merchant = '0x3333333333333333333333333333333333333333';

const intent: Intent = {
  signer: account.address, merchant, target: contract, dataHash: `0x${'44'.repeat(32)}`,
  amount: 12_500_000n, nonce: 1n, deadline: 1_800_000_000n, maxGas: 250_000,
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
    expect(data.domain).toEqual({ name: 'Settle Router', version: '2', chainId: WHITECHAIN_CHAIN_ID, verifyingContract: contract });
    expect(data.types.Intent.map((field) => `${field.type} ${field.name}`).join(',')).toBe('address signer,address merchant,address target,bytes32 dataHash,uint256 amount,uint256 nonce,uint64 deadline,uint32 maxGas');
    expect('feeUSDT' in data.message).toBe(false);
    // Router.INTENT_TYPEHASH, verbatim.
    expect(hashIntent(intent, contract)).toBe(contractDigest('Settle Router', '2', contract,
      'Intent(address signer,address merchant,address target,bytes32 dataHash,uint256 amount,uint256 nonce,uint64 deadline,uint32 maxGas)',
      [{ type: 'address', value: intent.signer }, { type: 'address', value: intent.merchant }, { type: 'address', value: intent.target }, { type: 'bytes32', value: intent.dataHash },
        { type: 'uint256', value: intent.amount }, { type: 'uint256', value: intent.nonce }, { type: 'uint64', value: intent.deadline }, { type: 'uint32', value: intent.maxGas }]));
    const signature = await account.signTypedData(data);
    expect(await verifyTypedData({ ...data, address: account.address, signature })).toBe(true);
    expect(await verifyTypedData({ ...data, message: { ...intent, amount: intent.amount + 1n }, address: account.address, signature })).toBe(false);
  });
  it('signs subscription mandates with exact domain and fields', async () => {
    const data = mandateTypedData(mandate, contract);
    expect(data.domain).toEqual({ name: 'Settle Subscription', version: '2', chainId: WHITECHAIN_CHAIN_ID, verifyingContract: contract });
    expect(data.types.Mandate.map((field) => `${field.type} ${field.name}`).join(',')).toBe('address payer,address merchant,bytes32 planId,uint256 amountCap,uint64 periodSeconds,uint32 maxPeriods,uint64 endTime,uint256 nonce');
    // SubscriptionManagerV2.MANDATE_TYPEHASH, verbatim.
    expect(hashMandate(mandate, contract)).toBe(contractDigest('Settle Subscription', '2', contract,
      'Mandate(address payer,address merchant,bytes32 planId,uint256 amountCap,uint64 periodSeconds,uint32 maxPeriods,uint64 endTime,uint256 nonce)',
      [{ type: 'address', value: mandate.payer }, { type: 'address', value: mandate.merchant }, { type: 'bytes32', value: mandate.planId }, { type: 'uint256', value: mandate.amountCap },
        { type: 'uint64', value: mandate.periodSeconds }, { type: 'uint32', value: mandate.maxPeriods }, { type: 'uint64', value: mandate.endTime }, { type: 'uint256', value: mandate.nonce }]));
    const signature = await account.signTypedData(data);
    expect(await verifyTypedData({ ...data, address: account.address, signature })).toBe(true);
    expect(await verifyTypedData({ ...data, message: { ...mandate, nonce: 3n }, address: account.address, signature })).toBe(false);
  });
  it('builds the payer cancellation in the subscription domain', () => {
    const id = `0x${'66'.repeat(32)}` as Hex;
    expect(hashTypedData(cancellationTypedData(id, 1_800_000_000n, contract))).toBe(contractDigest('Settle Subscription', '2', contract, 'Cancel(bytes32 id,uint64 deadline)',
      [{ type: 'bytes32', value: id }, { type: 'uint64', value: 1_800_000_000n }]));
  });
  it('builds the USDT permit and the fee-terms acceptance', () => {
    const permit = permitTypedData(account.address, contract, 5_000_000n, 3n, 1_800_000_000n);
    expect(permit.domain).toEqual({ name: 'Tether USD', version: '1', chainId: WHITECHAIN_CHAIN_ID, verifyingContract: USDT_ADDRESS });
    expect(hashTypedData(permit)).toBe(contractDigest('Tether USD', '1', USDT_ADDRESS, 'Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)',
      [{ type: 'address', value: account.address }, { type: 'address', value: contract }, { type: 'uint256', value: 5_000_000n }, { type: 'uint256', value: 3n }, { type: 'uint256', value: 1_800_000_000n }]));
    // FeeSchedule.ACCEPT_TYPEHASH, verbatim.
    expect(hashTypedData(acceptTermsTypedData(merchant, 1, 0n, 1_800_000_000n, contract))).toBe(contractDigest('Pact Fees', '1', contract,
      'AcceptTerms(address merchant,uint32 version,uint256 nonce,uint256 deadline)',
      [{ type: 'address', value: merchant }, { type: 'uint32', value: 1 }, { type: 'uint256', value: 0n }, { type: 'uint256', value: 1_800_000_000n }]));
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
    await client.fees.get();
    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /v1/payments', 'POST /v1/payments/pay%2F1/refund', 'POST /v1/invoices',
      'POST /v1/subscriptions/plans', 'GET /v1/export?format=csv', 'POST /v1/intents', 'GET /v1/fees',
    ]);
    expect(calls[5].body).toContain('"amount":"12500000"');
    expect(calls[0].headers.authorization).toBe('Bearer key');
  });
});
