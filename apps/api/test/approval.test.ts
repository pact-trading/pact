import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { encodeFunctionData, keccak256, parseTransaction, encodeAbiParameters, encodeEventTopics, TransactionReceiptNotFoundError, type Hex } from 'viem';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain, escrowAbi } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { createApp } from '../src/app.js';
import { ApprovalService, USDT, type ApprovalConfig } from '../src/approval.js';
import { ViemApprovalChain, permitAbi, permitCalldata } from '../src/approval-chain.js';
import { intentTypedData, permitTypedData } from '../src/typed-data.js';
import { runLegacyTestKeeper as runKeeper } from './helpers/legacy-keeper.js';

const payer = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const stranger = privateKeyToAccount(`0x${'2'.repeat(64)}`);
const router = '0x0000000000000000000000000000000000000001';
const escrow = '0x0000000000000000000000000000000000000002' as const;
const subscription = '0x0000000000000000000000000000000000000003';
function fixture(config: Partial<ApprovalConfig> = {}) {
  // These tests cover the USDT permit path (mainnet USDT, financed invoices, subscriptions): no one-signature checkout.
  const db = openDb(); const chain = new FakeChain(); chain.collectorEnabled = false; const keys = seedMerchant(db, payer.address);
  chain.accepted.set(payer.address.toLowerCase(), 1);
  const relayer = new Relayer(chain, router, allowedTargets({ escrow, subscription }));
  const approval = new ApprovalService(db, chain, { enabled: true, escrow, minimumAmount: 1_000_000n, ...config });
  const app = createApp({ db, chain, relayer, approval });
  const post = (path: string, body: unknown, key = keys.secretKey) => app.request(path, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body, (_, v) => typeof v === 'bigint' ? v.toString() : v) });
  const get = (path: string, key = keys.secretKey) => app.request(path, { headers: { authorization: `Bearer ${key}` } });
  return { db, chain, keys, approval, post, get, relayer };
}
/** Signs the permit typed data a readiness offer carries, as a browser wallet does. */
async function signOffer(account: PrivateKeyAccount, typed: { domain: Record<string, unknown>; message: Record<string, string> }) {
  const m = typed.message;
  return account.signTypedData(permitTypedData(m.owner as Hex, m.spender as Hex, BigInt(m.value), BigInt(m.nonce), BigInt(m.deadline)));
}

describe('hosted approval', () => {
  it('requires secret authentication on both approval routes', async () => {
    const f = fixture(); const p = await (await f.post('/v1/payments', { amount: '2' })).json();
    expect((await f.get(`/v1/payments/${p.id}/approval?payer=${payer.address}`, f.keys.publishableKey)).status).toBe(403);
    expect((await f.post(`/v1/payments/${p.id}/approval`, {}, f.keys.publishableKey)).status).toBe(403);
  });
  it('offers an exact, bounded USDT permit to a funded zero-WBT payer', async () => {
    const f = fixture(); const p = await (await f.post('/v1/payments', { amount: '2' })).json();
    const r = await (await f.get(`/v1/payments/${p.id}/approval?payer=${payer.address}`)).json();
    expect(r).toMatchObject({ status: 'needs_approval', amount: '2000000', spender: escrow, permitNonce: '0' });
    expect(r.typedData).toMatchObject({ primaryType: 'Permit', domain: { name: 'Tether USD', version: '1', chainId: 1874, verifyingContract: USDT }, message: { owner: payer.address, spender: escrow, value: '2000000', nonce: '0' } });
    expect(Number(r.deadline)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300);
  });
});

type Fixture = ReturnType<typeof fixture>;
async function payment(f: Fixture, amount = '2') { return (await (await f.post('/v1/payments', { amount })).json()).id as Hex; }
const path = (id: string) => `/v1/payments/${id}/approval`;
const read = async (f: Fixture, id: string) => (await f.get(`${path(id)}?payer=${payer.address}`)).json();
async function body(f: Fixture, id: string) {
  const r = await read(f, id);
  return { payer: payer.address, deadline: r.deadline as string, signature: await signOffer(payer, r.typedData) } as Record<string, unknown>;
}
async function start(f: Fixture) {
  const id = await payment(f); const b = await body(f, id);
  const response = await f.post(path(id), b); expect(response.status).toBe(200);
  const r = await response.json(); expect(r.status).toBe('pending'); return { id, b, hash: r.txHash as Hex };
}
function settled(f: Fixture, hash: Hex, overrides = {}) {
  f.chain.block = 12n;
  f.chain.approval.state.allowance = 2_000_000n;
  f.chain.approval.state.nonce = 1n;
  f.chain.approval.receipts.set(hash, { hash, block: 10n, status: 'success', approvals: [{ owner: payer.address, spender: escrow, value: 2_000_000n }], ...overrides });
}
async function signedCharge(id: Hex, nonce = 1n) {
  const data = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [id, payer.address, 2_000_000n, 2592000n] });
  const intent = { signer: payer.address, merchant: payer.address, target: escrow, dataHash: keccak256(data), amount: 2_000_000n, nonce, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), maxGas: 400000 };
  return { intent, data, signature: await payer.signTypedData(intentTypedData(intent, router)) };
}
const wire = (x: unknown) => JSON.parse(JSON.stringify(x, (_, v) => typeof v === 'bigint' ? v.toString() : v));

describe('approval validation and spending bounds', () => {
  it('persists bound payer, budget and exact tx hash before first broadcast', async () => {
    const f = fixture();
    vi.spyOn(f.chain.approval, 'broadcast').mockImplementation(async raw => {
      const row = f.db.prepare('SELECT * FROM approval_attempts').get() as Record<string, string>;
      expect(row).toMatchObject({ tx_hash: keccak256(raw), status: 'pending', amount_minor: '2000000', payer: payer.address.toLowerCase(), token: USDT, spender: escrow, approval_nonce: '0', cost_wei: '120000000000000' });
      expect(f.db.prepare('SELECT payer FROM payments WHERE id=?').get(row.payment_id)).toEqual({ payer: payer.address.toLowerCase() });
      return keccak256(raw);
    });
    await start(f);
    expect(f.chain.approval.prepared[0]).toMatchObject({ gas: 120_000n, price: 1_000_000_000n, nonce: 0, call: { owner: payer.address, spender: escrow, value: 2_000_000n } });
    // Pact absorbed this permit's gas: it counts against the merchant's sponsorship budget.
    expect(f.db.prepare('SELECT merchant_id,cost_wei,kind FROM sponsored_spend').all()).toEqual([{ merchant_id: f.keys.merchantId, cost_wei: '120000000000000', kind: 'approval' }]);
  });
  it('uses the token nonce the payer signed against', async () => {
    const f = fixture(); f.chain.approval.state.nonce = 7n;
    const id = await payment(f); const r = await read(f, id);
    expect(r.permitNonce).toBe('7');
    expect((await f.post(path(id), { payer: payer.address, deadline: r.deadline, signature: await signOffer(payer, r.typedData) })).status).toBe(200);
    expect(f.chain.approval.prepared[0].call.value).toBe(2_000_000n);
  });
  it('keeps disabled or unconfigured GET safe while exposing balance', async () => {
    for (const config of [{ enabled: false }, { escrow: '0x0000000000000000000000000000000000000000' as const }]) {
      const f = fixture(config); const id = await payment(f); const r = await read(f, id);
      expect(r).toMatchObject({ status: 'unavailable', payer: payer.address, amount: '2000000', permitNonce: null, typedData: null, deadline: null });
      expect(r.reason).toBe(config.enabled === false ? 'feature_disabled' : 'approval_unconfigured');
      expect((await f.post(path(id), { payer: payer.address })).status).toBe(422);
      expect(f.chain.approval.prepared).toHaveLength(0);
    }
  });
  it.each([['chain', 'wrong_chain'], ['rpc', 'rpc_unavailable']])('fails closed for %s with no permit offer', async (kind, reason) => {
    const f = fixture(); const id = await payment(f);
    if (kind === 'chain') vi.spyOn(f.chain, 'chainId').mockResolvedValue(1);
    if (kind === 'rpc') vi.spyOn(f.chain.approval, 'snapshot').mockRejectedValue(new Error('private RPC detail'));
    expect(await read(f, id)).toMatchObject({ status: 'unavailable', reason, permitNonce: null, typedData: null });
    expect(f.chain.approval.prepared).toHaveLength(0);
  });
  it('does not subsidize an unfunded, dust, expired, closed, or foreign payment', async () => {
    const f = fixture(); const id = await payment(f); const b = await body(f, id);
    f.chain.approval.state.balance = 1n;
    expect(await read(f, id)).toMatchObject({ status: 'needs_funding', reason: 'insufficient_usdt' });
    expect((await f.post(path(id), b)).status).toBe(422);
    f.chain.approval.state.balance = 10_000_000n;
    const dust = await payment(f, '0.5'); expect(await read(f, dust)).toMatchObject({ status: 'unavailable', reason: 'below_minimum' });
    f.db.prepare('UPDATE payments SET expires_at=? WHERE id=?').run('2000-01-01T00:00:00Z', id);
    expect(await read(f, id)).toMatchObject({ reason: 'payment_expired' });
    f.db.prepare("UPDATE payments SET status='captured',expires_at=NULL WHERE id=?").run(id);
    expect(await read(f, id)).toMatchObject({ reason: 'payment_not_open' });
    const other = seedMerchant(f.db, escrow);
    expect((await f.get(`${path(id)}?payer=${payer.address}`, other.secretKey)).status).toBe(422);
    expect(f.chain.approval.prepared).toHaveLength(0);
  });
  it.each(['nonce', 'expired', 'long_deadline', 'signer', 'value', 'spender', 'high_s', 'token', 'privateKey'])('rejects an invalid permit (%s) before any write', async kind => {
    const f = fixture(); const id = await payment(f); const b = await body(f, id);
    const r = await read(f, id), deadline = BigInt(r.deadline);
    if (kind === 'nonce') b.nonce = '9';
    if (kind === 'expired') b.deadline = '1';
    if (kind === 'long_deadline') b.deadline = String(Math.floor(Date.now() / 1000) + 600);
    if (kind === 'signer') b.signature = await stranger.signTypedData(permitTypedData(payer.address, escrow, 2_000_000n, 0n, deadline));
    if (kind === 'value') b.signature = await payer.signTypedData(permitTypedData(payer.address, escrow, 2n ** 255n, 0n, deadline));
    if (kind === 'spender') b.signature = await payer.signTypedData(permitTypedData(payer.address, router, 2_000_000n, 0n, deadline));
    if (kind === 'high_s') b.signature = `${String(b.signature).slice(0, 66)}${'f'.repeat(64)}1b`;
    if (['token', 'privateKey'].includes(kind)) b[kind] = 'not allowed';
    expect((await f.post(path(id), b)).status).toBe(422);
    expect(f.chain.approval.prepared).toHaveLength(0);
    expect(f.db.prepare('SELECT * FROM approval_attempts').all()).toEqual([]);
  });
  it('never falls back from failed nonce reads to zero', async () => {
    const f = fixture(); const id = await payment(f); const b = await body(f, id);
    vi.spyOn(f.chain.approval, 'snapshot').mockRejectedValue(new Error('nonce read failed'));
    expect((await read(f, id)).permitNonce).toBeNull();
    expect((await f.post(path(id), b)).status).toBe(503);
    expect(f.chain.approval.prepared).toHaveLength(0);
  });
  it('deduplicates concurrent POST and binds the payer', async () => {
    const f = fixture(); const id = await payment(f); const b = await body(f, id);
    const rs = await Promise.all([f.post(path(id), b), f.post(path(id), b)]);
    expect(rs.map(r => r.status)).toEqual([200, 200]);
    expect(f.chain.approval.broadcasts).toHaveLength(1);
    expect((await f.get(`${path(id)}?payer=${escrow}`)).status).toBe(422);
    expect((await f.post(path(id), { ...b, payer: escrow })).status).toBe(422);
  });
  it('enforces durable count and cost budgets after confirmation and restart', async () => {
    for (const limits of [{ maxPerMinute: 1 }, { maxSpendPerMinute: 120_000_000_000_000n }]) {
      const f = fixture(limits); const a = await start(f); settled(f, a.hash); await read(f, a.id);
      f.chain.approval.state.allowance = 0n;
      const id = await payment(f);
      expect(await read(f, id)).toMatchObject({ reason: 'approval_budget' });
      const restarted = new ApprovalService(f.db, f.chain, { enabled: true, escrow, minimumAmount: 1_000_000n, ...limits });
      expect(await restarted.get(id, f.keys.merchantId, payer.address)).toMatchObject({ reason: 'approval_budget' });
      expect(f.chain.approval.broadcasts).toHaveLength(1);
    }
  });
  it('enforces price and hard configuration caps', async () => {
    const f = fixture(); const id = await payment(f); const b = await body(f, id);
    f.chain.price = 20_000_000_001n;
    expect(await read(f, id)).toMatchObject({ reason: 'approval_gas_price' });
    expect((await f.post(path(id), b)).status).toBe(422);
    expect(() => fixture({ gas: 300_001n })).toThrow('Invalid approval limits');
    expect(() => fixture({ maxPerMinute: 61 })).toThrow('Invalid approval limits');
  });
  it('refuses once the merchant has used its sponsorship budget for the day', async () => {
    const f = fixture(); const id = await payment(f); const b = await body(f, id);
    f.db.prepare('INSERT INTO sponsored_spend VALUES (?,?,?,?,?,?)').run('op_full', f.keys.merchantId, new Date().toISOString().slice(0, 10), '50000000000000000', 'intent', new Date().toISOString());
    const response = await f.post(path(id), b);
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe('sponsorship_budget');
    expect(f.chain.approval.prepared).toHaveLength(0);
  });
});

describe('approval receipt and uncertain send reconciliation', () => {
  it('requires confirmation depth and the token Approval event before ready', async () => {
    const f = fixture(); const a = await start(f); settled(f, a.hash);
    f.chain.block = 11n; expect(await read(f, a.id)).toMatchObject({ status: 'pending' });
    f.chain.block = 12n; expect(await read(f, a.id)).toMatchObject({ status: 'ready', allowance: '2000000' });
    expect(await read(f, a.id)).toMatchObject({ status: 'ready' });
    expect((await (await f.post(path(a.id), a.b)).json()).status).toBe('ready');
    expect(f.chain.approval.broadcasts).toHaveLength(1);
  });
  it('keeps a failing read pending, never resends, and settles once reads work again', async () => {
    const f = fixture();
    const broadcast = f.chain.approval.broadcast.bind(f.chain.approval);
    vi.spyOn(f.chain.approval, 'broadcast').mockImplementation(async raw => { await broadcast(raw); throw new Error('accepted but timeout'); });
    const a = await start(f); settled(f, a.hash);
    const receipt = vi.spyOn(f.chain.approval, 'receipt').mockRejectedValue(new Error('read unavailable'));
    expect(await read(f, a.id)).toMatchObject({ status: 'pending' });
    await f.post(path(a.id), a.b);
    expect(f.chain.approval.broadcasts).toHaveLength(1);
    receipt.mockRestore();
    expect((await read(f, a.id)).status).toBe('ready');
    expect(f.chain.approval.broadcasts).toHaveLength(1);
  });
  it.each(['missing', 'wrong_value', 'wrong_owner', 'wrong_spender'])('does not claim success for %s', async kind => {
    const f = fixture();
    const broadcast = f.chain.approval.broadcast.bind(f.chain.approval);
    vi.spyOn(f.chain.approval, 'broadcast').mockImplementation(async raw => { await broadcast(raw); throw new Error('accepted but timeout'); });
    const a = await start(f); settled(f, a.hash);
    const r = f.chain.approval.receipts.get(a.hash) as Exclude<Awaited<ReturnType<typeof f.chain.approval.receipt>>, null>;
    if (kind === 'missing') r.approvals = [];
    if (kind === 'wrong_value') r.approvals[0].value = 1n;
    if (kind === 'wrong_owner') r.approvals[0].owner = escrow;
    if (kind === 'wrong_spender') r.approvals[0].spender = USDT;
    expect(await read(f, a.id)).toMatchObject({ status: 'unavailable', reason: 'missing_approval_event' });
    await f.post(path(a.id), a.b);
    expect(f.chain.approval.broadcasts).toHaveLength(1);
    expect(f.chain.writer.rows()[0].phase).toBe('confirmed');
    await expect(f.chain.renew(`0x${'a'.repeat(64)}`, 1n)).resolves.toBeDefined();
    expect(f.chain.writer.rows()[1].nonce).toBe(1);
  });
  it('keeps null/wrong-hash/RPC receipts pending and does not resend', async () => {
    const f = fixture(); const a = await start(f);
    for (const r of [null, new Error('RPC unavailable'), { hash: `0x${'a'.repeat(64)}` as Hex, block: 0n, status: 'reverted' as const, approvals: [] }]) {
      f.chain.approval.receipts.set(a.hash, r); f.chain.block = 100n;
      expect(await read(f, a.id)).toMatchObject({ status: 'pending' });
      await f.post(path(a.id), a.b);
    }
    expect(f.chain.approval.broadcasts).toHaveLength(1);
  });
  it('fails confirmed reverted approval without changing payment amounts or retrying', async () => {
    const f = fixture(); const a = await start(f); settled(f, a.hash, { status: 'reverted' });
    expect(await read(f, a.id)).toMatchObject({ status: 'unavailable', reason: 'transaction_reverted' });
    expect(f.db.prepare('SELECT status,captured_minor,refunded_minor FROM payments WHERE id=?').get(a.id)).toEqual({ status: 'open', captured_minor: '0', refunded_minor: '0' });
    await f.post(path(a.id), a.b); expect(f.chain.approval.broadcasts).toHaveLength(1);
    await expect(f.chain.renew(`0x${'a'.repeat(64)}`, 1n)).resolves.toBeDefined();
  });
  it('persists ambiguous broadcast hash and its signed bytes across restart without holding other writers', async () => {
    const f = fixture(); vi.spyOn(f.chain.approval, 'broadcast').mockRejectedValue(new Error('timeout after acceptance'));
    const a = await start(f); expect(await read(f, a.id)).toMatchObject({ status: 'pending', reason: 'broadcast_uncertain', txHash: a.hash });
    const restarted = new FakeChain(); restarted.collectorEnabled = false;
    const approval = new ApprovalService(f.db, restarted, { enabled: true, escrow, minimumAmount: 1_000_000n });
    expect(await approval.get(a.id, f.keys.merchantId, payer.address)).toMatchObject({ status: 'pending' });
    // The ambiguous permit keeps nonce 0 and its exact bytes for the watchdog; later writes take later nonces.
    expect(restarted.writer.unsettled().map(r => [r.kind, r.nonce, r.tx_hash])).toEqual([['approval', 0, a.hash]]);
    await expect(restarted.renew(`0x${'a'.repeat(64)}`, 1n)).resolves.toBeDefined();
    expect(restarted.writer.rows().map(r => r.nonce)).toEqual([0, 1]);
    settled(f, a.hash); await read(f, a.id);
    expect(f.db.prepare('SELECT * FROM relayer_write_block').all()).toEqual([]);
    expect(f.chain.approval.prepared).toHaveLength(1);
  });
  it('releases definite local signing failures without inventing a hash', async () => {
    const f = fixture(); vi.spyOn(f.chain.approval, 'prepare').mockRejectedValue(new Error('signer unavailable'));
    const id = await payment(f), b = await body(f, id);
    expect((await (await f.post(path(id), b)).json()).status).toBe('unavailable');
    expect(await read(f, id)).toMatchObject({ status: 'unavailable', reason: 'preparation_failed', txHash: null });
    await f.post(path(id), b); expect(f.chain.approval.broadcasts).toHaveLength(0);
    await expect(f.chain.renew(`0x${'a'.repeat(64)}`, 1n)).resolves.toBeDefined();
  });
});

describe('payment readiness and account serialization', () => {
  it('reserves a payment before broadcast and rejects concurrent different nonces', async () => {
    const f = fixture();
    f.chain.approval.state.allowance = 2_000_000n;
    const id = await payment(f);
    const rs = await Promise.all([f.post('/v1/intents', wire(await signedCharge(id, 1n))), f.post('/v1/intents', wire(await signedCharge(id, 2n)))]);
    expect(rs.map(r => r.status).sort()).toEqual([200, 422]);
    expect(f.chain.sent).toHaveLength(1);
    expect(await read(f, id)).toMatchObject({ status: 'pending', reason: 'payment_pending', txHash: f.chain.sent[0].hash });
  });
  it('keeps an ambiguous charge pending with no second send after refresh', async () => {
    const f = fixture();
    const id = await payment(f); vi.spyOn(f.chain, 'broadcastTransaction').mockRejectedValue(new Error('timeout'));
    expect((await f.post('/v1/intents', wire(await signedCharge(id)))).status).toBe(200);
    expect(await read(f, id)).toMatchObject({ status: 'pending', reason: 'payment_pending', txHash: f.chain.writer.rows()[0].tx_hash });
    expect((await f.post('/v1/intents', wire(await signedCharge(id, 2n)))).status).toBe(422);
    expect(f.chain.broadcastTransaction).toHaveBeenCalledTimes(1);
  });
  it('uses a single nonce sequence for intents, renewals, subscriptions, then approval', async () => {
    const f = fixture();
    const id = await payment(f);
    // Simulate a slow/stale RPC pending count: the shared reservation still advances.
    vi.spyOn(f.chain, 'transactionCount').mockResolvedValue(0);
    await Promise.all([
      f.relayer.submit(await signedCharge(id)),
      f.chain.renew(`0x${'a'.repeat(64)}`, 1n),
      f.chain.subscribe({ payer: payer.address, merchant: payer.address, planId: `0x${'b'.repeat(64)}`, amountCap: 1n, periodSeconds: 1n, maxPeriods: 1, endTime: 9999999999n, nonce: 0n }, '0x'),
    ]);
    await start(f);
    expect(f.chain.writer.rows().map(r => r.nonce)).toEqual([0, 1, 2, 3]);
    expect(f.chain.approval.prepared[0].nonce).toBe(3);
  });
});

describe('Viem approval adapter evidence', () => {
  const fakeKey = `0x${'4'.repeat(64)}` as Hex;
  it('signs a bounded legacy transaction to USDT, with zero value and the exact permit calldata', async () => {
    const adapter = new ViemApprovalChain('http://unused.invalid', privateKeyToAccount(fakeKey));
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    const call = { owner: payer.address, spender: escrow, value: 2_000_000n, deadline, signature: await payer.signTypedData(permitTypedData(payer.address, escrow, 2_000_000n, 3n, deadline)) };
    const tx = await adapter.prepare(call, 11, 120_000n, 5_000_000_000n);
    expect(tx.hash).toBe(keccak256(tx.raw));
    const decoded = parseTransaction(tx.raw);
    expect(decoded).toMatchObject({ type: 'legacy', chainId: 1874, nonce: 11, to: USDT.toLowerCase(), gas: 120_000n, gasPrice: 5_000_000_000n });
    expect(decoded.value ?? 0n).toBe(0n);
    expect(decoded.data).toBe(permitCalldata(call));
    const permit = (await import('viem')).decodeFunctionData({ abi: permitAbi, data: decoded.data! });
    expect(permit.functionName).toBe('permit');
    expect(permit.args!.slice(0, 4)).toEqual([payer.address, escrow, 2_000_000n, deadline]);
  });
  it('reads balance, allowance and the permit nonce at one block, never defaulting a failed read', async () => {
    const adapter = new ViemApprovalChain('http://unused.invalid', privateKeyToAccount(fakeKey));
    const readContract = vi.fn().mockImplementation(async ({ functionName }: { functionName: string }) => ({ balanceOf: 5_000_000n, allowance: 2_000_000n, nonces: 9n })[functionName]);
    const client = { getBlockNumber: vi.fn().mockResolvedValue(10n), readContract };
    Object.assign(adapter, { public: client });
    expect(await adapter.snapshot(payer.address, escrow)).toEqual({ balance: 5_000_000n, allowance: 2_000_000n, nonce: 9n });
    expect(readContract.mock.calls.every(([args]) => (args as { blockNumber: bigint }).blockNumber === 10n)).toBe(true);
    readContract.mockRejectedValueOnce(new Error('RPC failure'));
    await expect(adapter.snapshot(payer.address, escrow)).rejects.toThrow('RPC failure');
  });
  it('accepts only the token Approval event for the owner and distinguishes receipt absence from RPC failure', async () => {
    const adapter = new ViemApprovalChain('http://unused.invalid', privateKeyToAccount(fakeKey));
    const hash = `0x${'a'.repeat(64)}` as Hex;
    const log = { address: USDT, topics: encodeEventTopics({ abi: permitAbi, eventName: 'Approval', args: { owner: payer.address, spender: escrow } }), data: encodeAbiParameters([{ type: 'uint256' }], [2_000_000n]) };
    const foreign = { ...log, address: escrow };
    const other = { ...log, topics: encodeEventTopics({ abi: permitAbi, eventName: 'Approval', args: { owner: stranger.address, spender: escrow } }) };
    const getTransactionReceipt = vi.fn().mockResolvedValue({ transactionHash: hash, blockNumber: 10n, status: 'success', logs: [foreign, other, log] });
    Object.assign(adapter, { public: { getTransactionReceipt } });
    const receipt = await adapter.receipt(hash, payer.address);
    expect(receipt?.approvals).toEqual([{ owner: payer.address, spender: escrow, value: 2_000_000n }]);
    getTransactionReceipt.mockRejectedValueOnce(new TransactionReceiptNotFoundError({ hash }));
    expect(await adapter.receipt(hash, payer.address)).toBeNull();
    getTransactionReceipt.mockRejectedValueOnce(new Error('RPC timeout'));
    await expect(adapter.receipt(hash, payer.address)).rejects.toThrow('RPC timeout');
  });
});

describe('keeper shared-account holds', () => {
  it('leaves subscriptions unchanged while the relayer account is stuck behind an unbroadcastable nonce', async () => {
    const f = fixture(); vi.spyOn(f.chain.approval, 'broadcast').mockRejectedValue(new Error('timeout')); await start(f);
    f.chain.writer.stuck = 'nonce 0 cannot be broadcast: insufficient funds';
    f.db.prepare('INSERT INTO plans(id,merchant_id,name,amount_minor,period_seconds,max_periods,created_at) VALUES (?,?,?,?,?,?,?)').run('plan_hold', f.keys.merchantId, 'Plan', '2000000', 86400, 12, new Date().toISOString());
    f.db.prepare('INSERT INTO subscriptions(id,merchant_id,plan_id,chain_id,payer,status,next_charge_at,retry_count,pending_tx_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('sub_hold', f.keys.merchantId, 'plan_hold', `0x${'a'.repeat(64)}`, payer.address, 'active', new Date(0).toISOString(), 0, null, new Date().toISOString());
    await runKeeper(f.db, f.chain); await runKeeper(f.db, f.chain);
    expect(f.db.prepare('SELECT status,retry_count,pending_tx_hash FROM subscriptions WHERE id=?').get('sub_hold')).toEqual({ status: 'active', retry_count: 0, pending_tx_hash: null });
    expect(f.chain.approval.broadcast).toHaveBeenCalledTimes(1);
  });
});

describe('approval journal restart boundaries', () => {
  it.each(['reserved', 'nonce', 'signed', 'broadcasting'] as const)('recovers an approval interrupted at %s without an automatic resend', async phase => {
    const f = fixture(); let snapshot: Buffer | undefined;
    const prepareSql = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, 'prepare').mockImplementation(((sql: string) => {
      const statement = prepareSql(sql);
      if ((phase === 'reserved' && sql.startsWith('UPDATE relayer_operations SET nonce=')) || (phase === 'signed' && sql.includes("SET phase='broadcasting'"))) {
        const run = statement.run.bind(statement); statement.run = ((...args: unknown[]) => { snapshot = f.db.serialize(); return run(...args); }) as typeof statement.run;
      }
      return statement;
    }) as typeof f.db.prepare);
    const prepare = f.chain.approval.prepare.bind(f.chain.approval);
    vi.spyOn(f.chain.approval, 'prepare').mockImplementation(async (...args) => { if (phase === 'nonce') snapshot = f.db.serialize(); return prepare(...args); });
    const broadcast = f.chain.approval.broadcast.bind(f.chain.approval);
    vi.spyOn(f.chain.approval, 'broadcast').mockImplementation(async raw => { if (phase === 'broadcasting') snapshot = f.db.serialize(); return broadcast(raw); });
    const a = await start(f);
    const db = new Database(snapshot!); const chain = new FakeChain(); chain.collectorEnabled = false;
    const approval = new ApprovalService(db, chain, { enabled: true, escrow, minimumAmount: 1_000_000n });
    try {
      if (phase === 'broadcasting') {
        expect(await approval.get(a.id, f.keys.merchantId, payer.address)).toMatchObject({ status: 'pending', txHash: a.hash });
        // Interrupted mid-broadcast, with its signed bytes journaled: other writes proceed at the next nonce.
        await expect(chain.renew(`0x${'a'.repeat(64)}`, 1n)).resolves.toBeDefined();
        chain.block = 12n; chain.approval.receipts.set(a.hash, { hash: a.hash, block: 10n, status: 'success', approvals: [] });
        expect(await approval.get(a.id, f.keys.merchantId, payer.address)).toMatchObject({ status: 'unavailable', reason: 'missing_approval_event' });
        expect(chain.writer.rows()[0].phase).toBe('confirmed');
      } else {
        expect(await approval.get(a.id, f.keys.merchantId, payer.address)).toMatchObject({ status: 'unavailable', reason: 'interrupted_before_broadcast' });
        expect(chain.writer.rows()[0].phase).toBe('not_sent');
      }
      await approval.submit(a.id, f.keys.merchantId, a.b);
      expect(chain.approval.broadcasts).toHaveLength(0);
      await chain.renew(`0x${'b'.repeat(64)}`, 1n);
      expect(chain.writer.rows()[1].nonce).toBe(phase === 'broadcasting' ? 1 : 0);
    } finally { db.close(); }
  });
});
