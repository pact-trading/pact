import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FakeChain, ViemChain, escrowAbi, subscriptionAbi } from '../src/chain.js';
import { openDb, seedMerchant, type Db } from '../src/db.js';
import { createApp } from '../src/app.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { intentTypedData } from '../src/typed-data.js';
import { Indexer } from '../src/indexer.js';
import type { ChainEvent, IntentRequest } from '../src/types.js';
import type { WriteOperation } from '../src/account-writer.js';
import { reserveRenewal } from '../src/write-reservations.js';
import { Refusal } from '../src/types.js';

const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const addresses = { router: '0x0000000000000000000000000000000000000001', escrow: '0x0000000000000000000000000000000000000002', subscription: '0x0000000000000000000000000000000000000003', gasTank: '0x0000000000000000000000000000000000000004' } as const;
const files: string[] = [], databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); for (const dir of files.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const wire = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
function fixture(db = openDb()) {
  databases.push(db); const chain = new FakeChain(); const keys = seedMerchant(db, account.address);
  chain.tank.set(account.address.toLowerCase(), { balanceWei: 10n ** 18n, dailyCapWei: 10n ** 18n, spentTodayWei: 0n });
  const relayer = new Relayer(chain, addresses.router, allowedTargets(addresses.escrow, addresses.subscription));
  const app = createApp({ db, chain, relayer, ...addresses });
  const post = async (path: string, body: unknown) => {
    // Recover historical direct-renewal journal images through the low-level
    // adapter only. The runtime HTTP endpoint now requires the funded service.
    if (path === '/v1/subscriptions/sub_test/renew') {
      try {
        const sub = db.prepare('SELECT chain_id FROM subscriptions WHERE id=?').get('sub_test') as { chain_id: Hex };
        const operation = reserveRenewal(db, chain, 'sub_test');
        const txHash = await chain.renew(sub.chain_id, 2_000_000n, operation);
        return Response.json({ txHash });
      } catch (error) { return Response.json({ error: { code: error instanceof Refusal ? error.code : 'invalid_request' } }, { status: error instanceof Refusal ? 422 : 400 }); }
    }
    return app.request(path, { method: 'POST', headers: { authorization: `Bearer ${keys.secretKey}`, 'content-type': 'application/json' }, body: wire(body) });
  };
  return { db, chain, keys, relayer, app, post };
}
function restart(snapshot: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'gol-writer-test-')); files.push(dir);
  const file = join(dir, 'db.sqlite'); writeFileSync(file, snapshot);
  const db = openDb(file); databases.push(db); const chain = new FakeChain(); chain.writer.bind(db);
  return { db, chain };
}
async function intent(data: Hex, nonce = 1n, target: Hex = addresses.escrow, amount = 2_000_000n): Promise<IntentRequest> {
  const value = { signer: account.address, merchant: account.address, target, dataHash: keccak256(data), amount, feeUSDT: 10000n, nonce, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), maxGas: 400000 };
  return { intent: value, data, signature: await account.signTypedData(intentTypedData(value, addresses.router)) };
}
type Kind = 'payment' | 'refund' | 'cancel' | 'subscribe' | 'renew';
async function setup(kind: Kind) {
  const f = fixture();
  const paymentId = (await (await f.post('/v1/payments', { amount: '2' })).json()).id as Hex;
  const plan = (await (await f.post('/v1/subscriptions/plans', { name: 'Plan', amount: '2', periodSeconds: 86400, maxPeriods: 12 })).json());
  const subChainId = keccak256(toHex('test-subscription'));
  if (['renew', 'cancel'].includes(kind)) f.db.prepare('INSERT INTO subscriptions(id,merchant_id,plan_id,chain_id,payer,status,next_charge_at,retry_count,pending_tx_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('sub_test', f.keys.merchantId, plan.id, subChainId, account.address, 'active', '2026-11-06T00:00:00.000Z', 0, null, new Date().toISOString());
  let path: string, body: unknown, request: IntentRequest | undefined, targetEvent: { contract: ChainEvent['contract']; name: string; args: ChainEvent['args'] };
  if (kind === 'payment') {
    request = await intent(encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [paymentId, account.address, 2_000_000n, 2592000n] })); path = '/v1/intents'; body = request;
    targetEvent = { contract: 'escrow', name: 'Charged', args: { id: paymentId, payer: account.address, merchant: account.address, amount: 2_000_000n } };
  } else if (kind === 'refund') {
    f.db.prepare("UPDATE payments SET status='captured',captured_minor='2000000',payer=? WHERE id=?").run(account.address, paymentId);
    const reason = keccak256(toHex('Customer request'));
    request = await intent(encodeFunctionData({ abi: escrowAbi, functionName: 'refund', args: [paymentId, 1_000_000n, reason] }), 1n, addresses.escrow, 1_000_000n);
    path = `/v1/payments/${paymentId}/refund`; body = { ...request, amount: '1', reason: 'Customer request' };
    targetEvent = { contract: 'escrow', name: 'Refunded', args: { id: paymentId, amount: 1_000_000n, reason } };
  } else if (kind === 'cancel') {
    request = await intent(encodeFunctionData({ abi: subscriptionAbi, functionName: 'cancel', args: [subChainId] }), 1n, addresses.subscription);
    path = '/v1/subscriptions/sub_test/cancel'; body = request;
    targetEvent = { contract: 'subscription', name: 'Cancelled', args: { id: subChainId } };
  } else if (kind === 'renew') {
    path = '/v1/subscriptions/sub_test/renew'; body = {};
    targetEvent = { contract: 'subscription', name: 'Charged', args: { id: subChainId, amount: 2_000_000n, period: 1 } };
  } else {
    const mandate = { payer: account.address, merchant: account.address, planId: keccak256(toHex(plan.id)), amountCap: 2_000_000n, periodSeconds: 86400n, maxPeriods: 12, endTime: BigInt(Math.floor(Date.now() / 1000) + 90000), nonce: 0n };
    const signature = await account.signTypedData({ domain: { name: 'Settle Subscription', version: '1', chainId: 1874, verifyingContract: addresses.subscription }, types: { Mandate: [{ name: 'payer', type: 'address' }, { name: 'merchant', type: 'address' }, { name: 'planId', type: 'bytes32' }, { name: 'amountCap', type: 'uint256' }, { name: 'periodSeconds', type: 'uint64' }, { name: 'maxPeriods', type: 'uint32' }, { name: 'endTime', type: 'uint64' }, { name: 'nonce', type: 'uint256' }] }, primaryType: 'Mandate', message: mandate });
    path = '/v1/subscriptions'; body = { planId: plan.id, mandate, signature };
    targetEvent = { contract: 'subscription', name: 'Subscribed', args: { id: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'address' }], [account.address, 0n, addresses.subscription])), payer: account.address, merchant: account.address, planId: mandate.planId } };
  }
  function receipt(hash: Hex, status: 'success' | 'reverted' = 'success') {
    const events: ChainEvent[] = [{ ...targetEvent, id: `${hash}:0`, block: 10n, txHash: hash }];
    if (request) events.push({ id: `${hash}:1`, block: 10n, txHash: hash, contract: 'router', name: 'Executed', args: { signer: account.address, merchant: account.address, target: request.intent.target, nonce: request.intent.nonce, reimbursement: 0n, feeUSDT: 10000n } });
    return { txHash: hash, block: 10n, status, events: status === 'success' ? events : [] };
  }
  return { ...f, path, body, paymentId, request, receipt };
}

const kinds: Kind[] = ['payment', 'refund', 'cancel', 'subscribe', 'renew'];
describe('domain state during preparation failure', () => {
  it('preserves an indexed cancellation when renewal preparation fails', async () => {
    const f = await setup('renew');
    vi.spyOn(f.chain, 'prepareRenew').mockImplementation(async () => {
      // The background indexer can observe a payer cancellation while an RPC read is in flight.
      f.db.prepare("UPDATE subscriptions SET status='cancelled' WHERE id='sub_test'").run();
      throw new Error('Subscription was cancelled during preparation');
    });
    expect((await f.post(f.path, f.body)).status).toBe(400);
    expect(f.db.prepare("SELECT status,pending_tx_hash FROM subscriptions WHERE id='sub_test'").get()).toEqual({ status: 'cancelled', pending_tx_hash: null });
    expect(f.chain.writer.rows()[0].phase).toBe('not_sent');
    expect(f.chain.sent).toHaveLength(0);
  });
});
describe.each(kinds)('%s durable broadcast recovery', kind => {
  it('recovers an accepted-but-timeout hash and domain state after restart without resending', async () => {
    const f = await setup(kind);
    let snapshot: Buffer | undefined;
    const broadcast = f.chain.broadcastTransaction.bind(f.chain);
    vi.spyOn(f.chain, 'broadcastTransaction').mockImplementation(async raw => {
      const row = f.chain.writer.rows()[0];
      expect(row).toMatchObject({ phase: 'broadcasting', nonce: 0, tx_hash: keccak256(raw), chain_id: 1874, relayer: f.chain.writer.relayer.toLowerCase() });
      const links = JSON.parse(row.links_json);
      if (links.intentId) expect(f.db.prepare('SELECT tx_hash FROM intents WHERE id=?').get(links.intentId)).toEqual({ tx_hash: row.tx_hash });
      if (links.refundId) expect(f.db.prepare('SELECT tx_hash,status FROM refunds WHERE id=?').get(links.refundId)).toEqual({ tx_hash: row.tx_hash, status: 'pending' });
      if (links.subscriptionId) expect(f.db.prepare('SELECT pending_tx_hash FROM subscriptions WHERE id=?').get(links.subscriptionId)).toEqual({ pending_tx_hash: row.tx_hash });
      await broadcast(raw); snapshot = f.db.serialize(); // Crash after node acceptance, before return/catch persistence.
      throw new Error('accepted then timeout');
    });
    const result = await f.post(f.path, f.body); expect(result.status).toBe(200);
    const hash = (await result.json()).txHash as Hex; expect(hash).toBe(f.chain.writer.rows()[0].tx_hash);
    expect(f.chain.writer.rows()[0].phase).toBe('uncertain');
    const recovered = restart(snapshot!);
    await expect(recovered.chain.renew(keccak256(toHex('unrelated')), 1n)).rejects.toMatchObject({ code: 'relayer_pending' });
    recovered.chain.block = 12n;
    recovered.chain.receipts.set(hash, null); await new Indexer(recovered.db, recovered.chain, 13n).poll();
    expect(recovered.chain.writer.rows()[0].phase).toBe('broadcasting');
    recovered.chain.receipts.set(hash, new Error('RPC error')); await new Indexer(recovered.db, recovered.chain, 13n).poll();
    expect(recovered.chain.writer.rows()[0].phase).toBe('broadcasting');
    recovered.chain.receipts.set(hash, f.receipt(hash));
    recovered.chain.block = 11n; await new Indexer(recovered.db, recovered.chain, 13n).poll();
    expect(recovered.chain.writer.rows()[0].phase).toBe('broadcasting');
    recovered.chain.block = 12n; await new Indexer(recovered.db, recovered.chain, 13n).poll();
    expect(recovered.chain.writer.rows()[0].phase).toBe('confirmed');
    if (kind === 'payment') expect(recovered.db.prepare('SELECT status,captured_minor FROM payments WHERE id=?').get(f.paymentId)).toEqual({ status: 'captured', captured_minor: '2000000' });
    if (kind === 'refund') expect(recovered.db.prepare('SELECT status FROM refunds').get()).toEqual({ status: 'succeeded' });
    if (kind === 'cancel') expect(recovered.db.prepare('SELECT status,pending_tx_hash FROM subscriptions').get()).toEqual({ status: 'cancelled', pending_tx_hash: null });
    if (['renew', 'subscribe'].includes(kind)) expect(recovered.db.prepare('SELECT status,pending_tx_hash FROM subscriptions').get()).toEqual({ status: 'active', pending_tx_hash: null });
    // Fresh process has pending count zero: retained confirmed nonce wins.
    await recovered.chain.renew(keccak256(toHex('unrelated')), 1n);
    expect(recovered.chain.writer.rows().map(r => r.nonce)).toEqual([0, 1]);
    expect(recovered.chain.sent).toHaveLength(0); // Original operation was not resent.
  });
  it('keeps returned-but-unconfirmed identity through restart with a stale pending count', async () => {
    const f = await setup(kind); const response = await f.post(f.path, f.body); expect(response.status).toBe(200);
    const hash = (await response.json()).txHash as Hex;
    expect(f.chain.writer.rows()[0].phase).toBe('submitted');
    const r = restart(f.db.serialize());
    await r.chain.renew(keccak256(toHex('unrelated')), 1n);
    expect(r.chain.writer.rows().map(row => row.nonce)).toEqual([0, 1]);
    r.chain.block = 12n; r.chain.receipts.set(hash, f.receipt(hash));
    await new Indexer(r.db, r.chain, 13n).poll();
    expect(r.chain.writer.rows()[0].phase).toBe('confirmed');
    expect(r.chain.sent).toHaveLength(0);
  });
  it('releases the account after confirmed success without matching events while preserving business uncertainty', async () => {
    const f = await setup(kind); vi.spyOn(f.chain, 'broadcastTransaction').mockRejectedValue(new Error('timeout'));
    const response = await f.post(f.path, f.body); expect(response.status).toBe(200); const hash = (await response.json()).txHash;
    const before = f.db.prepare('SELECT captured_minor,refunded_minor FROM payments WHERE id=?').get(f.paymentId);
    f.chain.block = 12n; f.chain.receipts.set(hash, { ...f.receipt(hash), events: [] });
    await new Indexer(f.db, f.chain, 13n).poll();
    expect(f.chain.writer.rows()[0].phase).toBe('confirmed');
    expect(f.db.prepare('SELECT captured_minor,refunded_minor FROM payments WHERE id=?').get(f.paymentId)).toEqual(before);
    if (kind === 'refund') expect(f.db.prepare('SELECT status FROM refunds').get()).toEqual({ status: 'pending' });
    else if (['cancel', 'renew', 'subscribe'].includes(kind)) expect(f.db.prepare('SELECT status FROM subscriptions').get()).toEqual({ status: 'reconciliation_required' });
    await f.chain.renew(keccak256(toHex('unrelated')), 1n);
    expect(f.chain.writer.rows()[1].nonce).toBe(1);
  });
  it('releases confirmed reverts without changing captured or refunded amounts', async () => {
    const f = await setup(kind); vi.spyOn(f.chain, 'broadcastTransaction').mockRejectedValue(new Error('timeout'));
    const response = await f.post(f.path, f.body); expect(response.status).toBe(200); const hash = (await response.json()).txHash;
    const before = f.db.prepare('SELECT captured_minor,refunded_minor FROM payments WHERE id=?').get(f.paymentId);
    const r = restart(f.db.serialize()); r.chain.block = 12n; r.chain.receipts.set(hash, f.receipt(hash, 'reverted'));
    await new Indexer(r.db, r.chain, 13n).poll();
    expect(r.chain.writer.rows()[0].phase).toBe('confirmed');
    expect(r.db.prepare('SELECT captured_minor,refunded_minor FROM payments WHERE id=?').get(f.paymentId)).toEqual(before);
    if (kind === 'refund') expect(r.db.prepare('SELECT status FROM refunds').get()).toEqual({ status: 'failed' });
    await expect(r.chain.renew(keccak256(toHex('unrelated')), 1n)).resolves.toBeDefined();
  });
  it.each(['reserved', 'nonce', 'signed'] as const)('retires a crash at %s as not sent and reuses only the unsent nonce', async phase => {
    const f = await setup(kind); let snapshot: Buffer | undefined;
    const prepare = f.db.prepare.bind(f.db);
    vi.spyOn(f.db, 'prepare').mockImplementation(((sql: string) => {
      const statement = prepare(sql);
      // Snapshot immediately BEFORE the next durable boundary. The original
      // process continues only to produce realistic records for this test.
      if ((phase === 'reserved' && sql.startsWith('UPDATE relayer_operations SET nonce=')) || (phase === 'signed' && sql.includes("SET phase='broadcasting'"))) {
        const run = statement.run.bind(statement); statement.run = ((...args: unknown[]) => { snapshot = f.db.serialize(); return run(...args); }) as typeof statement.run;
      }
      return statement;
    }) as typeof f.db.prepare);
    const method = kind === 'renew' ? 'prepareRenew' : kind === 'subscribe' ? 'prepareSubscribe' : 'prepareIntent';
    if (phase === 'nonce') {
      const original = f.chain[method].bind(f.chain);
      vi.spyOn(f.chain, method).mockImplementation((async (...args: unknown[]) => { snapshot = f.db.serialize(); return (original as (...a: unknown[]) => Promise<{ raw: Hex; hash: Hex }>)(...args); }) as never);
    }
    expect((await f.post(f.path, f.body)).status).toBe(200);
    expect(snapshot).toBeDefined(); const r = restart(snapshot!);
    expect(r.chain.writer.rows()[0]).toMatchObject({ phase: 'not_sent', reason: 'interrupted_before_broadcast' });
    if (kind === 'refund') expect(r.db.prepare('SELECT status FROM refunds').get()).toEqual({ status: 'failed' });
    await r.chain.renew(keccak256(toHex('unrelated')), 1n);
    expect(r.chain.writer.rows()[1].nonce).toBe(0);
    expect(r.chain.sent).toHaveLength(0);
  });
});

describe('preparation and reservation boundaries', () => {
  it.each(kinds)('%s preparation rejection sends nothing and does not freeze an unrelated operation or restart', async kind => {
    const f = await setup(kind);
    const method = kind === 'renew' ? 'prepareRenew' : kind === 'subscribe' ? 'prepareSubscribe' : 'prepareIntent';
    vi.spyOn(f.chain, method).mockRejectedValue(new Error('estimation or signing rejected'));
    const send = vi.spyOn(f.chain, 'broadcastTransaction');
    expect((await f.post(f.path, f.body)).status).toBe(400); expect(send).not.toHaveBeenCalled();
    expect(f.chain.writer.rows()[0].phase).toBe('not_sent');
    const r = restart(f.db.serialize()); await r.chain.renew(keccak256(toHex('unrelated')), 1n);
    expect(r.chain.writer.rows()[1].nonce).toBe(0);
  });
  it('reserves concurrent refunds before any RPC await and releases a definite rejected preparation', async () => {
    const f = await setup('refund');
    let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
    const simulate = f.chain.simulate.bind(f.chain);
    vi.spyOn(f.chain, 'simulate').mockImplementation(async (...args) => { await wait; return simulate(...args); });
    const request2 = await intent(f.request!.data, 2n, addresses.escrow, 1_000_000n);
    const request3 = await intent(f.request!.data, 3n, addresses.escrow, 1_000_000n);
    const a = f.post(f.path, f.body); const b = f.post(f.path, { ...request2, amount: '1' });
    await vi.waitFor(() => expect(f.db.prepare("SELECT COUNT(*) AS n FROM refunds WHERE status='pending'").get()).toEqual({ n: 2 }));
    const third = await f.post(f.path, { ...request3, amount: '1' }); expect(third.status).toBe(422); expect((await third.json()).error.code).toBe('refund_limit');
    vi.spyOn(f.chain, 'prepareIntent').mockRejectedValueOnce(new Error('signing rejected'));
    release(); expect((await a).status).toBe(400); expect((await b).status).toBe(200);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM refunds WHERE status='pending'").get()).toEqual({ n: 1 });
    expect(f.db.prepare('SELECT refunded_minor FROM payments WHERE id=?').get(f.paymentId)).toEqual({ refunded_minor: '0' });
  });
  it('does not release the queue while a preparation read is still running', async () => {
    const f = fixture(); let reject!: (e: Error) => void;
    vi.spyOn(f.chain, 'prepareRenew').mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
    const first = f.chain.renew(keccak256(toHex('first')), 1n); const firstFailure = expect(first).rejects.toThrow('read timeout');
    let secondDone = false; const second = f.chain.renew(keccak256(toHex('second')), 1n).then(() => { secondDone = true; });
    await vi.waitFor(() => expect(reject).toBeDefined());
    expect(secondDone).toBe(false); expect(f.chain.writer.rows()).toHaveLength(1);
    reject(new Error('read timeout')); await firstFailure; await second;
    expect(f.chain.writer.rows().map(r => [r.phase, r.nonce])).toEqual([['not_sent', 0], ['submitted', 0]]);
  });
  it.each(['estimate', 'sign'])('Viem %s rejection occurs before the raw send method is reachable', async failure => {
    const chain = new ViemChain('http://unused.invalid', `0x${'2'.repeat(64)}`, addresses);
    const prepareTransactionRequest = vi.fn().mockRejectedValue(new Error('estimate rejected'));
    if (failure === 'sign') {
      prepareTransactionRequest.mockResolvedValue({ chainId: 1874, gas: 100000n, maxFeePerGas: 1000000000n, maxPriorityFeePerGas: 1000000000n });
      Object.assign(chain, { account: { signTransaction: vi.fn().mockRejectedValue(new Error('sign rejected')) } });
    }
    const sendRawTransaction = vi.fn(); Object.assign(chain, { wallet: { prepareTransactionRequest, sendRawTransaction }, public: { getChainId: vi.fn().mockResolvedValue(1874), getTransactionCount: vi.fn().mockResolvedValue(0) } });
    await expect(chain.renew(keccak256(toHex('sub')), 1n)).rejects.toThrow(`${failure} rejected`);
    expect(sendRawTransaction).not.toHaveBeenCalled(); expect(chain.writer.rows()[0].phase).toBe('not_sent');
  });
});

describe('legacy unknown operator recovery', () => {
  it('never clears an orphan automatically and validates an audited adoption before receipt recovery', async () => {
    const f = await setup('payment');
    f.db.prepare('INSERT INTO intents VALUES (?,?,?,?,?,?,?,?,?)').run('legacy_intent', f.keys.merchantId, account.address.toLowerCase(), '1', wire(f.request), 'reconciliation_required', 'broadcast_pending', null, new Date().toISOString());
    f.db.prepare("INSERT INTO relayer_write_block VALUES (1,'unknown')").run();
    const r = restart(f.db.serialize());
    expect(r.db.prepare('SELECT reference FROM relayer_legacy_holds').all()).toEqual([{ reference: 'intentId:legacy_intent' }]);
    await expect(r.chain.renew(keccak256(toHex('other')), 1n)).rejects.toMatchObject({ code: 'relayer_pending' });
    const operation: WriteOperation = { id: 'legacy_adopted', kind: 'intent', objectId: f.paymentId, links: { intentId: 'legacy_intent' } };
    const hash = keccak256(toHex('discovered transaction'));
    const expected = { to: addresses.router, dataHash: keccak256(f.request!.data), note: 'Offline operator verified original intent and discovered transaction.', acknowledgeUnknown: true };
    const tx = { hash, from: r.chain.writer.relayer, to: addresses.router, input: f.request!.data, nonce: 7, chainId: 1874 };
    const reader = { chainId: async () => 1874, transaction: async () => ({ ...tx }) };
    await expect(r.chain.writer.adoptLegacy(operation, hash, expected, { ...reader, transaction: async () => ({ ...tx, from: account.address }) })).rejects.toThrow('identity mismatch');
    expect(r.db.prepare('SELECT * FROM relayer_write_block').all()).toHaveLength(1);
    await r.chain.writer.adoptLegacy(operation, hash, expected, reader);
    expect(r.db.prepare('SELECT * FROM relayer_recovery_audit').all()).toHaveLength(1);
    expect(r.db.prepare('SELECT * FROM relayer_legacy_holds').all()).toHaveLength(0);
    expect(r.chain.writer.rows()[0]).toMatchObject({ phase: 'uncertain', nonce: 7, tx_hash: hash });
    await expect(r.chain.renew(keccak256(toHex('other')), 1n)).rejects.toMatchObject({ code: 'relayer_pending' });
    r.chain.block = 12n; r.chain.receipts.set(hash, f.receipt(hash, 'reverted'));
    await new Indexer(r.db, r.chain, 13n).poll();
    await r.chain.renew(keccak256(toHex('other')), 1n);
    expect(r.chain.writer.rows()[1].nonce).toBe(8);
  });
});

describe('receipt/broadcast completion race', () => {
  it.each(['success', 'timeout'] as const)('does not overwrite confirmed finality when the delayed broadcast ends with %s', async outcome => {
    const f = await setup('payment'); let finish!: () => void;
    vi.spyOn(f.chain, 'broadcastTransaction').mockImplementationOnce(raw => new Promise((resolve, reject) => { finish = () => outcome === 'success' ? resolve(keccak256(raw)) : reject(new Error('accepted timeout')); }));
    const response = f.post(f.path, f.body);
    await vi.waitFor(() => expect(finish).toBeDefined());
    const hash = f.chain.writer.rows()[0].tx_hash!;
    f.chain.block = 12n; f.chain.receipts.set(hash, f.receipt(hash));
    await new Indexer(f.db, f.chain, 13n).poll();
    expect(f.chain.writer.rows()[0].phase).toBe('confirmed');
    finish(); expect((await response).status).toBe(200);
    expect(f.chain.writer.rows()[0].phase).toBe('confirmed');
    expect(f.db.prepare('SELECT status,reason FROM intents').get()).toEqual({ status: 'confirmed', reason: null });
    await f.chain.renew(keccak256(toHex('next')), 1n);
    expect(f.chain.writer.rows()[1].nonce).toBe(1);
  });
});

describe('durable boundary persistence failure', () => {
  it('does not broadcast when the broadcasting phase cannot commit', async () => {
    const f = await setup('payment'); const prepare = f.db.prepare.bind(f.db);
    let fail = true;
    vi.spyOn(f.db, 'prepare').mockImplementation(((sql: string) => {
      const statement = prepare(sql);
      if (fail && sql.includes("SET phase='broadcasting'")) statement.run = (() => { fail = false; throw new Error('durable boundary write failed'); }) as typeof statement.run;
      return statement;
    }) as typeof f.db.prepare);
    const send = vi.spyOn(f.chain, 'broadcastTransaction');
    expect((await f.post(f.path, f.body)).status).toBe(400);
    expect(send).not.toHaveBeenCalled(); expect(f.chain.writer.rows()[0].phase).toBe('not_sent');
    await f.chain.renew(keccak256(toHex('unrelated')), 1n);
    expect(f.chain.writer.rows()[1].nonce).toBe(0);
  });
});

describe('durable shared relayer spending budget', () => {
  it('retains the full reserved cost across restart and shares it between operation kinds', async () => {
    const f = fixture(); const at = 1_800_000_000_000;
    const operation = f.chain.writer.operation('renew', 'first');
    await f.chain.writer.execute(operation, () => f.chain.transactionCount(), async nonce => {
      const prepared = await f.chain.prepareRenew(keccak256(toHex('first')), 1n, nonce);
      f.chain.writer.reserveSpend(operation.id, 60n, 100n, at);
      return prepared;
    }, raw => f.chain.broadcastTransaction(raw));
    const r = restart(f.db.serialize());
    const next = r.chain.writer.operation('cancel', 'second');
    r.chain.writer.reserve(next);
    expect(() => r.chain.writer.reserveSpend(next.id, 41n, 100n, at)).toThrow('circuit_budget');
    r.chain.writer.reserveSpend(next.id, 40n, 100n, at);
    // The same operation is idempotent, not an extra cost or a way to lower its cost.
    r.chain.writer.reserveSpend(next.id, 40n, 100n, at);
    expect(() => r.chain.writer.reserveSpend(next.id, 1n, 100n, at)).toThrow('operation_replay');
  });
  it('releases only provably unsent cost and starts a fresh bucket next minute', () => {
    const f = fixture(); const at = 1_800_000_000_000;
    const first = f.chain.writer.operation('subscribe', 'first');
    f.chain.writer.reserve(first); f.chain.writer.reserveSpend(first.id, 100n, 100n, at);
    f.chain.writer.notSent(first.id);
    const second = f.chain.writer.operation('cancel', 'second');
    f.chain.writer.reserve(second); f.chain.writer.reserveSpend(second.id, 100n, 100n, at);
    const third = f.chain.writer.operation('renew', 'third');
    f.chain.writer.reserve(third);
    expect(() => f.chain.writer.reserveSpend(third.id, 1n, 100n, at)).toThrow('circuit_budget');
    f.chain.writer.reserveSpend(third.id, 100n, 100n, at + 60_000);
  });
  it.each([{ gas: 1_000_001n, maxFeePerGas: 1n }, { gas: 100_000n, maxFeePerGas: 100_000_000_001n }])('refuses an excessive direct subscription gas quote before signing', async quote => {
    const chain = new ViemChain('http://unused.invalid', `0x${'2'.repeat(64)}`, addresses, 2);
    const signTransaction = vi.fn(); const sendRawTransaction = vi.fn();
    Object.assign(chain, { account: { signTransaction }, public: { getChainId: vi.fn().mockResolvedValue(1874), getTransactionCount: vi.fn().mockResolvedValue(0) }, wallet: { prepareTransactionRequest: vi.fn().mockResolvedValue({ chainId: 1874, ...quote, maxPriorityFeePerGas: 1n }), sendRawTransaction } });
    await expect(chain.cancelSigned(keccak256(toHex('subscription')), 1n, '0x')).rejects.toThrow('gas budget exceeded');
    expect(signTransaction).not.toHaveBeenCalled(); expect(sendRawTransaction).not.toHaveBeenCalled();
    expect(chain.writer.rows()[0].phase).toBe('not_sent');
  });
});
