import type { Hex } from 'viem';
import type { Db } from './db.js';
import { id, now } from './db.js';
import type { ChainAdapter } from './types.js';

/** Ledger entries checked per run, so a backlog after downtime is worked through without stalling. */
const BATCH = 200;

export function initLedgerChecks(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ledger_checks(
    event_id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, tx_hash TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('ok','mismatch','unverifiable')),
    expected_minor TEXT, actual_minor TEXT, checked_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ledger_checks_status ON ledger_checks(status,checked_at);`);
}

/**
 * Verifies the ledger against the token itself, the way a payment processor clears every recorded money
 * movement against its bank: for each ledger entry in a finalized block, the USDT `Transfer` logs of that
 * transaction must move the merchant's wallet by exactly what the ledger says (`token_delta_minor`, summed over
 * the merchant's entries in that transaction). Contract events are not trusted for this: the check reads the
 * token's own logs. A difference is recorded and reported, never corrected silently.
 */
export class LedgerReconciler {
  constructor(private db: Db, private chain: Pick<ChainAdapter, 'finalityHeads' | 'tokenTransfers'>) { initLedgerChecks(db); }
  async run(): Promise<{ checked: number; mismatches: number }> {
    const { finalized } = await this.chain.finalityHeads();
    const entries = this.db.prepare(`SELECT a.event_id,a.merchant_id,a.tx_hash,a.token_delta_minor,m.address FROM accounting_entries a
      JOIN merchants m ON m.id=a.merchant_id LEFT JOIN ledger_checks c ON c.event_id=a.event_id
      WHERE c.event_id IS NULL AND CAST(a.block_number AS INTEGER) <= ? ORDER BY CAST(a.block_number AS INTEGER) LIMIT ?`)
      .all(finalized.toString(), BATCH) as Array<{ event_id: string; merchant_id: string; tx_hash: Hex; token_delta_minor: string | null; address: string }>;
    // One check per (transaction, merchant): a refund and its gas fee are two entries of one movement.
    const groups = new Map<string, typeof entries>();
    for (const entry of entries) {
      const key = `${entry.tx_hash.toLowerCase()}:${entry.merchant_id}`;
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    let checked = 0, mismatches = 0;
    for (const group of groups.values()) {
      const { tx_hash: hash, merchant_id: merchantId, address } = group[0];
      // All of the merchant's entries in this transaction, including any checked in an earlier batch.
      const all = this.db.prepare('SELECT event_id,token_delta_minor FROM accounting_entries WHERE lower(tx_hash)=lower(?) AND merchant_id=?').all(hash, merchantId) as Array<{ event_id: string; token_delta_minor: string | null }>;
      let transfers;
      try { transfers = await this.chain.tokenTransfers(hash); } catch { continue; } // RPC failure: retry next run.
      if (transfers === null) continue;
      const record = (status: 'ok' | 'mismatch' | 'unverifiable', expected: bigint | null, actual: bigint | null) => {
        for (const entry of group) this.db.prepare('INSERT OR IGNORE INTO ledger_checks VALUES (?,?,?,?,?,?,?)').run(entry.event_id, merchantId, hash, status, expected?.toString() ?? null, actual?.toString() ?? null, now());
        checked += group.length;
      };
      if (all.some(entry => entry.token_delta_minor === null)) { record('unverifiable', null, null); continue; }
      const expected = all.reduce((sum, entry) => sum + BigInt(entry.token_delta_minor!), 0n);
      const merchant = address.toLowerCase();
      const actual = transfers.reduce((sum, t) => sum + (t.to.toLowerCase() === merchant ? t.value : 0n) - (t.from.toLowerCase() === merchant ? t.value : 0n), 0n);
      if (actual === expected) { record('ok', expected, actual); continue; }
      mismatches++;
      this.db.transaction(() => {
        record('mismatch', expected, actual);
        this.db.prepare('INSERT INTO refusal_attempts (id,merchant_id,object_id,reason,tx_hash,created_at,source) VALUES (?,?,?,?,?,?,?)').run(id('refusal'), merchantId, hash, 'ledger_mismatch', hash, now(), 'reconciler');
      })();
      console.error(`Ledger mismatch for merchant ${merchantId} in ${hash}: ledger ${expected}, token transfers ${actual}`);
    }
    return { checked, mismatches };
  }
  /** Counts by status, for health checks and the operator. */
  summary() {
    return Object.fromEntries((this.db.prepare('SELECT status,COUNT(*) AS n FROM ledger_checks GROUP BY status').all() as Array<{ status: string; n: number }>).map(r => [r.status, r.n]));
  }
}
