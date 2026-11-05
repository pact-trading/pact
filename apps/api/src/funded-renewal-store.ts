import { keccak256, toHex, type Address, type Hex } from 'viem';
import type { Db } from './db.js';
import { now } from './db.js';
import type { ChainEvent, Mandate } from './types.js';

export interface RenewalGrant {
  version: 1; merchantId: string; merchant: Address; subscriptionId: string;
  binding: { appId: string; userId: string; walletId: string; signerId: string; policyId: string; policyHash: Hex };
  chainId: 1874; router: Address; manager: Address; token: Address; chainSubscriptionId: Hex;
  mandate: Mandate; mandateHash: Hex; dataHash: Hex; amount: bigint;
  validFrom: bigint; validUntil: bigint; maxFeeUSDT: bigint; maxGas: number;
  maxGasPriceWei: bigint; maxTransactionCostWei: bigint; maxTotalGasWei: bigint;
  maxCalls: number; maxCallsPerDay: number; maxFeesPerDay: bigint; maxFeesTotal: bigint;
  maxSigningRevisions: number;
  // Local evidence is deliberately NOT a Privy delegation or owner consent.
  acceptance: { kind: 'synthetic-local'; reference: string };
}
export const json = (value: unknown): string => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
function canonical(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export function grantHash(grant: RenewalGrant): Hex { return keccak256(toHex(json(canonical(grant)))); }
const grantBigints = ['amount', 'validFrom', 'validUntil', 'maxFeeUSDT', 'maxGasPriceWei', 'maxTransactionCostWei', 'maxTotalGasWei', 'maxFeesPerDay', 'maxFeesTotal'] as const;
function parseGrant(raw: string): RenewalGrant {
  const value = JSON.parse(raw);
  for (const key of grantBigints) value[key] = BigInt(value[key]);
  for (const key of ['amountCap', 'periodSeconds', 'endTime', 'nonce']) value.mandate[key] = BigInt(value.mandate[key]);
  return value;
}
export function renewalSchema(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS renewal_grants(hash TEXT PRIMARY KEY,subscription_id TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS renewal_grant_revocations(grant_hash TEXT PRIMARY KEY,reason TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS renewal_attempts(id TEXT PRIMARY KEY,subscription_id TEXT NOT NULL,chain_id INTEGER NOT NULL,manager TEXT NOT NULL,chain_subscription_id TEXT NOT NULL,period INTEGER NOT NULL,retry INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(chain_id,manager,chain_subscription_id,period,retry));
    CREATE TABLE IF NOT EXISTS renewal_signing_revisions(operation_id TEXT PRIMARY KEY,attempt_id TEXT NOT NULL,revision INTEGER NOT NULL,grant_hash TEXT NOT NULL,typed_data_json TEXT NOT NULL,request_json TEXT NOT NULL,day INTEGER NOT NULL,fee TEXT NOT NULL,gas_cost TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(attempt_id,revision));
    CREATE TABLE IF NOT EXISTS renewal_signatures(operation_id TEXT PRIMARY KEY,signature TEXT NOT NULL,provider_request_id TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS renewal_service_status(subscription_id TEXT PRIMARY KEY,state TEXT NOT NULL,reason TEXT NOT NULL,operation_id TEXT,updated_at TEXT NOT NULL);
  `);
  for (const table of ['renewal_grants', 'renewal_grant_revocations', 'renewal_attempts', 'renewal_signing_revisions', 'renewal_signatures']) {
    for (const action of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable renewal record'); END`);
  }
}
export interface RenewalStatus { state: string; reason: string; operationId?: string; txHash?: Hex; automatic?: 'disabled' }
export function setRenewalStatus(db: Db, sub: string, state: string, reason: string, operationId?: string): RenewalStatus {
  db.prepare(`INSERT INTO renewal_service_status VALUES (?,?,?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,operation_id=excluded.operation_id,updated_at=excluded.updated_at`).run(sub, state, reason, operationId ?? null, now());
  return { state, reason, ...(operationId ? { operationId } : {}) };
}
export class RenewalStore {
  constructor(readonly db: Db) { renewalSchema(db); }
  getGrant(hash: Hex) {
    const row = this.db.prepare('SELECT payload FROM renewal_grants WHERE hash=?').get(hash) as { payload: string } | undefined;
    if (!row) return undefined;
    const grant = parseGrant(row.payload);
    if (grantHash(grant) !== hash) throw new Error('Renewal grant digest mismatch');
    return grant;
  }
  activeGrant(sub: string) {
    const rows = this.db.prepare('SELECT hash FROM renewal_grants g WHERE subscription_id=? AND NOT EXISTS (SELECT 1 FROM renewal_grant_revocations r WHERE r.grant_hash=g.hash)').all(sub) as { hash: Hex }[];
    if (rows.length !== 1) return undefined;
    return { hash: rows[0].hash, grant: this.getGrant(rows[0].hash)! };
  }
  revoke(hash: Hex, reason: string) {
    if (!reason.trim() || !this.getGrant(hash)) throw new Error('Grant and revocation reason required');
    this.db.prepare('INSERT OR IGNORE INTO renewal_grant_revocations VALUES (?,?,?)').run(hash, reason, now());
  }
  // Recover the pointer even if a previous disabled tick erased it. Prefer an
  // unresolved operation over a newer proven-unsent preflight. Reading status
  // never retires a journal row or changes its nonce/subscription reservation.
  operationStatus(sub: string): RenewalStatus | undefined {
    const operation = this.db.prepare(`SELECT operation_id FROM relayer_operations o
      WHERE kind='renew' AND object_id=? AND json_extract(links_json,'$.intentId') IS NOT NULL
      ORDER BY CASE WHEN phase IN ('preparing','signed','broadcasting','submitted','uncertain')
        OR EXISTS (SELECT 1 FROM intents i WHERE i.id=o.operation_id AND i.status IN ('submitted','reconciliation_required'))
        THEN 0 ELSE 1 END, rowid DESC LIMIT 1`).get(sub) as { operation_id: string } | undefined;
    if (!operation) return undefined;
    return this.operationState(operation.operation_id);
  }
  private operationState(operationId: string): RenewalStatus | undefined {
    const op = this.db.prepare('SELECT phase,reason,tx_hash FROM relayer_operations WHERE operation_id=?').get(operationId) as { phase: string; reason: string | null; tx_hash: Hex | null } | undefined;
    if (!op) return undefined;
    const intent = this.db.prepare('SELECT status,reason FROM intents WHERE id=?').get(operationId) as { status: string; reason: string | null } | undefined;
    const state = op.phase === 'not_sent' ? 'not_sent' : op.phase === 'confirmed' ? intent?.status ?? 'reconciliation_required' : 'pending';
    return { state, reason: intent?.reason ?? op.reason ?? (state === 'confirmed' ? 'funded_renewal_confirmed' : state), operationId, ...(op.tx_hash ? { txHash: op.tx_hash } : {}) };
  }
  status(sub: string): RenewalStatus {
    const row = this.db.prepare('SELECT * FROM renewal_service_status WHERE subscription_id=?').get(sub) as { state: string; reason: string; operation_id: string | null } | undefined;
    const recovered = this.operationStatus(sub);
    if (recovered) return recovered;
    if (!row) return { state: 'disabled', reason: 'automatic_funded_renewal_disabled' };
    return { state: row.state, reason: row.reason };
  }
}

/** Only funded-renewal intents acquire these extra evidence requirements. No
 * legacy subscription/refund fallback or escrow handling is changed here. */
export function fundedRenewalEvidence(db: Db, intentId: string, events: ChainEvent[]): { matches: boolean; reimbursement?: ChainEvent } | undefined {
  const trackedRenewal = db.prepare("SELECT 1 FROM relayer_operations WHERE operation_id=? AND kind='renew' AND json_extract(links_json,'$.intentId')=?").get(intentId, intentId);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='renewal_signing_revisions'").get()) return trackedRenewal ? { matches: false } : undefined;
  const row = db.prepare(`SELECT a.period,a.chain_subscription_id,r.request_json,o.relayer FROM renewal_signing_revisions r JOIN renewal_attempts a ON a.id=r.attempt_id JOIN relayer_operations o ON o.operation_id=r.operation_id WHERE r.operation_id=?`).get(intentId) as { period: number; chain_subscription_id: string; request_json: string; relayer: string } | undefined;
  if (!row) return trackedRenewal ? { matches: false } : undefined;
  const { intent } = JSON.parse(row.request_json);
  const same = (a: unknown, b: unknown) => a !== undefined && b !== undefined && String(a).toLowerCase() === String(b).toLowerCase();
  const executions = events.filter(e => e.contract === 'router' && e.name === 'Executed' && same(e.args.signer, intent.signer) && same(e.args.merchant, intent.merchant) && same(e.args.nonce, intent.nonce) && same(e.args.target, intent.target) && same(e.args.feeUSDT, intent.feeUSDT));
  const charged = events.filter(e => e.contract === 'subscription' && e.name === 'Charged' && same(e.args.id, row.chain_subscription_id) && same(e.args.period, row.period) && same(e.args.amount, intent.amount));
  const executed = executions[0];
  const reimbursements = executed ? events.filter(e => e.contract === 'gasTank' && e.name === 'Reimbursed' && same(e.args.merchant, intent.merchant) && same(e.args.relayer, row.relayer) && same(e.args.amount, executed.args.reimbursement)) : [];
  return { matches: executions.length === 1 && charged.length === 1 && reimbursements.length === 1 && BigInt(executed?.args.reimbursement ?? 0) > 0n, reimbursement: reimbursements[0] };
}
