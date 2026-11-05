import type { Db } from './db.js';
import type { ChainAdapter } from './types.js';
import type { Hex } from 'viem';
import { recordAccounting } from './accounting.js';

/** Read-only chain calls. Writes only the additive accounting table, never payment state/cursors. */
export async function backfillAccounting(db: Db, chain: Pick<ChainAdapter, 'chainId' | 'latestBlock' | 'receipt'>, confirmations = 2n) {
  if (await chain.chainId() !== 1874) throw new Error('Wrong chain');
  if (confirmations < 0n) throw new Error('Invalid confirmation depth');
  const safe = await chain.latestBlock() - confirmations;
  const hashes = db.prepare('SELECT DISTINCT lower(tx_hash) AS hash FROM chain_events ORDER BY block_number').all() as { hash: Hex }[];
  let receipts = 0, inserted = 0;
  const unresolved: string[] = [];
  for (const { hash } of hashes) {
    const receipt = await chain.receipt(hash);
    if (!receipt || receipt.txHash.toLowerCase() !== hash || receipt.block > safe || receipt.status !== 'success') { unresolved.push(hash); continue; }
    const acceptedIds = db.prepare('SELECT id,block_number FROM chain_events WHERE lower(tx_hash)=?').all(hash) as { id: string; block_number: string }[];
    if (acceptedIds.some(row => !receipt.events.some(event => event.id === row.id && event.block === receipt.block && event.block.toString() === row.block_number && event.txHash.toLowerCase() === hash))) { unresolved.push(hash); continue; }
    inserted += db.transaction(() => {
      const before = (db.prepare('SELECT COUNT(*) n FROM accounting_entries').get() as { n: number }).n;
      for (const event of receipt.events) {
        if (event.txHash.toLowerCase() !== hash || event.block !== receipt.block) continue;
        // Only financial events the original indexer actually accepted are eligible.
        const accepted = db.prepare('SELECT 1 FROM chain_events WHERE id=? AND lower(tx_hash)=? AND block_number=?').get(event.id, hash, event.block.toString());
        const rejected = db.prepare("SELECT 1 FROM refusal_attempts WHERE lower(tx_hash)=? AND object_id=? AND reason='payment_event_mismatch'").get(hash, String(event.args.id ?? ''));
        if (accepted && !rejected) recordAccounting(db, event);
      }
      return (db.prepare('SELECT COUNT(*) n FROM accounting_entries').get() as { n: number }).n - before;
    })();
    receipts++;
  }
  if (!unresolved.length) db.prepare('UPDATE accounting_state SET coverage_complete=1 WHERE id=1').run();
  return { receipts, inserted, unresolved };
}
