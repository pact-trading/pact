import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain } from '../src/chain.js';
import { Indexer } from '../src/indexer.js';
import { runLegacyTestKeeper as runKeeper } from './helpers/legacy-keeper.js';

const start = new Date('2026-11-06T00:00:00.000Z');
const DAY = 86_400_000;
const subChainId = keccak256(toHex('recurring'));
function fixture() {
  const db = openDb(); const chain = new FakeChain(); chain.writer.bind(db);
  const merchant = seedMerchant(db, '0x0000000000000000000000000000000000000001');
  db.prepare('INSERT INTO plans(id,merchant_id,name,amount_minor,period_seconds,max_periods,created_at) VALUES (?,?,?,?,?,?,?)').run('plan', merchant.merchantId, 'Daily', '2000000', 86400, 12, start.toISOString());
  db.prepare('INSERT INTO subscriptions(id,merchant_id,plan_id,chain_id,payer,status,next_charge_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run('sub', merchant.merchantId, 'plan', subChainId, '0x0000000000000000000000000000000000000002', 'active', start.toISOString(), start.toISOString());
  const indexer = new Indexer(db, chain);
  const row = () => db.prepare('SELECT * FROM subscriptions WHERE id=?').get('sub') as { status: string; retry_count: number; pending_tx_hash: Hex | null; next_charge_at: string };
  async function event(reason: number | 'charged' | 'cancelled', at: Date, hash = keccak256(toHex(`${at.toISOString()}:${reason}`)), tracked = true) {
    if (tracked) db.prepare('UPDATE subscriptions SET pending_tx_hash=? WHERE id=?').run(hash, 'sub');
    chain.emit({ id: `${hash}:${reason}`, txHash: hash, timestamp: at.toISOString(), contract: 'subscription', name: reason === 'charged' ? 'Charged' : reason === 'cancelled' ? 'Cancelled' : 'Refused', args: { id: subChainId, ...(typeof reason === 'number' ? { reason } : reason === 'charged' ? { amount: 2_000_000n, period: 1 } : {}) } });
    chain.block += 2n;
    await indexer.poll();
  }
  return { db, chain, indexer, row, event };
}
afterEach(() => vi.useRealTimers());
describe('subscription renewal retries', () => {
  it('allows three daily retries after the initial insufficient-funds refusal, then pauses', async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const f = fixture(), renew = vi.spyOn(f.chain, 'renew');
    await f.event(5, start);
    expect(f.row()).toMatchObject({ status: 'past_due', retry_count: 0, pending_tx_hash: null, next_charge_at: '2026-11-07T00:00:00.000Z' });
    for (let retry = 1; retry <= 3; retry++) {
      const due = new Date(start.getTime() + retry * DAY);
      vi.setSystemTime(due.getTime() - 1);
      await runKeeper(f.db, f.chain, new Date(due.getTime() - 1));
      expect(renew).toHaveBeenCalledTimes(retry - 1);
      vi.setSystemTime(due);
      await runKeeper(f.db, f.chain, due);
      expect(renew).toHaveBeenCalledTimes(retry);
      await f.event(5, due, f.row().pending_tx_hash!);
      await f.indexer.poll(); // Same receipt must not consume another retry.
      expect(f.row()).toMatchObject({ status: retry === 3 ? 'paused' : 'past_due', retry_count: retry, pending_tx_hash: null });
    }
    await runKeeper(f.db, f.chain, new Date(start.getTime() + 10 * DAY));
    expect(renew).toHaveBeenCalledTimes(3);
    expect(f.db.prepare("SELECT count(*) AS n FROM webhook_events WHERE type='subscription.past_due'").get()).toEqual({ n: 4 });
    await f.event(5, new Date(start.getTime() + 10 * DAY));
    expect(f.row()).toMatchObject({ status: 'paused', retry_count: 3 });
  });
  it('persists the retry schedule across database reopen and uses confirmed block time for renewals', async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const f = fixture(); await f.event(5, start);
    const reopened = new Database(f.db.serialize()), chain = new FakeChain(); chain.writer.bind(reopened);
    const renew = vi.spyOn(chain, 'renew');
    await runKeeper(reopened, chain, new Date(start.getTime() + DAY - 1));
    expect(renew).not.toHaveBeenCalled(); reopened.close();
    vi.setSystemTime(start.getTime() + 5 * DAY); // Delayed indexer must not move the chain's billing anchor.
    await f.event('charged', new Date(start.getTime() + DAY));
    expect(f.row()).toMatchObject({ status: 'active', retry_count: 0, next_charge_at: '2026-11-08T00:00:00.000Z' });
  });
  it('does not turn a preparation RPC error into a payer delinquency or immediately retry it', async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const f = fixture();
    const prepare = vi.spyOn(f.chain, 'prepareRenew').mockRejectedValue(new Error('RPC unavailable'));
    await runKeeper(f.db, f.chain, start);
    expect(f.row()).toMatchObject({ status: 'active', retry_count: 0, pending_tx_hash: null });
    expect(f.db.prepare("SELECT * FROM webhook_events WHERE type='subscription.past_due'").all()).toHaveLength(0);
    await runKeeper(f.db, f.chain, new Date(start.getTime() + 15_000));
    expect(prepare).toHaveBeenCalledTimes(1);
    await runKeeper(f.db, f.chain, new Date(start.getTime() + 60_000));
    expect(prepare).toHaveBeenCalledTimes(2);
  });
  it('never resurrects a cancellation observed while renewal preparation is in flight', async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const f = fixture();
    vi.spyOn(f.chain, 'prepareRenew').mockImplementation(async () => { f.db.prepare("UPDATE subscriptions SET status='cancelled' WHERE id='sub'").run(); throw new Error('cancelled during RPC'); });
    await runKeeper(f.db, f.chain, start);
    expect(f.row()).toMatchObject({ status: 'cancelled', retry_count: 0 });
  });
  it('persists infrastructure backoff without consuming a billing retry after restart', async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const f = fixture();
    vi.spyOn(f.chain, 'prepareRenew').mockRejectedValue(new Error('RPC unavailable'));
    await runKeeper(f.db, f.chain, start);
    const db = new Database(f.db.serialize()), chain = new FakeChain(); chain.writer.bind(db);
    const renew = vi.spyOn(chain, 'renew');
    await runKeeper(db, chain, new Date(start.getTime() + 59_999));
    expect(renew).not.toHaveBeenCalled();
    await runKeeper(db, chain, new Date(start.getTime() + 60_000));
    expect(renew).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT status,retry_count FROM subscriptions').get()).toEqual({ status: 'active', retry_count: 0 });
    db.close();
  });
  it('backs off too-early receipts without pausing or moving the billing anchor', async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const f = fixture(); await f.event(2, start);
    expect(f.row()).toMatchObject({ status: 'active', retry_count: 0, next_charge_at: start.toISOString() });
    const renew = vi.spyOn(f.chain, 'renew');
    await runKeeper(f.db, f.chain, new Date(start.getTime() + 59_999));
    expect(renew).not.toHaveBeenCalled();
  });
  it('keeps cancellation terminal when an older pending transaction reverts', async () => {
    const f = fixture(), hash = keccak256(toHex('reverted renewal'));
    f.db.prepare("UPDATE subscriptions SET status='cancelled',pending_tx_hash=?").run(hash);
    vi.spyOn(f.chain, 'receipt').mockResolvedValue({ txHash: hash, block: 0n, status: 'reverted', events: [] });
    f.chain.block = 2n;
    await f.indexer.poll();
    expect(f.row()).toMatchObject({ status: 'cancelled', pending_tx_hash: null });
  });
  it('indexes a payer cancellation despite a different pending renewal hash and preserves it after the old receipt arrives', async () => {
    vi.useFakeTimers(); vi.setSystemTime(start);
    const f = fixture(), hash = keccak256(toHex('old renewal'));
    f.db.prepare('UPDATE subscriptions SET pending_tx_hash=?').run(hash);
    await f.event('cancelled', start, undefined, false);
    expect(f.row()).toMatchObject({ status: 'cancelled', pending_tx_hash: hash });
    await f.event('charged', new Date(start.getTime() - 1000), hash);
    expect(f.row()).toMatchObject({ status: 'cancelled', pending_tx_hash: null });
    const renew = vi.spyOn(f.chain, 'renew');
    await runKeeper(f.db, f.chain, new Date(start.getTime() + DAY));
    expect(renew).not.toHaveBeenCalled();
  });
});
