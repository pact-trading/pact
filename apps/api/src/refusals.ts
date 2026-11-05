import type { Address } from 'viem';
import { id, now, type Db } from './db.js';

export type RefusalSource = 'relayer' | 'contract' | 'api';
export interface RefusalRecord { merchantId: string; objectId: string; reason: string; source: RefusalSource; txHash?: string | null; signer?: Address | string | null }

/** Stores a refusal so the merchant's dashboard can show what was stopped, where and why. */
export function recordRefusal(db: Db, r: RefusalRecord) {
  db.prepare('INSERT INTO refusal_attempts (id,merchant_id,object_id,reason,tx_hash,created_at,source,signer) VALUES (?,?,?,?,?,?,?,?)')
    .run(id('refusal'), r.merchantId, r.objectId, r.reason, r.txHash ?? null, now(), r.source, r.signer ? String(r.signer).toLowerCase() : null);
}
export const merchantIdForAddress = (db: Db, address: string) =>
  (db.prepare('SELECT id FROM merchants WHERE lower(address)=? ORDER BY created_at LIMIT 1').get(address.toLowerCase()) as { id: string } | undefined)?.id;
