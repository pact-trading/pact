import type { Hex } from 'viem';
import type { Db } from './db.js';
import { now } from './db.js';

/** The keeper's last renewal attempt for a subscription, shown on its renewal status. */
export interface RenewalStatus { state: string; reason: string; operationId?: string; txHash?: Hex }
export function initRenewalStatus(db: Db) {
  db.exec('CREATE TABLE IF NOT EXISTS renewal_service_status(subscription_id TEXT PRIMARY KEY,state TEXT NOT NULL,reason TEXT NOT NULL,operation_id TEXT,updated_at TEXT NOT NULL)');
}
export function setRenewalStatus(db: Db, sub: string, state: string, reason: string, operationId?: string): RenewalStatus {
  db.prepare(`INSERT INTO renewal_service_status VALUES (?,?,?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,operation_id=excluded.operation_id,updated_at=excluded.updated_at`)
    .run(sub, state, reason, operationId ?? null, now());
  return { state, reason, ...(operationId ? { operationId } : {}) };
}
