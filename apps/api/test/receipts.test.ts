import { describe, expect, it, vi } from 'vitest';
import { TransactionReceiptNotFoundError, encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain, ViemChain, escrowAbi } from '../src/chain.js';
import { Indexer } from '../src/indexer.js';
import { runKeeper } from '../src/keeper.js';
import type { ChainEvent } from '../src/types.js';

const hash = `0x${'a'.repeat(64)}` as Hex;
const otherHash = `0x${'b'.repeat(64)}` as Hex;
const paymentId = `0x${'c'.repeat(64)}` as Hex;
const merchant = '0x0000000000000000000000000000000000000004';
const payer = '0x0000000000000000000000000000000000000005';
const escrow = '0x0000000000000000000000000000000000000002';
const reason = keccak256(toHex('refund'));
const json = (x: unknown) => JSON.stringify(x, (_, v: unknown) => typeof v === 'bigint' ? String(v) : v);
function fixture(kind: 'charge' | 'refund' | 'renew' | 'subscribe' = 'charge') {
  const db = openDb();
  const { merchantId } = seedMerchant(db, merchant);
  const chain = new FakeChain();
  chain.block = 12n;
  const indexer = new Indexer(db, chain, 10n, 2n);
  if (kind === 'charge' || kind === 'refund') {
    db.prepare('INSERT INTO payments(id,merchant_id,amount_minor,status,captured_minor,refunded_minor,created_at) VALUES (?,?,?,?,?,?,?)').run(paymentId, merchantId, '1000000', kind === 'charge' ? 'open' : 'partially_refunded', kind === 'charge' ? '0' : '1000000', kind === 'charge' ? '0' : '100000', '2026-01-01');
    const data = encodeFunctionData({ abi: escrowAbi, functionName: kind, args: kind === 'charge' ? [paymentId, merchant, 1_000_000n, 86400n] : [paymentId, 500_000n, reason] });
    const intent = { signer: kind === 'charge' ? payer : merchant, merchant, target: escrow, nonce: 1n, amount: kind === 'charge' ? 1_000_000n : 500_000n };
    db.prepare('INSERT INTO intents VALUES (?,?,?,?,?,?,?,?,?)').run('int', merchantId, intent.signer, '1', json({ intent, data }), 'submitted', null, hash, '2026-01-01');
    if (kind === 'refund') db.prepare('INSERT INTO refunds VALUES (?,?,?,?,?,?,?)').run('ref', paymentId, '500000', 'refund', 'pending', hash, '2026-01-01');
  } else {
    db.prepare('INSERT INTO plans(id,merchant_id,name,amount_minor,period_seconds,max_periods,created_at) VALUES (?,?,?,?,?,?,?)').run('plan', merchantId, 'Plan', '1000000', 86400, 12, '2026-01-01');
    db.prepare('INSERT INTO subscriptions(id,merchant_id,plan_id,chain_id,payer,status,next_charge_at,pending_tx_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run('sub', merchantId, 'plan', paymentId, payer, kind === 'subscribe' ? 'pending' : 'active', '2026-01-01', hash, '2026-01-01');
  }
  const row = (table: string) => db.prepare(`SELECT * FROM ${table}`).get() as Record<string, string>;
  const event = (contract: ChainEvent['contract'], name: string, args: ChainEvent['args']): ChainEvent => ({ id: `${hash}:${contract}:${name}`, txHash: hash, block: 10n, timestamp: '2026-11-01T00:00:00.000Z', contract, name, args });
  // Override the new adapter lookup so these tests first expose the old indexer's behavior.
  const receipt = vi.fn().mockResolvedValue({ txHash: hash, block: 10n, status: 'reverted', events: [] });
  Object.assign(chain, { receipt });
  return { db, chain, indexer, receipt, row, event, merchantId };
}

describe('confirmed receipt reconciliation', () => {
  it('fails a reverted charge only after confirmations, even when the log cursor has advanced', async () => {
    const f = fixture();
    f.chain.block = 11n;
    await f.indexer.poll();
    expect(f.row('intents').status).toBe('submitted');
    f.db.prepare("INSERT OR REPLACE INTO cursor VALUES ('settle','10')").run();
    f.chain.block = 12n;
    await f.indexer.poll();
    expect(f.row('intents')).toMatchObject({ status: 'failed', reason: 'transaction_reverted' });
    expect(f.row('payments')).toMatchObject({ status: 'failed', captured_minor: '0', refunded_minor: '0' });
    await f.indexer.poll();
    expect(f.db.prepare('SELECT * FROM refusal_attempts').all()).toHaveLength(1);
    expect(f.db.prepare("SELECT * FROM accounting_entries WHERE kind='Fee'").all()).toHaveLength(0);
  });
  it('releases only the reverted refund reservation without changing financial amounts', async () => {
    const f = fixture('refund');
    f.db.prepare('INSERT INTO refunds VALUES (?,?,?,?,?,?,?)').run('another', paymentId, '100000', 'other', 'pending', otherHash, '2026-01-01');
    f.receipt.mockImplementation(async (h: Hex) => h === hash ? { txHash: hash, block: 10n, status: 'reverted', events: [] } : null);
    await f.indexer.poll();
    expect(f.row('intents')).toMatchObject({ status: 'failed', reason: 'transaction_reverted' });
    expect(f.db.prepare('SELECT status FROM refunds WHERE id=?').get('ref')).toEqual({ status: 'failed' });
    expect(f.db.prepare('SELECT status FROM refunds WHERE id=?').get('another')).toEqual({ status: 'pending' });
    expect(f.row('payments')).toMatchObject({ status: 'partially_refunded', captured_minor: '1000000', refunded_minor: '100000' });
  });
  it.each(['renew', 'subscribe'] as const)('pauses a reverted %s, records its hash and prevents automatic resubmission', async kind => {
    const f = fixture(kind);
    const renew = vi.spyOn(f.chain, 'renew');
    await f.indexer.poll();
    expect(f.row('subscriptions')).toMatchObject({ status: 'paused', pending_tx_hash: null, next_charge_at: '2026-01-01' });
    expect(f.row('refusal_attempts')).toMatchObject({ object_id: 'sub', tx_hash: hash, reason: 'transaction_reverted' });
    await runKeeper(f.db, f.chain);
    expect(renew).not.toHaveBeenCalled();
    await f.indexer.poll();
    expect(f.db.prepare('SELECT * FROM refusal_attempts').all()).toHaveLength(1);
  });
  it.each(['charge', 'refund', 'renew', 'subscribe'] as const)('leaves missing/error receipts pending for %s, even on repeated polls', async kind => {
    const f = fixture(kind);
    const before = f.row(kind === 'renew' || kind === 'subscribe' ? 'subscriptions' : 'intents');
    f.receipt.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('RPC unavailable')).mockResolvedValue(null);
    await f.indexer.poll(); await f.indexer.poll(); await f.indexer.poll();
    expect(f.row(kind === 'renew' || kind === 'subscribe' ? 'subscriptions' : 'intents')).toEqual(before);
    if (kind === 'refund') expect(f.row('refunds').status).toBe('pending');
    const renew = vi.spyOn(f.chain, 'renew');
    await runKeeper(f.db, f.chain);
    expect(renew).not.toHaveBeenCalled();
    expect(f.db.prepare('SELECT * FROM refusal_attempts').all()).toHaveLength(0);
  });
  it('does not equate a successful receipt or Router Executed alone with a captured payment', async () => {
    const f = fixture();
    const executed = f.event('router', 'Executed', { signer: payer, merchant, nonce: 1n, target: escrow, gasFee: 0n});
    f.chain.logs = [executed];
    f.receipt.mockResolvedValue({ txHash: hash, block: 10n, status: 'success', events: [executed] });
    await f.indexer.poll();
    expect(f.row('intents')).toMatchObject({ status: 'reconciliation_required', reason: 'missing_expected_event' });
    expect(f.row('payments')).toMatchObject({ status: 'reconciliation_required', captured_minor: '0', refunded_minor: '0' });
  });
  it('holds an ambiguous successful refund reservation instead of allowing another refund', async () => {
    const f = fixture('refund');
    f.receipt.mockResolvedValue({ txHash: hash, block: 10n, status: 'success', events: [] });
    await f.indexer.poll(); await f.indexer.poll();
    expect(f.row('intents')).toMatchObject({ status: 'reconciliation_required', reason: 'missing_expected_event' });
    expect(f.row('refunds').status).toBe('pending');
    expect(f.row('payments')).toMatchObject({ captured_minor: '1000000', refunded_minor: '100000' });
    expect(f.row('refusal_attempts').reason).toBe('missing_expected_event');
    expect(f.db.prepare('SELECT * FROM refusal_attempts').all()).toHaveLength(1);
  });
  it('holds a successful subscription transaction without the matching event', async () => {
    const f = fixture('renew');
    f.receipt.mockResolvedValue({ txHash: hash, block: 10n, status: 'success', events: [f.event('subscription', 'Charged', { id: otherHash, amount: 1000000n })] });
    await f.indexer.poll();
    expect(f.row('subscriptions')).toMatchObject({ status: 'reconciliation_required', pending_tx_hash: hash, next_charge_at: '2026-01-01' });
    expect(f.row('refusal_attempts').reason).toBe('missing_expected_event');
    const renew = vi.spyOn(f.chain, 'renew');
    await runKeeper(f.db, f.chain);
    expect(renew).not.toHaveBeenCalled();
  });
  it.each(['charge', 'refund'] as const)('settles matching %s events once, recovering logs behind the cursor', async kind => {
    const f = fixture(kind);
    const target = kind === 'charge' ? f.event('escrow', 'Charged', { id: paymentId, payer, merchant, amount: 1_000_000n }) : f.event('escrow', 'Refunded', { id: paymentId, amount: 500_000n, reason });
    // A refund is merchant-signed and pays its gas in USDT on top; a charge pays no gas fee.
    const executed = f.event('router', 'Executed', { signer: kind === 'charge' ? payer : merchant, merchant, nonce: 1n, target: escrow, gasFee: kind === 'refund' ? 20_000n : 0n });
    f.receipt.mockResolvedValue({ txHash: hash, block: 10n, status: 'success', events: [target, executed] });
    f.db.prepare("INSERT INTO cursor VALUES ('settle','20')").run();
    await f.indexer.poll(); await f.indexer.poll();
    expect(f.row('intents').status).toBe('confirmed');
    expect(f.row('payments')).toMatchObject({ captured_minor: '1000000', refunded_minor: kind === 'charge' ? '0' : '600000' });
    if (kind === 'refund') expect(f.row('refunds').status).toBe('succeeded');
    expect(f.db.prepare('SELECT * FROM chain_events').all()).toHaveLength(2);
    expect(f.db.prepare("SELECT fee_minor FROM accounting_entries WHERE kind='Fee'").all()).toEqual(kind === 'refund' ? [{ fee_minor: '20000' }] : []);
    expect(f.db.prepare('SELECT * FROM webhook_events').all()).toHaveLength(1);
  });
  it.each(['renew', 'subscribe'] as const)('settles a confirmed %s only from its matching event', async kind => {
    const f = fixture(kind);
    const event = kind === 'renew' ? f.event('subscription', 'Charged', { id: paymentId, amount: 1000000n, period: 1 }) : f.event('subscription', 'Subscribed', { id: paymentId, payer, merchant, planId: keccak256(toHex('plan')) });
    f.receipt.mockResolvedValue({ txHash: hash, block: 10n, status: 'success', events: [event] });
    f.chain.logs = [event];
    f.chain.block = 11n;
    await f.indexer.poll();
    expect(f.row('subscriptions').pending_tx_hash).toBe(hash);
    f.chain.block = 12n;
    await f.indexer.poll(); await f.indexer.poll();
    expect(f.row('subscriptions')).toMatchObject({ status: 'active', pending_tx_hash: null });
    expect(f.db.prepare('SELECT * FROM webhook_events').all()).toHaveLength(1);
    if (kind === 'renew') expect(f.row('subscriptions').next_charge_at).toBe('2026-11-02T00:00:00.000Z');
  });
  it('does not settle from getLogs alone while the receipt is missing or errors', async () => {
    const f = fixture('renew');
    const event = f.event('subscription', 'Charged', { id: paymentId, amount: 1000000n });
    f.chain.logs = [event];
    f.receipt.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('timeout'));
    await f.indexer.poll(); await f.indexer.poll();
    expect(f.row('subscriptions')).toMatchObject({ pending_tx_hash: hash, next_charge_at: '2026-01-01' });
    expect(f.db.prepare('SELECT * FROM chain_events').all()).toHaveLength(0);
    f.receipt.mockResolvedValue({ txHash: hash, block: 10n, status: 'success', events: [event] });
    await f.indexer.poll();
    expect(f.row('subscriptions').pending_tx_hash).toBeNull();
  });
  it('never clears a subscription hash because another transaction emits Charged', async () => {
    const f = fixture('renew');
    f.receipt.mockResolvedValue(null);
    f.chain.logs = [{ ...f.event('subscription', 'Charged', { id: paymentId, amount: 1000000n }), txHash: otherHash }];
    await f.indexer.poll();
    expect(f.row('subscriptions')).toMatchObject({ pending_tx_hash: hash, next_charge_at: '2026-01-01' });
  });
  it.each(['wrong_hash', 'wrong_block', 'wrong_id', 'wrong_amount', 'wrong_signer', 'wrong_target'] as const)('requires complete event correlation: %s', async mismatch => {
    const f = fixture();
    const target = f.event('escrow', 'Charged', { id: paymentId, payer, merchant, amount: 1000000n });
    const executed = f.event('router', 'Executed', { signer: payer, merchant, nonce: 1n, target: escrow, reimbursement: 1n });
    if (mismatch === 'wrong_hash') target.txHash = otherHash;
    if (mismatch === 'wrong_block') target.block = 9n;
    if (mismatch === 'wrong_id') target.args.id = otherHash;
    if (mismatch === 'wrong_amount') target.args.amount = 1n;
    if (mismatch === 'wrong_signer') executed.args.signer = merchant;
    if (mismatch === 'wrong_target') executed.args.target = merchant;
    f.receipt.mockResolvedValue({ txHash: hash, block: 10n, status: 'success', events: [target, executed] });
    await f.indexer.poll();
    expect(f.row('intents').status).toBe('reconciliation_required');
    expect(f.row('payments').captured_minor).toBe('0');
    expect(f.db.prepare("SELECT * FROM accounting_entries WHERE kind='Fee'").all()).toHaveLength(0);
  });
  it('does not fail an operation from a receipt for a different hash', async () => {
    const f = fixture();
    f.receipt.mockResolvedValue({ txHash: otherHash, block: 10n, status: 'reverted', events: [] });
    await f.indexer.poll();
    expect(f.row('intents').status).toBe('submitted');
  });
  it('fails legacy refund rows without an associated intent and preserves earlier captures', async () => {
    const f = fixture('refund');
    f.db.prepare('DELETE FROM intents').run();
    await f.indexer.poll();
    expect(f.row('refunds').status).toBe('failed');
    expect(f.row('payments')).toMatchObject({ captured_minor: '1000000', refunded_minor: '100000' });
  });
  it('does not overwrite a payment captured by another attempt when an old charge reverts', async () => {
    const f = fixture();
    f.db.prepare("UPDATE payments SET status='captured',captured_minor='1000000',refunded_minor='100000',tx_hash=?").run(otherHash);
    await f.indexer.poll();
    expect(f.row('intents').status).toBe('failed');
    expect(f.row('payments')).toMatchObject({ status: 'captured', captured_minor: '1000000', refunded_minor: '100000', tx_hash: otherHash });
  });
  it('schedules an insufficient-funds refusal for the next day without immediately retrying it', async () => {
    const f = fixture('renew');
    f.receipt.mockResolvedValue({ txHash: hash, block: 10n, status: 'success', events: [f.event('subscription', 'Refused', { id: paymentId, reason: 5 })] });
    await f.indexer.poll();
    expect(f.row('subscriptions')).toMatchObject({ status: 'past_due', retry_count: 0, pending_tx_hash: null, next_charge_at: '2026-11-02T00:00:00.000Z' });
    expect(f.row('refusal_attempts').reason).toBe('insufficient_funds');
    const renew = vi.spyOn(f.chain, 'renew');
    await runKeeper(f.db, f.chain, new Date('2026-11-01T00:00:01Z'));
    expect(renew).not.toHaveBeenCalled();
  });

  it('records a matching Router refusal even if its log was indexed before the intent row', async () => {
    const f = fixture();
    const event = f.event('router', 'Refused', { signer: payer, merchant, nonce: 1n, reason: 7 });
    f.db.prepare('INSERT INTO chain_events VALUES (?,?,?,?)').run(event.id, '10', hash, '2026-01-01');
    f.receipt.mockResolvedValue({ txHash: hash, block: 10n, status: 'success', events: [event] });
    await f.indexer.poll(); await f.indexer.poll();
    expect(f.row('intents')).toMatchObject({ status: 'refused', reason: 'gas_limit' });
    expect(f.row('payments')).toMatchObject({ status: 'failed', captured_minor: '0' });
    expect(f.db.prepare('SELECT * FROM refusal_attempts').all()).toHaveLength(1);
  });
  it('rechecks the subscription hash after RPC awaits so an older receipt cannot clear a new attempt', async () => {
    const f = fixture('renew');
    f.receipt.mockImplementation(async () => {
      f.db.prepare('UPDATE subscriptions SET pending_tx_hash=?').run(otherHash);
      return { txHash: hash, block: 10n, status: 'reverted', events: [] };
    });
    await f.indexer.poll();
    expect(f.row('subscriptions')).toMatchObject({ status: 'active', pending_tx_hash: otherHash });
    expect(f.db.prepare('SELECT * FROM refusal_attempts').all()).toHaveLength(0);
  });

  it.each(['wrong_reason', 'missing_executed'] as const)('does not bypass tracked refund ambiguity via the legacy fallback: %s', async mismatch => {
    const f = fixture('refund');
    const refunded = f.event('escrow', 'Refunded', { id: paymentId, amount: 500000n, reason: mismatch === 'wrong_reason' ? otherHash : reason });
    const executed = f.event('router', 'Executed', { signer: merchant, merchant, nonce: 1n, target: escrow, gasFee: 0n});
    f.receipt.mockResolvedValue({ txHash: hash, block: 10n, status: 'success', events: mismatch === 'missing_executed' ? [refunded] : [refunded, executed] });
    await f.indexer.poll(); await f.indexer.poll();
    expect(f.row('intents')).toMatchObject({ status: 'reconciliation_required', reason: 'missing_expected_event' });
    expect(f.row('refunds').status).toBe('pending');
    expect(f.row('payments')).toMatchObject({ captured_minor: '1000000', refunded_minor: '100000' });
    expect(f.db.prepare("SELECT * FROM accounting_entries WHERE kind='Fee'").all()).toHaveLength(0);
    expect(f.db.prepare('SELECT * FROM refusal_attempts').all()).toHaveLength(1);
  });
  it('still recovers a successful legacy refund without an intent row', async () => {
    const f = fixture('refund');
    f.db.prepare('DELETE FROM intents').run();
    f.receipt.mockResolvedValue({ txHash: hash, block: 10n, status: 'success', events: [f.event('escrow', 'Refunded', { id: paymentId, amount: 500000n, reason })] });
    await f.indexer.poll(); await f.indexer.poll();
    expect(f.row('refunds').status).toBe('succeeded');
    expect(f.row('payments')).toMatchObject({ captured_minor: '1000000', refunded_minor: '600000' });
    expect(f.db.prepare('SELECT * FROM webhook_events').all()).toHaveLength(1);
  });

});


describe('receipt adapters', () => {
  it('distinguishes not-found from RPC errors and decodes only configured contract logs', async () => {
    const addresses = { router: merchant, escrow, subscription: payer, fees: '0x0000000000000000000000000000000000000006' } as const;
    const adapter = new ViemChain('http://unused.invalid', `0x${'1'.repeat(64)}`, addresses);
    const getTransactionReceipt = vi.fn();
    const getBlock = vi.fn().mockResolvedValue({ timestamp: 1793491200n });
    Object.assign(adapter, { public: { getTransactionReceipt, getBlock } });
    getTransactionReceipt.mockRejectedValueOnce(new TransactionReceiptNotFoundError({ hash }));
    expect(await adapter.receipt(hash)).toBeNull();
    getTransactionReceipt.mockRejectedValueOnce(new Error('429 rate limited'));
    await expect(adapter.receipt(hash)).rejects.toThrow('429 rate limited');
    const log = { address: escrow, logIndex: 2, data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }], [500000n, reason]), topics: encodeEventTopics({ abi: escrowAbi, eventName: 'Refunded', args: { id: paymentId } }) };
    getTransactionReceipt.mockResolvedValue({ transactionHash: hash, blockNumber: 10n, status: 'success', logs: [log, { ...log, address: '0x0000000000000000000000000000000000000009' }, { ...log, topics: [] }] });
    const receipt = await adapter.receipt(hash);
    expect(receipt).toMatchObject({ txHash: hash, block: 10n, status: 'success' });
    expect(receipt!.events).toEqual([{ id: `${hash}:2`, txHash: hash, block: 10n, timestamp: new Date(1793491200 * 1000).toISOString(), contract: 'escrow', name: 'Refunded', args: { id: paymentId, amount: 500000n, reason } }]);
    expect(getBlock).toHaveBeenCalledExactlyOnceWith({ blockNumber: 10n });
    getTransactionReceipt.mockResolvedValue({ transactionHash: hash, blockNumber: 10n, status: 'reverted', logs: [] });
    expect(await adapter.receipt(hash)).toEqual({ txHash: hash, block: 10n, status: 'reverted', events: [] });
    // A reverted transaction still cost the relayer its gas: the receipt reports it.
    getTransactionReceipt.mockResolvedValue({ transactionHash: hash, blockNumber: 10n, status: 'reverted', logs: [], gasUsed: 50_000n, effectiveGasPrice: 5_000_000_000n });
    expect(await adapter.receipt(hash)).toEqual({ txHash: hash, block: 10n, status: 'reverted', events: [], gasCostWei: 250_000_000_000_000n });
  });
  it('models unknown, failed and successful fake receipts without inventing failure', async () => {
    const chain = new FakeChain();
    expect(await chain.receipt(hash)).toBeNull();
    chain.receipts.set(hash, new Error('RPC down'));
    await expect(chain.receipt(hash)).rejects.toThrow('RPC down');
    chain.receipts.set(hash, { txHash: hash, block: 1n, status: 'reverted', events: [] });
    expect((await chain.receipt(hash))!.status).toBe('reverted');
    chain.emit({ id: 'fake-charge', txHash: otherHash, contract: 'escrow', name: 'Charged', args: { id: paymentId, amount: 1n } });
    expect((await chain.receipt(otherHash))!.events).toHaveLength(1);
  });
});
