import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain, escrowAbi } from '../src/chain.js';
import { Indexer, finalityConfig } from '../src/indexer.js';
import type { ChainEvent, Finality } from '../src/types.js';

const hash = `0x${'a'.repeat(64)}` as Hex;
const paymentId = `0x${'c'.repeat(64)}` as Hex;
const merchant = '0x0000000000000000000000000000000000000004';
const payer = '0x0000000000000000000000000000000000000005';
const escrow = '0x0000000000000000000000000000000000000002';
const json = (x: unknown) => JSON.stringify(x, (_, v: unknown) => typeof v === 'bigint' ? String(v) : v);

/** A submitted checkout charge mined at block 10, on a chain whose safe/finalized heads trail by 4/8 blocks. */
function fixture(finality: Finality) {
  const db = openDb();
  const { merchantId } = seedMerchant(db, merchant);
  const chain = new FakeChain();
  chain.safeLag = 4n; chain.finalizedLag = 8n;
  chain.block = 11n;
  const indexer = new Indexer(db, chain, 10n, 1n, finality);
  db.prepare('INSERT INTO payments(id,merchant_id,amount_minor,status,captured_minor,refunded_minor,created_at) VALUES (?,?,?,?,?,?,?)').run(paymentId, merchantId, '1000000', 'open', '0', '0', '2026-01-01');
  const data = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [paymentId, merchant, 1_000_000n, 86400n] });
  const intent = { signer: payer, merchant, target: escrow, nonce: 1n, amount: 1_000_000n };
  db.prepare('INSERT INTO intents VALUES (?,?,?,?,?,?,?,?,?)').run('int', merchantId, payer, '1', json({ intent, data }), 'submitted', null, hash, '2026-01-01');
  const event = (contract: ChainEvent['contract'], name: string, args: ChainEvent['args'], block = 10n): ChainEvent => ({ id: `${hash}:${contract}:${name}`, txHash: hash, block, blockHash: chain.hashOf(block), timestamp: '2026-11-01T00:00:00.000Z', contract, name, args });
  const mined = (block = 10n) => ({ txHash: hash, block, blockHash: chain.hashOf(block), status: 'success' as const, events: [
    event('escrow', 'Charged', { id: paymentId, payer, merchant, amount: 1_000_000n, fee: 150_000n, product: 0 }, block),
    event('router', 'Executed', { signer: payer, merchant, nonce: 1n, target: escrow, gasFee: 0n }, block),
  ] });
  const receipt = vi.fn().mockResolvedValue(mined());
  Object.assign(chain, { receipt });
  const payment = () => db.prepare('SELECT status,captured_minor,finality,finality_block FROM payments').get() as Record<string, string | null>;
  const hooks = () => (db.prepare('SELECT type FROM webhook_events ORDER BY rowid').all() as Array<{ type: string }>).map(r => r.type);
  const ledger = () => db.prepare("SELECT * FROM accounting_entries WHERE kind='Payment'").all();
  return { db, chain, indexer, receipt, mined, payment, hooks, ledger };
}

describe('staged payment finality', () => {
  it('confirms within the block, writes the ledger at safe, and finalizes after the finalized head passes', async () => {
    const f = fixture('safe');
    await f.indexer.poll();
    // In a sequencer block: confirmed and reported, but no ledger entry and no capture yet.
    expect(f.payment()).toMatchObject({ status: 'open', captured_minor: '0', finality: 'confirmed', finality_block: '10' });
    expect(f.hooks()).toEqual(['payment.confirmed']);
    expect(f.ledger()).toHaveLength(0);
    f.chain.block = 14n; // safe head reaches block 10
    await f.indexer.poll();
    expect(f.payment()).toMatchObject({ status: 'captured', captured_minor: '1000000', finality: 'settled' });
    expect(f.hooks()).toEqual(['payment.confirmed', 'payment.captured']);
    expect(f.ledger()).toHaveLength(1);
    f.chain.block = 18n; // finalized head reaches block 10
    await f.indexer.poll(); await f.indexer.poll();
    expect(f.payment()).toMatchObject({ finality: 'final' });
    expect(f.hooks()).toEqual(['payment.confirmed', 'payment.captured', 'payment.finalized']);
  });
  it('withdraws a confirmation whose transaction leaves the chain before it settles, and confirms it again on re-inclusion', async () => {
    const f = fixture('safe');
    await f.indexer.poll();
    expect(f.payment().finality).toBe('confirmed');
    f.receipt.mockResolvedValue(null); // a sequencer reorg dropped the block
    await f.indexer.poll();
    expect(f.payment()).toMatchObject({ status: 'open', finality: null });
    expect(f.hooks()).toEqual(['payment.confirmed', 'payment.confirmation_reverted']);
    f.chain.block = 12n; f.receipt.mockResolvedValue(f.mined(12n)); // re-included one block later
    await f.indexer.poll();
    expect(f.payment()).toMatchObject({ finality: 'confirmed', finality_block: '12' });
    expect(f.hooks()).toEqual(['payment.confirmed', 'payment.confirmation_reverted', 'payment.confirmed']);
    expect(f.ledger()).toHaveLength(0);
  });
  it('flags, never finalizes, a ledger entry whose block was replaced before it became final', async () => {
    const f = fixture('latest');
    await f.indexer.poll();
    expect(f.payment()).toMatchObject({ status: 'captured', finality: 'confirmed' });
    // The chain reorganizes from block 9: block 10 now has a different hash.
    f.chain.reorgFrom = 9n; f.chain.reorgSalt = 1;
    f.chain.block = 18n;
    await f.indexer.poll();
    expect(f.payment().finality).toBe('reorged');
    expect(f.hooks()).not.toContain('payment.finalized');
    expect(f.hooks()).toContain('transaction.reconciliation_required');
    expect(f.db.prepare("SELECT reason FROM refusal_attempts").all()).toEqual([{ reason: 'reorged_after_settlement' }]);
  });
  it('keeps the ledger at the sequencer block with PACT_FINALITY=latest and accepts only the three settings', async () => {
    const f = fixture('latest');
    await f.indexer.poll();
    expect(f.ledger()).toHaveLength(1);
    expect(finalityConfig({})).toBe('latest');
    expect(finalityConfig({ PACT_FINALITY: 'finalized' })).toBe('finalized');
    expect(() => finalityConfig({ PACT_FINALITY: 'unsafe' })).toThrow('PACT_FINALITY');
  });
  it('writes the ledger only at the finalized head with PACT_FINALITY=finalized', async () => {
    const f = fixture('finalized');
    f.chain.block = 14n;
    await f.indexer.poll();
    expect(f.payment()).toMatchObject({ status: 'open', finality: 'confirmed' });
    f.chain.block = 18n;
    await f.indexer.poll();
    expect(f.payment()).toMatchObject({ status: 'captured', finality: 'final' });
    expect(f.hooks()).toEqual(['payment.confirmed', 'payment.captured', 'payment.finalized']);
  });
});

describe('ledger reconciliation against token transfers', () => {
  async function settled() {
    const { LedgerReconciler } = await import('../src/ledger-reconciler.js');
    const f = fixture('latest');
    f.chain.finalizedLag = 0n;
    await f.indexer.poll();
    expect(f.ledger()).toHaveLength(1);
    return { f, reconciler: new LedgerReconciler(f.db, f.chain) };
  }
  it('clears a finalized entry whose USDT transfers move the merchant by exactly the ledger amount', async () => {
    const { f, reconciler } = await settled();
    f.chain.transfers.set(hash, [{ from: payer, to: merchant, value: 850_000n }, { from: payer, to: f.chain.feeRecipient, value: 150_000n }]);
    expect(await reconciler.run()).toEqual({ checked: 1, mismatches: 0 });
    expect(reconciler.summary()).toEqual({ ok: 1 });
    expect(await reconciler.run()).toEqual({ checked: 0, mismatches: 0 });
  });
  it('flags an entry the token logs do not support, and never checks a block that is not final', async () => {
    const { f, reconciler } = await settled();
    f.chain.transfers.set(hash, [{ from: payer, to: merchant, value: 800_000n }]);
    expect(await reconciler.run()).toEqual({ checked: 1, mismatches: 1 });
    expect(f.db.prepare("SELECT reason,source FROM refusal_attempts WHERE reason='ledger_mismatch'").get()).toEqual({ reason: 'ledger_mismatch', source: 'reconciler' });
    const g = fixture('latest');
    await g.indexer.poll();
    const { LedgerReconciler } = await import('../src/ledger-reconciler.js');
    // finalizedLag 8: block 10 is not final at block 11.
    expect(await new LedgerReconciler(g.db, g.chain).run()).toEqual({ checked: 0, mismatches: 0 });
  });
});
