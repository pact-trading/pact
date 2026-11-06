import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionData, keccak256, maxUint256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain, escrowAbi, feeScheduleAbi } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { createApp } from '../src/app.js';
import { ApprovalService } from '../src/approval.js';
import { Indexer } from '../src/indexer.js';
import { SponsorshipBudget } from '../src/sponsorship.js';
import { CHECKOUT, INVOICE, feeFor } from '../src/pricing.js';
import { INITIAL_TERMS } from '../src/suite.js';
import { acceptTermsTypedData, intentTypedData, permitTypedData } from '../src/typed-data.js';
import type { IntentRequest } from '../src/types.js';

const merchant = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const payer = privateKeyToAccount(`0x${'2'.repeat(64)}`);
const router = '0x0000000000000000000000000000000000000001' as Address;
const escrow = '0x0000000000000000000000000000000000000002' as Address;
const subscription = '0x0000000000000000000000000000000000000003' as Address;
const fees = '0x0000000000000000000000000000000000000005' as Address;
const json = (x: unknown) => JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v);

function fixture(autoSettle = false) {
  const db = openDb(), chain = new FakeChain(autoSettle), keys = seedMerchant(db, merchant.address);
  const relayer = new Relayer(chain, router, allowedTargets({ escrow, subscription }));
  const approval = new ApprovalService(db, chain, { enabled: true, escrow, minimumAmount: 1_000_000n, confirmations: 1n });
  const sponsorship = new SponsorshipBudget(db);
  const app = createApp({ db, chain, relayer, approval, sponsorship, router, escrow, subscription, fees });
  const call = async (path: string, body?: unknown, key = keys.secretKey) => {
    const r = await app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : json(body) });
    return { status: r.status, body: await r.json() as any };
  };
  return { db, chain, keys, relayer, approval, call };
}
async function charge(f: ReturnType<typeof fixture>, amount: bigint, opts: { signer?: typeof payer; data?: Hex; nonce?: bigint } = {}): Promise<IntentRequest> {
  const id = `0x${(opts.nonce ?? 1n).toString(16).padStart(64, 'a')}` as Hex;
  const data = opts.data ?? encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [id, merchant.address, amount, 2_592_000n] });
  const signer = opts.signer ?? payer;
  const intent = { signer: signer.address, merchant: merchant.address, target: escrow, dataHash: keccak256(data), amount, nonce: opts.nonce ?? 1n, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), maxGas: 300_000 };
  return { intent, data, signature: await signer.signTypedData(intentTypedData(intent, router)) };
}

describe('fee math', () => {
  it('matches the FeeSchedule: rounded up, a floor, a cap, never above the amount', () => {
    expect(feeFor(INITIAL_TERMS, CHECKOUT, 100_000_000n)).toBe(800_000n);
    expect(feeFor(INITIAL_TERMS, CHECKOUT, 10_000_000n)).toBe(150_000n);
    expect(feeFor(INITIAL_TERMS, CHECKOUT, 1_000_000_001n)).toBe(8_000_001n);
    expect(feeFor(INITIAL_TERMS, INVOICE, 1_000_000_000n)).toBe(5_000_000n);
    expect(feeFor(INITIAL_TERMS, INVOICE, 50_000_000_000n)).toBe(10_000_000n);
    expect(() => feeFor(INITIAL_TERMS, CHECKOUT, 149_999n)).toThrow('minimum fee');
  });
});

describe('fee terms', () => {
  it('shows a new merchant the terms to sign, and Pact relays its signed acceptance', async () => {
    const f = fixture();
    const before = await f.call('/v1/fees');
    expect(before.body.terms).toMatchObject({ acceptedVersion: 0, latestVersion: 1, needsAcceptance: true, latest: { checkout: { percent: '0.80%', minimumUsdt: '0.150000', capUsdt: null }, invoice: { percent: '0.50%', capUsdt: '10.000000' } } });
    expect(before.body.ready).toBe(false);
    const offer = await f.call('/v1/fees/terms');
    expect(offer.body).toMatchObject({ version: 1, nonce: '0', typedData: { primaryType: 'AcceptTerms', domain: { name: 'Pact Fees', version: '1', chainId: 1874, verifyingContract: fees } } });
    const signature = await merchant.signTypedData(acceptTermsTypedData(merchant.address, 1, 0n, BigInt(offer.body.deadline), fees));
    // Another wallet's signature is refused before anything is sent.
    const forged = await payer.signTypedData(acceptTermsTypedData(merchant.address, 1, 0n, BigInt(offer.body.deadline), fees));
    expect((await f.call('/v1/fees/terms/accept', { version: 1, deadline: offer.body.deadline, signature: forged })).body.error.code).toBe('invalid_signature');
    expect(f.chain.relayed).toHaveLength(0);
    const accepted = await f.call('/v1/fees/terms/accept', { version: 1, deadline: offer.body.deadline, signature });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ acceptedVersion: 1, needsAcceptance: false });
    expect(f.chain.relayed).toHaveLength(1);
    const sent = decodeFunctionData({ abi: feeScheduleAbi, data: f.chain.relayed[0].data });
    expect(f.chain.relayed[0].to).toBe(fees);
    expect(sent).toMatchObject({ functionName: 'acceptWithSig', args: [merchant.address, 1, BigInt(offer.body.deadline), signature] });
    expect(f.db.prepare('SELECT kind FROM sponsored_spend').all()).toEqual([{ kind: 'fees' }]);
  });
  it('refuses stale versions, bad deadlines and extra fields, and only with a secret key', async () => {
    const f = fixture();
    const offer = (await f.call('/v1/fees/terms')).body;
    const signature = await merchant.signTypedData(acceptTermsTypedData(merchant.address, 1, 0n, BigInt(offer.deadline), fees));
    f.chain.latestVersion = 2;
    expect((await f.call('/v1/fees/terms/accept', { version: 1, deadline: offer.deadline, signature })).body.error.code).toBe('fee_terms_changed');
    f.chain.latestVersion = 1;
    expect((await f.call('/v1/fees/terms/accept', { version: 1, deadline: '1', signature })).body.error.code).toBe('invalid_deadline');
    expect((await f.call('/v1/fees/terms/accept', { version: 1, deadline: offer.deadline, signature, fee: '0' })).body.error.code).toBe('unexpected_field');
    expect((await f.call('/v1/fees/terms/accept', { version: 1, deadline: offer.deadline, signature }, f.keys.publishableKey)).status).toBe(403);
  });
});

describe('merchant standing permits', () => {
  it('offers unlimited escrow and Router permits, relays each, and reports them ready once confirmed', async () => {
    const f = fixture(); f.chain.accepted.set(merchant.address.toLowerCase(), 1);
    const permits = (await f.call('/v1/fees')).body.permits;
    expect(permits.map((p: { spender: string; status: string }) => [p.spender, p.status])).toEqual([['escrow', 'needs_approval'], ['router', 'needs_approval']]);
    for (const [spender, address] of [['escrow', escrow], ['router', router]] as const) {
      const offer = (await f.call(`/v1/fees/permits/${spender}`)).body;
      expect(offer).toMatchObject({ status: 'needs_approval', spender: address, amount: maxUint256.toString() });
      const signature = await merchant.signTypedData(permitTypedData(merchant.address, address, maxUint256, BigInt(offer.permitNonce), BigInt(offer.deadline)));
      const pending = await f.call(`/v1/fees/permits/${spender}`, { deadline: offer.deadline, signature });
      expect(pending.body.status).toBe('pending');
      const hash = pending.body.txHash as Hex;
      f.chain.block += 5n;
      f.chain.approval.receipts.set(hash, { hash, block: f.chain.block - 2n, status: 'success', approvals: [{ owner: merchant.address, spender: address, value: maxUint256 }] });
      f.chain.approval.allowances.set(address.toLowerCase(), maxUint256);
      f.chain.approval.state.nonce++;
      expect((await f.call(`/v1/fees/permits/${spender}`)).body.status).toBe('ready');
    }
    const detail = (await f.call('/v1/fees')).body;
    expect(detail.permits.every((p: { status: string }) => p.status === 'ready')).toBe(true);
    expect(detail.ready).toBe(true);
    expect((await f.call('/v1/fees/permits/vault')).status).toBe(404);
  });
});

describe('relayer fee rules', () => {
  it('takes no payment for a merchant that has not signed its fee terms', async () => {
    const f = fixture();
    await expect(f.relayer.submit(await charge(f, 10_000_000n))).rejects.toMatchObject({ code: 'fee_terms_required' });
    expect(f.chain.sent).toHaveLength(0);
  });
  it('refuses a payment whose fee would not cover its gas: a stale minimum after a WBT price move', async () => {
    const f = fixture(); f.chain.accepted.set(merchant.address.toLowerCase(), 1);
    f.chain.policy.usdtPerWbt = 79_000_000n * 1000n;
    await expect(f.relayer.submit(await charge(f, 10_000_000n))).rejects.toMatchObject({ code: 'fee_below_gas' });
    f.chain.policy.usdtPerWbt = 79_000_000n;
    await expect(f.relayer.submit(await charge(f, 10_000_000n))).resolves.toMatch(/^0x/);
  });
  it('lets only the merchant sign a call that spends its USDT, and only when it can pay the gas', async () => {
    const f = fixture(); f.chain.accepted.set(merchant.address.toLowerCase(), 1);
    const refund = encodeFunctionData({ abi: escrowAbi, functionName: 'refund', args: [`0x${'a'.repeat(64)}`, 1_000_000n, keccak256(toHex('r'))] });
    await expect(f.relayer.submit(await charge(f, 1_000_000n, { data: refund, nonce: 2n }))).rejects.toMatchObject({ code: 'signer_not_merchant' });
    await expect(f.relayer.submit(await charge(f, 1_000_000n, { data: refund, signer: merchant, nonce: 3n }))).rejects.toMatchObject({ code: 'gas_fee_unavailable' });
    f.chain.approval.state = { balance: 100_000_000n, allowance: maxUint256, nonce: 0n };
    await expect(f.relayer.submit(await charge(f, 1_000_000n, { data: refund, signer: merchant, nonce: 4n }))).resolves.toMatch(/^0x/);
  });
  it('caps the gas Pact absorbs for a merchant, raising the cap with the fees it pays', async () => {
    const f = fixture(); f.chain.accepted.set(merchant.address.toLowerCase(), 1);
    const budget = new SponsorshipBudget(f.db, { starterWeiPerDay: 1n, revenueShareBps: 2_500 });
    f.relayer.sponsorship = {
      assert: (_m, cost, price) => budget.assert(f.keys.merchantId, cost, price),
      record: (_m, id, cost) => budget.record(id, f.keys.merchantId, cost, 'intent'),
    };
    const authorize = (nonce: bigint) => encodeFunctionData({ abi: escrowAbi, functionName: 'authorize', args: [`0x${nonce.toString(16).padStart(64, 'b')}`, merchant.address, 2_000_000n, BigInt(Math.floor(Date.now() / 1000) + 3600), 86_400n] });
    await expect(f.relayer.submit(await charge(f, 2_000_000n, { data: authorize(5n), nonce: 5n }))).rejects.toMatchObject({ code: 'sponsorship_budget' });
    // 1,000 USDT of fees over 30 days earn a quarter of their value in WBT of absorbed gas a day.
    f.db.prepare("INSERT INTO accounting_entries(event_id,merchant_id,object_id,kind,amount_minor,fee_minor,tx_hash,occurred_at,block_number) VALUES ('e1',?,'p1','Payment','100000000000','1000000000','0x1',?,'1')").run(f.keys.merchantId, new Date().toISOString());
    await expect(f.relayer.submit(await charge(f, 2_000_000n, { data: authorize(6n), nonce: 6n }))).resolves.toMatch(/^0x/);
    expect((f.db.prepare('SELECT count(*) n FROM sponsored_spend').get() as { n: number }).n).toBe(1);
  });
});

describe('fee ledger and dashboard', () => {
  it('books the fee out of each payment: gross, fee and net, and the refund network fee', async () => {
    const f = fixture(true);
    const created = (await f.call('/v1/payments', { amount: '100' })).body;
    const data = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [created.id, merchant.address, 100_000_000n, 2_592_000n] });
    const intent = { signer: payer.address, merchant: merchant.address, target: escrow, dataHash: keccak256(data), amount: 100_000_000n, nonce: 1n, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), maxGas: 300_000 };
    expect((await f.call('/v1/intents', { intent, data, signature: await payer.signTypedData(intentTypedData(intent, router)) }, f.keys.publishableKey)).status).toBe(200);
    const refund = (await f.call(`/v1/payments/${created.id}/refund-intent`, { amount: '10', reason: 'Late delivery' })).body;
    const signed = await merchant.signTypedData(intentTypedData({ ...refund.intent, amount: BigInt(refund.intent.amount), nonce: BigInt(refund.intent.nonce), deadline: BigInt(refund.intent.deadline) }, router));
    expect((await f.call(`/v1/payments/${created.id}/refund`, { amount: '10', reason: 'Late delivery', intent: refund.intent, data: refund.data, signature: signed })).status).toBe(200);
    const ledger = (await f.call('/v1/fees/ledger')).body.data;
    expect(ledger.map((e: { kind: string; label: string; grossUsdt: string; feeUsdt: string; netUsdt: string }) => [e.kind, e.label, e.grossUsdt, e.feeUsdt, e.netUsdt])).toEqual([
      ['Fee', 'Refund network fee', '0.000000', expect.stringMatching(/^0\.0\d{5}$/), expect.stringMatching(/^-0\.0\d{5}$/)],
      ['Payment', 'Payment', '100.000000', '0.800000', '99.200000'],
    ]);
    // A network fee with no refund in its transaction is a financing buy-back's.
    f.db.prepare("INSERT INTO accounting_entries(event_id,merchant_id,object_id,kind,amount_minor,fee_minor,token_delta_minor,tx_hash,occurred_at,block_number) VALUES ('buy-back-gas',?,?,'Fee','0','30000','-30000',?,?,'99')")
      .run(f.keys.merchantId, 'buy-back-gas', `0x${'b'.repeat(64)}`, new Date(Date.now() + 1000).toISOString());
    expect((await f.call('/v1/fees/ledger')).body.data[0]).toMatchObject({ label: 'Buy-back network fee', feeUsdt: '0.030000' });
    const detail = (await f.call('/v1/fees')).body;
    expect(detail.totals).toMatchObject({ days: 30, grossUsdt: '100.000000', payments: 1, effectiveRateBps: expect.any(Number) });
    const dashboard = (await f.call('/v1/dashboard')).body;
    expect(dashboard.feeTerms).toEqual({ accepted: true, acceptedVersion: 1, latestVersion: 1 });
    expect(dashboard.gasTank).toBeUndefined();
    expect(BigInt(dashboard.metrics.feesUsdt.replace('.', ''))).toBeGreaterThan(800_000n);
    await new Indexer(f.db, f.chain).poll();
  });
});
