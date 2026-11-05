import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi, toHex, type Address, type Hex } from 'viem';
import { AccountWriter } from '../src/account-writer.js';
import { openDb, type Db } from '../src/db.js';
import { EXACT, NETWORK, UPTO, USDT } from '../src/x402/constants.js';
import { exactSettlementAbi, reservationDigest, uptoSettlementAbi } from '../src/x402/call-binding.js';
import { X402WriteCoordinator } from '../src/x402/write-coordinator.js';
import { SqliteX402Journal } from '../src/x402/sqlite-journal.js';
import { SqliteAccountReservationAdapter } from '../src/x402/sqlite-reservations.js';
import { canonicalJson, fingerprint, SqlitePendingSettlementStore } from '../src/x402/sqlite-store.js';
import type { MerchantSponsorshipPolicy, X402Receipt, X402Transaction, X402WritePorts } from '../src/x402/write-ports.js';
import type { SettlementOperation } from '../src/x402/journal.js';
import type { ReservedPayment } from '../src/x402/account-client.js';

const relayer = '0x0000000000000000000000000000000000000011' as Address;
const payer = '0x0000000000000000000000000000000000000022' as Address;
const merchant = '0x0000000000000000000000000000000000000033' as Address;
const signature = `0x${'12'.repeat(65)}` as Hex;
const dirs: string[] = [], dbs: Db[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.open) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const makeDb = (snapshot?: Buffer) => {
  const dir = mkdtempSync(join(tmpdir(), 'x402-journal-')); dirs.push(dir);
  const path = join(dir, 'journal.sqlite'); if (snapshot) writeFileSync(path, snapshot);
  const db = openDb(path); dbs.push(db); return db;
};
function fixture(snapshot?: Buffer) {
  const db = makeDb(snapshot), writer = new AccountWriter(relayer);
  const receipts = new Map<Hex, X402Receipt | Error>();
  let head = 12n, chainId = 1874, valid = true, clock = 1_800_000_000_000;
  const prepared: Array<{ nonce: number; request: X402Transaction & { maxFeePerGas: bigint }; hash: Hex }> = [];
  const ports: X402WritePorts = {
    chainId: vi.fn(async () => chainId), transactionCount: vi.fn(async () => 0), latestBlock: vi.fn(async () => head),
    prepare: vi.fn(async (request, nonce) => { const raw = toHex(canonicalJson({ request, nonce })); const hash = keccak256(raw); prepared.push({ nonce, request, hash }); return { raw, hash }; }),
    broadcast: vi.fn(async raw => keccak256(raw)),
    receipt: vi.fn(async hash => { const r = receipts.get(hash); if (r instanceof Error) throw r; return r ?? null; }),
    reservationValid: vi.fn(async () => valid),
  };
  const sponsorship: MerchantSponsorshipPolicy = { authorize: vi.fn(async () => ({ policyId: 'mock-transport-policy-no-reimbursement-claim', maxFeePerGas: 2n, merchantDailyLimitWei: 10_000n, merchantDailyCalls: 20 })) };
  const config = { db, writer, ports, sponsorship, maxSpendPerMinuteWei: 10_000n, confirmations: 2n, clock: () => clock };
  const coordinator = new X402WriteCoordinator(config), journal = new SqliteX402Journal(coordinator);
  return { db, writer, ports, prepared, receipts, config, coordinator, journal, sponsorship,
    setHead: (x: bigint) => head = x, setChain: (x: number) => chainId = x, setValid: (x: boolean) => valid = x, setClock: (x: number) => clock = x };
}
function operation(nonce = 1n, amount = 10n): SettlementOperation {
  return { id: `${NETWORK}:permit2:${payer}:${nonce}`, fingerprint: fingerprint({ nonce, amount }), payer, merchant, amount };
}
function transaction(op: SettlementOperation, upto = false): X402Transaction {
  const nonce = BigInt(op.id.split(':').at(-1)!);
  const permit = { permitted: { token: USDT, amount: op.amount }, nonce, deadline: 2_000_000_000n };
  const data = upto ? encodeFunctionData({ abi: uptoSettlementAbi, functionName: 'settle', args: [permit, op.amount, op.payer, { to: op.merchant, facilitator: relayer, validAfter: 0n }, signature] })
    : encodeFunctionData({ abi: exactSettlementAbi, functionName: 'settle', args: [permit, op.payer, { to: op.merchant, validAfter: 0n }, signature] });
  return { chainId: 1874, to: upto ? UPTO : EXACT, data, gas: 100n, value: 0n };
}
const eventAbi = parseAbi(['event Transfer(address indexed from,address indexed to,uint256 value)', 'event Reserved(bytes32 indexed digest,address indexed merchant,uint256 ceiling,uint256 day)']);
function settlementReceipt(hash: Hex, op = operation(), target: Address = EXACT): X402Receipt {
  return { txHash: hash, block: 10n, status: 'success', logs: [
    { address: target, topics: [keccak256(toHex('Settled()'))], data: '0x' },
    { address: USDT, topics: encodeEventTopics({ abi: eventAbi, eventName: 'Transfer', args: { from: op.payer, to: op.merchant } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [op.amount]) },
  ] };
}
async function start(f: ReturnType<typeof fixture>, op = operation(), accepted = false) {
  return f.journal.runOnce(op, async () => {
    const hash = await f.journal.submit(op, transaction(op));
    if (accepted) f.receipts.set(hash, settlementReceipt(hash, op));
    return { success: true, network: NETWORK, transaction: hash, payer };
  });
}
const domainRow = (f: ReturnType<typeof fixture>) => f.db.prepare('SELECT * FROM x402_operations ORDER BY created_at LIMIT 1').get() as Record<string, any>;

describe('SQLite x402 settlement recovery through the shared AccountWriter', () => {
  it('serializes concurrent identical settlements, persists terminal results and preserves nonce floor after restart', async () => {
    const f = fixture(), op = operation();
    const otherJournal = new SqliteX402Journal(new X402WriteCoordinator(f.config));
    const callback = vi.fn(async () => {
      const hash = await f.journal.submit(op, transaction(op)); f.receipts.set(hash, settlementReceipt(hash));
      return { success: true, network: NETWORK, transaction: hash };
    });
    const results = await Promise.all([f.journal.runOnce(op, callback), otherJournal.runOnce(op, callback)]);
    expect(callback).toHaveBeenCalledTimes(1); expect(f.ports.broadcast).toHaveBeenCalledTimes(1);
    expect(results[0]).toEqual(results[1]); expect(results[0].success).toBe(true);
    const r = fixture(f.db.serialize());
    expect(await r.journal.runOnce(op, callback)).toEqual(results[0]); expect(r.ports.prepare).not.toHaveBeenCalled();
    await start(r, operation(2n)); expect(r.prepared[0].nonce).toBe(1);
  });
  it('keeps global payer Permit2 nonce uniqueness across exact/upto, altered fingerprints and relayer rotations', async () => {
    const f = fixture(), op = operation(); await start(f, op, true);
    await expect(f.journal.runOnce({ ...op, fingerprint: fingerprint('upto') }, vi.fn())).rejects.toThrow('idempotency_conflict');
    await expect(f.journal.runOnce({ ...op, merchant: relayer }, vi.fn())).rejects.toThrow('idempotency_conflict');
    expect((f.db.prepare('SELECT COUNT(*) AS n FROM x402_operations').get() as any).n).toBe(1);
    // A new relayer cannot adopt the same operation and mark an old signer's unknown write failed.
    const rotatedWriter = new AccountWriter(merchant);
    const rotated = new SqliteX402Journal(new X402WriteCoordinator({ ...f.config, writer: rotatedWriter }));
    await expect(rotated.runOnce(op, vi.fn())).rejects.toThrow('idempotency_conflict');
  });
  it('recovers crash after node acceptance before broadcast-return persistence; HTTP failure never overrides confirmed transfer', async () => {
    const f = fixture(); let snapshot!: Buffer;
    vi.mocked(f.ports.broadcast).mockImplementation(async raw => {
      const row = f.writer.rows()[0]; expect(row.phase).toBe('broadcasting'); expect(row.tx_hash).toBe(keccak256(raw));
      snapshot = f.db.serialize(); throw new Error('accepted but transport timeout');
    });
    const result = await f.journal.runOnce(operation(), async () => {
      await f.journal.submit(operation(), transaction(operation()));
      throw new Error('x402 HTTP deadline exceeded');
    });
    expect(result).toMatchObject({ success: false, errorReason: 'settlement_pending' });
    expect(f.writer.rows()[0].phase).toBe('uncertain');
    const r = fixture(snapshot); const row = r.writer.rows()[0]; expect(row.phase).toBe('broadcasting');
    const retry = vi.fn(); expect((await r.journal.runOnce(operation(), retry)).success).toBe(false); expect(retry).not.toHaveBeenCalled();
    r.receipts.set(row.tx_hash!, settlementReceipt(row.tx_hash!)); await r.journal.reconcile();
    expect(await r.journal.runOnce(operation(), retry)).toMatchObject({ success: true, transaction: row.tx_hash });
    expect(r.writer.rows()[0].phase).toBe('confirmed'); expect(r.ports.broadcast).not.toHaveBeenCalled();
  });
  it('retires a real prepare-time crash snapshot as not_sent and never retries that payment identity', async () => {
    const f = fixture(); let snapshot!: Buffer;
    vi.mocked(f.ports.prepare).mockImplementation(async () => {
      expect(f.writer.rows()[0]).toMatchObject({ phase: 'preparing', nonce: 0, tx_hash: null });
      snapshot = f.db.serialize(); throw new Error('crash before signing returns');
    });
    await start(f);
    const r = fixture(snapshot);
    expect(r.writer.rows()[0].phase).toBe('not_sent');
    expect(await start(r)).toMatchObject({ success: false, errorReason: 'transaction_not_sent', transaction: '' });
    expect(r.ports.prepare).not.toHaveBeenCalled();
    await start(r, operation(2n)); expect(r.prepared[0].nonce).toBe(0);
    expect((r.db.prepare('SELECT COUNT(*) n FROM x402_operations').get() as any).n).toBe(2);
  });
  it('reconciles business success after another reader already confirmed the writer hash, without HTTP results', async () => {
    const f = fixture(), pending = await start(f);
    f.writer.resolve(pending.transaction as Hex, 10n, 'success');
    f.db.prepare('UPDATE x402_operations SET http_result_json=NULL').run();
    const r = fixture(f.db.serialize());
    expect((await start(r)).success).toBe(false); // a writer receipt alone is not a USDT Transfer proof
    r.receipts.set(pending.transaction as Hex, settlementReceipt(pending.transaction as Hex));
    await r.journal.reconcile(); expect(await start(r)).toMatchObject({ success: true });
    expect(r.ports.prepare).not.toHaveBeenCalled();
  });
  it('confirms accepted-but-timeout success even when x402 returned false in the same process', async () => {
    const f = fixture();
    vi.mocked(f.ports.broadcast).mockImplementation(async raw => { const hash = keccak256(raw); f.receipts.set(hash, settlementReceipt(hash)); throw new Error('accepted timeout'); });
    expect(await f.journal.runOnce(operation(), async () => {
      const hash = await f.journal.submit(operation(), transaction(operation()));
      return { success: false, network: NETWORK, transaction: hash, errorReason: 'settlement_pending' };
    })).toMatchObject({ success: true });
    expect(JSON.parse(domainRow(f).http_result_json).success).toBe(false);
  });
  it('retains writer serialization when an HTTP callback abandons an in-flight send', async () => {
    const f = fixture(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(r => release = r), broadcastEntered = new Promise<void>(r => entered = r);
    vi.mocked(f.ports.broadcast).mockImplementationOnce(async raw => {
      entered(); await gate;
      f.receipts.set(keccak256(raw), settlementReceipt(keccak256(raw)));
      throw new Error('accepted then timed out');
    });
    const first = f.journal.runOnce(operation(), async () => {
      void f.journal.submit(operation(), transaction(operation())).catch(() => undefined);
      throw new Error('HTTP caller stopped awaiting');
    });
    await broadcastEntered;
    const second = start(f, operation(2n));
    await new Promise<void>(r => setImmediate(r));
    expect(f.ports.prepare).toHaveBeenCalledTimes(1);
    release(); expect((await first).success).toBe(true); await second;
    expect(f.prepared.map(x => x.nonce)).toEqual([0, 1]);
  });
  it('persists receipt evidence but waits for the recorded confirmation depth across restart', async () => {
    const f = fixture(); f.setHead(11n); const pending = await start(f, operation(), true);
    expect(pending.success).toBe(false); expect(domainRow(f).receipt_json).toBeTruthy(); expect(f.writer.rows()[0].phase).toBe('submitted');
    const r = fixture(f.db.serialize()); r.config.confirmations = 1n; r.setHead(11n); r.receipts.set(pending.transaction as Hex, settlementReceipt(pending.transaction as Hex));
    await r.journal.reconcile(); expect(domainRow(r).state).toBe('pending');
    r.setHead(12n); await r.journal.reconcile(); expect(domainRow(r).state).toBe('succeeded');
  });
  it('never releases higher nonce holds when receipts are missing, wrong-network, wrong-hash or RPC errors', async () => {
    const f = fixture(); await start(f); await start(f, operation(2n));
    expect(f.writer.rows().map(r => r.nonce)).toEqual([0, 1]);
    const r = fixture(f.db.serialize()), [low, high] = r.writer.rows();
    r.receipts.set(low.tx_hash!, settlementReceipt(low.tx_hash!)); r.setChain(1); await r.journal.reconcile();
    expect(r.writer.rows().map(x => x.phase)).toEqual(['submitted', 'submitted']);
    r.setChain(1874); r.receipts.set(high.tx_hash!, new Error('read failure')); await r.journal.reconcile();
    expect(r.writer.rows().map(x => x.phase)).toEqual(['confirmed', 'submitted']);
    r.receipts.set(high.tx_hash!, settlementReceipt(low.tx_hash!, operation(2n))); await r.journal.reconcile();
    expect(r.writer.rows()[1]).toMatchObject({ phase: 'submitted', nonce: 1 });
    await start(r, operation(3n)); expect(r.prepared[0].nonce).toBe(2);
    expect((r.db.prepare('SELECT COUNT(*) n FROM x402_sponsorship_reservations').get() as any).n).toBe(3);
  });
  it('blocks unrelated writes on uncertainty, and never resends missing receipts regardless of age', async () => {
    const f = fixture(); vi.mocked(f.ports.broadcast).mockRejectedValue(new Error('unknown acceptance'));
    await start(f); const r = fixture(f.db.serialize()); r.setClock(1_900_000_000_000);
    await start(r, operation(2n)); expect(r.ports.prepare).not.toHaveBeenCalled();
    expect(r.writer.rows()).toHaveLength(1); expect(r.writer.rows()[0].phase).toBe('uncertain');
    const other = { id: 'other-refund', kind: 'refund' as const, objectId: 'refund' };
    await expect(r.writer.run(() => r.writer.execute(other, () => r.ports.transactionCount(), nonce => r.ports.prepare({ ...transaction(operation()), maxFeePerGas: 2n }, nonce), raw => r.ports.broadcast(raw)))).rejects.toMatchObject({ code: 'relayer_pending' });
  });
  it('requires actual transfer/proxy evidence; confirmed receipt finality releases only its own nonce uncertainty', async () => {
    const f = fixture(); const result = await start(f); const hash = result.transaction as Hex;
    f.receipts.set(hash, { ...settlementReceipt(hash), logs: [] }); await f.journal.reconcile();
    expect(f.writer.rows()[0].phase).toBe('confirmed'); expect(domainRow(f).state).toBe('reconciliation_required');
    expect((await start(f)).errorReason).toBe('reconciliation_required'); expect(f.ports.broadcast).toHaveBeenCalledTimes(1);
    f.receipts.set(hash, settlementReceipt(hash)); await f.journal.reconcile(); expect(domainRow(f).state).toBe('succeeded');
  });
  it('confirms reverted transactions as failures and keeps their gas reservation charged', async () => {
    const f = fixture(), result = await start(f), hash = result.transaction as Hex;
    f.receipts.set(hash, { txHash: hash, block: 10n, status: 'reverted', logs: [] }); await f.journal.reconcile();
    expect(await start(f)).toMatchObject({ success: false, errorReason: 'transaction_reverted' });
    expect(f.writer.rows()[0].phase).toBe('confirmed'); expect(f.ports.broadcast).toHaveBeenCalledTimes(1);
    expect((f.db.prepare('SELECT max_cost_wei FROM x402_sponsorship_reservations').get() as any).max_cost_wei).toBe('200');
  });
  it('rejects a substituted target/amount/nonce or a second differing transaction before signing', async () => {
    const f = fixture(), op = operation();
    await f.journal.runOnce(op, async () => {
      await expect(f.journal.submit(op, { ...transaction(op), to: payer })).rejects.toThrow();
      return { success: false, network: NETWORK, transaction: '', errorReason: 'refused' };
    });
    expect(f.ports.prepare).not.toHaveBeenCalled();
    const g = fixture(); await g.journal.runOnce(op, async () => {
      const hash = await g.journal.submit(op, transaction(op));
      await expect(g.journal.submit(op, transaction(op, true))).rejects.toThrow('transaction_conflict');
      return { success: false, network: NETWORK, transaction: hash };
    });
    expect(g.ports.broadcast).toHaveBeenCalledTimes(1);
  });
});

describe('shared and merchant durable sponsorship admission budgets', () => {
  it('requires an explicit sponsorship authorization; no policy means no signer call', async () => {
    const f = fixture(); vi.mocked(f.sponsorship.authorize).mockRejectedValue(new Error('M7 not integrated'));
    expect(await start(f)).toMatchObject({ success: false, errorReason: 'sponsorship_not_authorized' }); expect(f.writer.rows()).toHaveLength(0); expect(f.ports.prepare).not.toHaveBeenCalled();
    expect(() => new X402WriteCoordinator({ ...f.config, sponsorship: undefined as any })).toThrow('invalid_x402_writer_config');
  });
  it('shares AccountWriter reserveSpend with non-x402 kinds and atomically rolls back rejected admission', async () => {
    const f = fixture(); f.config.maxSpendPerMinuteWei = 300n;
    f.writer.reserve({ id: 'refund-budget', kind: 'refund', objectId: 'refund' });
    f.writer.reserveSpend('refund-budget', 200n, 300n, f.config.clock());
    expect(await start(f)).toMatchObject({ success: false, errorReason: 'circuit_budget' }); expect(f.writer.rows()).toHaveLength(1);
    expect(f.ports.prepare).not.toHaveBeenCalled();
    expect((f.db.prepare('SELECT COUNT(*) n FROM x402_sponsorship_reservations').get() as any).n).toBe(0);
  });
  it('keeps merchant daily caps across restart, counts pending past midnight and counts reservations with settlements', async () => {
    const f = fixture(); vi.mocked(f.sponsorship.authorize).mockResolvedValue({ policyId: 'test', maxFeePerGas: 2n, merchantDailyLimitWei: 200n, merchantDailyCalls: 1 });
    await start(f);
    const r = fixture(f.db.serialize()); r.setClock(f.config.clock() + 86_400_000); vi.mocked(r.sponsorship.authorize).mockImplementation(vi.mocked(f.sponsorship.authorize));
    await start(r, operation(2n)); expect(r.ports.prepare).not.toHaveBeenCalled();
    const adapter = new SqliteAccountReservationAdapter(r.coordinator, 100n);
    await expect(adapter.reserve(payer, payment(), signature)).rejects.toThrow(); expect(r.ports.prepare).not.toHaveBeenCalled();
    expect(r.writer.rows()).toHaveLength(1);
  });
  it('serializes concurrent different payments against one durable merchant cap', async () => {
    const f = fixture();
    vi.mocked(f.sponsorship.authorize).mockResolvedValue({ policyId: 'test', maxFeePerGas: 2n, merchantDailyLimitWei: 200n, merchantDailyCalls: 1 });
    const results = await Promise.all([start(f), start(f, operation(2n))]);
    expect(results[1]).toMatchObject({ success: false, errorReason: 'merchant_daily_sponsorship_cap' });
    expect(f.ports.prepare).toHaveBeenCalledTimes(1); expect(f.writer.rows()).toHaveLength(1);
    const r = fixture(f.db.serialize());
    expect(await start(r, operation(2n))).toEqual(results[1]); expect(r.ports.prepare).not.toHaveBeenCalled();
  });
  it('excludes only proven not_sent writes from budgets, retaining their operation identities', async () => {
    const f = fixture(); f.config.maxSpendPerMinuteWei = 200n; vi.mocked(f.ports.prepare).mockRejectedValueOnce(new Error('local signer failed'));
    expect(await start(f)).toMatchObject({ success: false, errorReason: 'transaction_not_sent' });
    expect(f.writer.rows()[0].phase).toBe('not_sent');
    await start(f, operation(2n)); expect(f.prepared[0].nonce).toBe(0); expect(f.ports.broadcast).toHaveBeenCalledTimes(1);
    expect(await start(f)).toMatchObject({ success: false, errorReason: 'transaction_not_sent' }); expect(f.ports.broadcast).toHaveBeenCalledTimes(1);
  });
});

function payment(): ReservedPayment { return { spender: EXACT, amount: 10n, nonce: 77n, deadline: 2_000_000_000n, to: merchant, facilitator: '0x0000000000000000000000000000000000000000', validAfter: 0n }; }
function reservationReceipt(hash: Hex, p = payment()): X402Receipt {
  return { txHash: hash, block: 10n, status: 'success', logs: [{ address: payer,
    topics: encodeEventTopics({ abi: eventAbi, eventName: 'Reserved', args: { digest: reservationDigest(p), merchant } }) as Hex[],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [p.amount, 20_000n]),
  }] };
}
describe('account reservation adapter and upstream pending cache', () => {
  it('recovers a reservation accepted before timeout/restart and returns only after confirmation and live ERC-1271 check', async () => {
    const f = fixture(), adapter = new SqliteAccountReservationAdapter(f.coordinator, 100n); let snapshot!: Buffer;
    vi.mocked(f.ports.broadcast).mockImplementation(async () => { snapshot = f.db.serialize(); throw new Error('accepted timeout'); });
    await expect(adapter.reserve(payer, payment(), signature)).rejects.toMatchObject({ reason: 'settlement_pending' });
    expect(f.ports.reservationValid).not.toHaveBeenCalled();
    const r = fixture(snapshot), recovered = new SqliteAccountReservationAdapter(r.coordinator, 100n), hash = r.writer.rows()[0].tx_hash!;
    r.receipts.set(hash, reservationReceipt(hash)); r.setHead(11n);
    await expect(recovered.reserve(payer, payment(), signature)).rejects.toMatchObject({ reason: 'settlement_pending' });
    r.setHead(12n); await expect(recovered.reserve(payer, payment(), signature)).resolves.toBeUndefined();
    expect(r.ports.broadcast).not.toHaveBeenCalled(); expect(r.ports.reservationValid).toHaveBeenCalledWith(payer, reservationDigest(payment()), signature);
    r.setValid(false); await expect(recovered.reserve(payer, payment(), signature)).rejects.toMatchObject({ reason: 'not_currently_valid' });
    expect(r.ports.broadcast).not.toHaveBeenCalled();
  });
  it('never treats a successful transaction with missing reservation event as authorization', async () => {
    const f = fixture(), adapter = new SqliteAccountReservationAdapter(f.coordinator, 100n);
    vi.mocked(f.ports.broadcast).mockImplementation(async raw => { const hash = keccak256(raw); f.receipts.set(hash, { ...reservationReceipt(hash), logs: [] }); return hash; });
    await expect(adapter.reserve(payer, payment(), signature)).rejects.toMatchObject({ reason: 'reconciliation_required' });
    expect(f.ports.reservationValid).not.toHaveBeenCalled(); expect(f.writer.rows()[0].phase).toBe('confirmed');
  });
  it('serializes identical reservations and refuses a changed signature for the same digest', async () => {
    const f = fixture(), a = new SqliteAccountReservationAdapter(f.coordinator, 100n);
    vi.mocked(f.ports.broadcast).mockImplementation(async raw => { const hash = keccak256(raw); f.receipts.set(hash, reservationReceipt(hash)); return hash; });
    await Promise.all([a.reserve(payer, payment(), signature), a.reserve(payer, payment(), signature)]);
    expect(f.ports.broadcast).toHaveBeenCalledTimes(1);
    await expect(a.reserve(payer, payment(), `0x${'34'.repeat(65)}`)).rejects.toThrow('idempotency_conflict');
  });
  it('persists pending hashes without TTL, refuses overwrite, and cache deletion cannot release journal ownership', async () => {
    const f = fixture(), hash = keccak256('0x01');
    await f.journal.pending.set('signature', hash); const r = fixture(f.db.serialize());
    expect(await r.journal.pending.get('signature')).toBe(hash);
    await expect(r.journal.pending.set('signature', keccak256('0x02'))).rejects.toThrow('pending_hash_conflict');
    const alternate = new SqlitePendingSettlementStore(r.db, 'different-network'); expect(await alternate.get('signature')).toBeUndefined();
    await start(r); const original = r.writer.rows()[0]; await r.journal.pending.delete('signature');
    expect(await r.journal.pending.get('signature')).toBeUndefined(); expect(r.writer.record(original.operation_id)).toEqual(original);
  });
});
