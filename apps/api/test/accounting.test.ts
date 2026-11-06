import { describe, expect, it } from 'vitest';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain } from '../src/chain.js';
import { Indexer } from '../src/indexer.js';
import { accountantExport } from '../src/export.js';
import { recordAccounting } from '../src/accounting.js';
import { backfillAccounting } from '../src/accounting-backfill.js';
import type { ChainEvent } from '../src/types.js';
import type { Hex } from 'viem';

const merchant = '0x0000000000000000000000000000000000000011';
const payer = '0x0000000000000000000000000000000000000022';
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
function fixture() {
  const db = openDb(), chain = new FakeChain();
  const owner = seedMerchant(db, merchant);
  const payment = (id: string, date = '2026-10-01T00:00:00.000Z') => db.prepare('INSERT INTO payments(id,merchant_id,amount_minor,status,payer,customer,created_at) VALUES (?,?,?,?,?,?,?)').run(id, owner.merchantId, '6000000', 'open', payer, '=HYPERLINK("https://example.test")', date);
  const emit = (event: Omit<ChainEvent, 'block'>) => chain.emit(event);
  const poll = async () => { chain.block += 2n; await new Indexer(db, chain).poll(); };
  const report = (from?: string, to?: string) => accountantExport(db, owner.merchantId, { from, to });
  return { db, chain, owner, payment, emit, poll, report };
}

describe('confirmed accounting ledger', () => {
  it('exports each capture by its confirmed block date, excluding unrelated creation dates', async () => {
    const f = fixture(); f.payment('p1');
    f.db.prepare("UPDATE payments SET status='authorized' WHERE id='p1'").run();
    f.emit({ id: 'capture-a', txHash: hash(1), contract: 'escrow', name: 'Captured', timestamp: '2026-11-01T23:59:59.000Z', args: { id: 'p1', amount: 2_000_000n } });
    f.emit({ id: 'capture-b', txHash: hash(2), contract: 'escrow', name: 'Captured', timestamp: '2026-11-02T00:00:00.000Z', args: { id: 'p1', amount: 4_000_000n } });
    await f.poll(); await f.poll();
    expect(f.report('2026-10-01', '2026-10-31').rows).toEqual([]);
    const first = f.report('2026-11-01', '2026-11-01');
    expect(first.totals.netUSDT).toBe('2.000000');
    expect(first.rows[0]['Transaction Hash']).toBe(hash(1));
    const second = f.report('2026-11-02', '2026-11-02');
    expect(second.totals.netUSDT).toBe('4.000000');
    expect(f.report().rows).toHaveLength(2);
    expect(first.csv).toContain("'=HYPERLINK");
  });

  it('includes subscription revenue and refuses to count pending/unconfirmed events', async () => {
    const f = fixture();
    f.db.prepare('INSERT INTO subscriptions(id,merchant_id,plan_id,chain_id,payer,status,next_charge_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run('sub1', f.owner.merchantId, 'plan', hash(10), payer, 'active', '2026-01-01', '2026-01-01');
    f.emit({ id: 'sub-charge', txHash: hash(20), contract: 'subscription', name: 'Charged', timestamp: '2026-11-01T10:00:00Z', args: { id: hash(10), amount: 3_000_001n } });
    await new Indexer(f.db, f.chain).poll();
    expect(f.report().totals.netUSDT).toBe('0.000000');
    await f.poll();
    expect(f.report().rows[0]).toMatchObject({ Type: 'Subscription', 'Gross USDT': '3.000001', 'Token Balance Change USDT': '3.000001' });
  });

  it('exports refunds negatively and each fee once: the fee from the payment, the refund gas on top', async () => {
    const f = fixture(); f.payment('p1');
    f.db.prepare("UPDATE payments SET amount_minor='2000000' WHERE id='p1'").run();
    f.emit({ id: 'charge', txHash: hash(1), contract: 'escrow', name: 'Charged', timestamp: '2026-11-01T10:00:00Z', args: { id: 'p1', amount: 2_000_000n, payer, fee: 150_000n } });
    f.emit({ id: 'charge-run', txHash: hash(1), contract: 'router', name: 'Executed', timestamp: '2026-11-01T10:00:00Z', args: { merchant, gasFee: 0n } });
    f.emit({ id: 'refund', txHash: hash(2), contract: 'escrow', name: 'Refunded', timestamp: '2026-11-01T11:00:00Z', args: { id: 'p1', amount: 1_000_000n } });
    f.emit({ id: 'refund-gas', txHash: hash(2), contract: 'router', name: 'Executed', timestamp: '2026-11-01T11:00:00Z', args: { merchant, gasFee: 20_000n } });
    await f.poll();
    const report = f.report();
    // The merchant received 2.00 less the 0.15 fee, sent 1.00 back and paid 0.02 gas for the refund.
    expect(report.totals).toEqual({ grossUSDT: '1.000000', discountsUSDT: '0.000000', feesUSDT: '0.170000', netUSDT: '0.830000', tokenDeltaUSDT: '0.830000' });
    expect(report.rows.find(row => row.Type === 'Payment')).toMatchObject({ 'Gross USDT': '2.000000', 'Fee USDT': '0.150000', 'Token Balance Change USDT': '1.850000' });
    expect(report.rows.find(row => row.Type === 'Refund')).toMatchObject({ 'Gross USDT': '-1.000000', 'Refund Of': 'p1', 'Transaction Hash': hash(2) });
    expect(report.rows.filter(row => row.Type === 'Fee')).toEqual([expect.objectContaining({ 'Fee USDT': '0.020000', 'Token Balance Change USDT': '-0.020000' })]);
  });

  it('does not count a fee as leaving the wallet of a merchant that is also the fee recipient', async () => {
    const f = fixture(); f.payment('p1'); f.chain.feeRecipient = merchant;
    f.db.prepare("UPDATE payments SET amount_minor='2000000' WHERE id='p1'").run();
    f.emit({ id: 'charge', txHash: hash(1), contract: 'escrow', name: 'Charged', timestamp: '2026-11-01T10:00:00Z', args: { id: 'p1', amount: 2_000_000n, payer, fee: 150_000n } });
    await f.poll();
    expect(f.report().totals).toMatchObject({ feesUSDT: '0.150000', netUSDT: '1.850000', tokenDeltaUSDT: '2.000000' });
  });

  it('does not report missing historical accounting or unknown token deltas as zero', async () => {
    const f = fixture(); f.payment('legacy');
    f.db.prepare("UPDATE payments SET captured_minor='6000000',status='captured' WHERE id='legacy'").run();
    expect(() => f.report()).toThrow('Reindex confirmed');
    f.db.prepare("UPDATE payments SET captured_minor='0',payer=NULL WHERE id='legacy'").run();
    // A charge whose payer is unknown has an unknown token movement.
    recordAccounting(f.db, { id: 'unknown-payer', block: 1n, txHash: hash(3), timestamp: '2026-11-01T00:00:00Z', contract: 'escrow', name: 'Charged', args: { id: 'legacy', amount: 6_000_000n, fee: 150_000n } });
    f.db.prepare("UPDATE payments SET captured_minor='6000000' WHERE id='legacy'").run();
    expect(f.report().totals.tokenDeltaUSDT).toBeNull();
    // An Executed with no gas fee is no ledger entry at all.
    recordAccounting(f.db, { id: 'free-run', block: 1n, txHash: hash(4), timestamp: '2026-11-01T00:00:00Z', contract: 'router', name: 'Executed', args: { merchant, gasFee: 0n } });
    expect(f.db.prepare("SELECT * FROM accounting_entries WHERE event_id='free-run'").all()).toHaveLength(0);
  });

  it('backfills only previously accepted receipt events, without replaying payment state or duplicating totals', async () => {
    const f = fixture(); f.payment('p1');
    f.db.prepare("UPDATE payments SET amount_minor='2000000' WHERE id='p1'").run();
    f.emit({ id: 'historical', txHash: hash(1), contract: 'escrow', name: 'Charged', timestamp: '2026-10-15T00:00:00Z', args: { id: 'p1', amount: 2_000_000n, payer } });
    await f.poll();
    const before = f.db.prepare('SELECT * FROM payments').all();
    const cursor = f.db.prepare('SELECT * FROM cursor').all();
    f.db.prepare('DELETE FROM accounting_entries').run();
    f.db.prepare('UPDATE accounting_state SET coverage_complete=0').run();
    expect(() => f.report()).toThrow('Reindex confirmed');
    const result = await backfillAccounting(f.db, f.chain);
    expect(result).toEqual({ receipts: 1, inserted: 1, unresolved: [] });
    expect((await backfillAccounting(f.db, f.chain)).inserted).toBe(0);
    expect(f.db.prepare('SELECT * FROM payments').all()).toEqual(before);
    expect(f.db.prepare('SELECT * FROM cursor').all()).toEqual(cursor);
    expect(f.report('2026-10-15', '2026-10-15').totals.netUSDT).toBe('2.000000');
  });

  it('keeps historical coverage incomplete for missing or mismatched receipts', async () => {
    const f = fixture(); f.payment('p1');
    f.db.prepare('UPDATE accounting_state SET coverage_complete=0').run();
    f.db.prepare('INSERT INTO chain_events VALUES (?,?,?,?)').run('old-event', '1', hash(1), '2026-10-01');
    f.chain.block = 5n;
    expect((await backfillAccounting(f.db, f.chain)).unresolved).toEqual([hash(1)]);
    f.chain.receipts.set(hash(1), { txHash: hash(1), block: 1n, status: 'success', events: [{ id: 'different-event', txHash: hash(1), block: 1n, timestamp: '2026-10-01T00:00:00Z', contract: 'escrow', name: 'Charged', args: { id: 'p1', amount: 2n } }] });
    expect((await backfillAccounting(f.db, f.chain)).unresolved).toEqual([hash(1)]);
    expect(() => f.report()).toThrow('Reindex confirmed');
    expect(f.db.prepare('SELECT * FROM accounting_entries').all()).toEqual([]);
  });

  it('rejects a partially backfilled payment even if one capture is present', () => {
    const f = fixture(); f.payment('p1');
    f.db.prepare("UPDATE payments SET captured_minor='6000000' WHERE id='p1'").run();
    recordAccounting(f.db, { id: 'one-of-two', txHash: hash(1), block: 1n, timestamp: '2026-11-01T00:00:00Z', contract: 'escrow', name: 'Captured', args: { id: 'p1', amount: 2_000_000n } });
    expect(() => f.report()).toThrow('Reindex confirmed');
  });

  it.each(['merchant', 'amount'])('does not settle an untracked charge with mismatched %s', async mismatch => {
    const f = fixture(); f.payment('p1');
    f.emit({ id: 'forged-charge', txHash: hash(1), contract: 'escrow', name: 'Charged', timestamp: '2026-11-01T00:00:00Z', args: { id: 'p1', amount: mismatch === 'amount' ? 1n : 6_000_000n, merchant: mismatch === 'merchant' ? payer : merchant, payer } });
    await f.poll();
    expect(f.db.prepare('SELECT status,captured_minor FROM payments').get()).toEqual({ status: 'reconciliation_required', captured_minor: '0' });
    expect(f.db.prepare('SELECT * FROM accounting_entries').all()).toEqual([]);
    expect(f.db.prepare('SELECT reason FROM refusal_attempts').get()).toEqual({ reason: 'payment_event_mismatch' });
    expect(f.report().totals.netUSDT).toBe('0.000000');
    f.db.prepare('UPDATE accounting_state SET coverage_complete=0').run();
    await backfillAccounting(f.db, f.chain);
    expect(f.db.prepare('SELECT * FROM accounting_entries').all()).toEqual([]);
    expect(f.report().totals.netUSDT).toBe('0.000000');
  });

  it('isolates merchants, preserves exact large sums, and rejects invalid date ranges/formats', () => {
    const f = fixture(); f.payment('p1');
    const amount = 900719925474099312345678n;
    f.db.prepare('UPDATE payments SET captured_minor=? WHERE id=?').run(amount.toString(), 'p1');
    recordAccounting(f.db, { id: 'large', block: 1n, txHash: hash(1), timestamp: '2026-11-01T00:00:00Z', contract: 'escrow', name: 'Captured', args: { id: 'p1', amount } });
    expect(f.report().totals.netUSDT).toBe('900719925474099312.345678');
    expect(accountantExport(f.db, 'other', {}).rows).toEqual([]);
    for (const date of ['2026-02-30', '2026-1-1', '2026-11-01T00:00:00Z', 'x']) expect(() => f.report(date)).toThrow();
    expect(() => f.report('2026-11-02', '2026-11-01')).toThrow('invalid_date_range');
    expect(() => accountantExport(f.db, f.owner.merchantId, { format: 'pdf' })).toThrow('invalid_format');
  });
});
