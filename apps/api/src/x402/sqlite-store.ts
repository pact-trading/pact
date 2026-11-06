import type { PendingSettlementStore } from '@x402/core/facilitator';
import { isHash, keccak256, toHex, type Hex } from 'viem';
import type { Db } from '../db.js';

/** Stable JSON for durable fingerprints, including bigint values and reordered HTTP objects. */
export function canonicalJson(value: unknown): string {
  function normalize(v: unknown): unknown {
    if (typeof v === 'bigint') return v.toString();
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, normalize(x)]));
    return v;
  }
  return JSON.stringify(normalize(value));
}
export const fingerprint = (value: unknown) => keccak256(toHex(canonicalJson(value)));
export function initX402Store(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS x402_operations (
      operation_key TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('x402','x402_reservation')),
      chain_id INTEGER NOT NULL, payer TEXT NOT NULL, permit_nonce TEXT NOT NULL, permit_digest TEXT,
      merchant TEXT NOT NULL, amount TEXT NOT NULL, fingerprint TEXT NOT NULL, identity_json TEXT NOT NULL,
      write_id TEXT NOT NULL UNIQUE, confirmations TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'new',
      request_json TEXT, request_hash TEXT, result_json TEXT, http_result_json TEXT, receipt_json TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS x402_global_permit_nonce ON x402_operations(chain_id,payer,permit_nonce) WHERE kind='x402';
    CREATE UNIQUE INDEX IF NOT EXISTS x402_account_digest ON x402_operations(chain_id,payer,permit_digest) WHERE kind='x402_reservation';
    CREATE TABLE IF NOT EXISTS x402_pending_settlements (
      namespace TEXT NOT NULL, payment_key TEXT NOT NULL, tx_hash TEXT NOT NULL, PRIMARY KEY(namespace,payment_key));
    CREATE TABLE IF NOT EXISTS x402_sponsorship_reservations (
      write_id TEXT PRIMARY KEY REFERENCES relayer_operations(operation_id), merchant TEXT NOT NULL,
      day INTEGER NOT NULL, max_cost_wei TEXT NOT NULL, policy_json TEXT NOT NULL);
  `);
  // Additive migration preserves all original direct-call identities and global nonce claims. Every operation is 'direct'.
  if (!(db.pragma('table_info(x402_operations)') as { name: string }[]).some(c => c.name === 'variant')) db.exec("ALTER TABLE x402_operations ADD COLUMN variant TEXT NOT NULL DEFAULT 'direct'");
}
/** No TTL: absence/age cannot prove a broadcast was dropped. Deletion only forgets the upstream
 * retry hint. x402_operations + AccountWriter retain authoritative hash/nonce ownership forever. */
export class SqlitePendingSettlementStore implements PendingSettlementStore {
  constructor(private readonly db: Db, private readonly namespace: string) { initX402Store(db); }
  async get(key: string): Promise<string | undefined> {
    return (this.db.prepare('SELECT tx_hash FROM x402_pending_settlements WHERE namespace=? AND payment_key=?').get(this.namespace, key) as { tx_hash: string } | undefined)?.tx_hash;
  }
  async set(key: string, hash: string) {
    if (!isHash(hash)) throw new Error('invalid_pending_hash');
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT tx_hash FROM x402_pending_settlements WHERE namespace=? AND payment_key=?').get(this.namespace, key) as { tx_hash: Hex } | undefined;
      if (row && row.tx_hash.toLowerCase() !== hash.toLowerCase()) throw new Error('pending_hash_conflict');
      this.db.prepare('INSERT OR IGNORE INTO x402_pending_settlements VALUES (?,?,?)').run(this.namespace, key, hash.toLowerCase());
    })();
  }
  async delete(key: string) { this.db.prepare('DELETE FROM x402_pending_settlements WHERE namespace=? AND payment_key=?').run(this.namespace, key); }
}
