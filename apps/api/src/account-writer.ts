import { keccak256, type Address, type Hex } from 'viem';
import { id, now, openDb, type Db } from './db.js';
import { Refusal, type ChainAdapter } from './types.js';

export interface WriteOperation {
  id: string; kind: 'intent' | 'refund' | 'cancel' | 'subscribe' | 'renew' | 'approval' | 'x402' | 'x402_reservation' | 'replace' | 'financing'; objectId: string;
  links?: { intentId?: string; refundId?: string; subscriptionId?: string; replacementSubscriptionId?: string; approvalId?: string; previousSubscriptionStatus?: string };
}
export interface PreparedWrite { raw: Hex; hash: Hex }
export interface WriteRecord {
  operation_id: string; kind: WriteOperation['kind']; object_id: string; links_json: string;
  chain_id: number; relayer: Address; nonce: number | null; tx_hash: Hex | null;
  phase: 'preparing' | 'signed' | 'broadcasting' | 'submitted' | 'uncertain' | 'confirmed' | 'not_sent';
  reason: string | null;
}

// Exactly one process owns this account. The journal is the nonce authority;
// neither restart nor a lagging pending-count RPC can erase a signed operation.
export class AccountWriter {
  private queue: Promise<unknown> = Promise.resolve();
  private db = openDb();
  private bound = false;
  constructor(readonly relayer: Address, readonly chainId = 1874) {}
  bind(db: Db) {
    if (this.bound) { if (this.db !== db) throw new Error('Writer already bound'); return; }
    if (this.rows().length) throw new Error('Bind database before submitting writes');
    this.db.close(); this.db = db; this.bound = true;
    // These phases prove no network write was possible: broadcasting is committed
    // separately BEFORE entering transport. Never perform this while a task runs.
    for (const row of this.rows().filter(r => ['preparing', 'signed'].includes(r.phase))) this.notSent(row.operation_id, 'interrupted_before_broadcast');
    // Old null-hash/unjournaled operations cannot be proven unsent. Quarantine
    // them for the explicit operator adoption path, never clear them on startup.
    for (const [table, key, predicate, hash] of [
      ['intents', 'intentId', "status IN ('submitted','reconciliation_required')", 'tx_hash'],
      ['refunds', 'refundId', "status='pending'", 'tx_hash'],
      ['subscriptions', 'subscriptionId', 'pending_tx_hash IS NOT NULL', 'pending_tx_hash'],
      ['approval_attempts', 'approvalId', "status IN ('prepared','pending','reconciliation_required')", 'tx_hash'],
    ]) {
      const rows = this.db.prepare(`SELECT id,${hash} AS hash FROM ${table} WHERE ${predicate} AND NOT EXISTS (SELECT 1 FROM relayer_operations WHERE json_extract(links_json,'$.${key}')=${table}.id OR (?='subscriptionId' AND json_extract(links_json,'$.replacementSubscriptionId')=${table}.id))`).all(key) as Array<{ id: string; hash: string | null }>;
      for (const row of rows) this.db.prepare('INSERT OR IGNORE INTO relayer_legacy_holds VALUES (?,?)').run(`${key}:${row.id}`, row.hash);
    }
  }
  rows(): WriteRecord[] { return this.db.prepare('SELECT * FROM relayer_operations WHERE chain_id=? AND relayer=?').all(this.chainId, this.relayer.toLowerCase()) as WriteRecord[]; }
  record(operationId: string) { return this.rows().find(r => r.operation_id === operationId); }
  reserveSpend(operationId: string, cost: bigint, limit: bigint, at = Date.now()) {
    if (cost <= 0n || limit <= 0n) throw new Refusal('invalid_gas_budget');
    this.db.exec('CREATE TABLE IF NOT EXISTS relayer_spend_reservations(operation_id TEXT PRIMARY KEY, minute INTEGER NOT NULL, cost_wei TEXT NOT NULL)');
    this.db.transaction(() => {
      const operation = this.record(operationId);
      if (!operation || operation.phase !== 'preparing') throw new Refusal('operation_replay');
      const minute = Math.floor(at / 60_000);
      const existing = this.db.prepare('SELECT cost_wei,minute FROM relayer_spend_reservations WHERE operation_id=?').get(operationId) as { cost_wei: string; minute: number } | undefined;
      if (existing) {
        if (existing.cost_wei !== cost.toString() || existing.minute !== minute) throw new Refusal('operation_replay');
        return;
      }
      const rows = this.db.prepare(`SELECT s.cost_wei FROM relayer_spend_reservations s JOIN relayer_operations o ON o.operation_id=s.operation_id WHERE o.chain_id=? AND o.relayer=? AND o.phase!='not_sent' AND s.minute=?`).all(this.chainId, this.relayer.toLowerCase(), minute) as Array<{ cost_wei: string }>;
      if (rows.reduce((sum, row) => sum + BigInt(row.cost_wei), 0n) + cost > limit) throw new Refusal('circuit_budget');
      this.db.prepare('INSERT INTO relayer_spend_reservations VALUES (?,?,?)').run(operationId, minute, cost.toString());
    })();
  }
  // Reservations created by the caller before its first await are admitted only
  // by their owner. Other operations must not mistake them for abandoned work.
  run<T>(work: () => Promise<T>, ownOperation?: string): Promise<T> {
    const result = this.queue.then(() => {
      const others = this.rows().some(r => r.operation_id !== ownOperation && (['signed', 'broadcasting', 'uncertain'].includes(r.phase) || (r.phase === 'preparing' && r.nonce !== null)));
      if (this.db.prepare('SELECT 1 FROM relayer_write_block LIMIT 1').get() || this.db.prepare('SELECT 1 FROM relayer_legacy_holds LIMIT 1').get() || others) throw new Refusal('relayer_pending');
      return work();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  operation(kind: WriteOperation['kind'], objectId: string): WriteOperation { return { id: id('op'), kind, objectId }; }
  reserve(operation: WriteOperation, reserveDomain?: () => void) {
    this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM relayer_operations WHERE operation_id=?').get(operation.id)) throw new Refusal('operation_replay');
      reserveDomain?.();
      this.db.prepare('INSERT INTO relayer_operations(operation_id,kind,object_id,links_json,chain_id,relayer,phase,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(operation.id, operation.kind, operation.objectId, JSON.stringify(operation.links ?? {}), this.chainId, this.relayer.toLowerCase(), 'preparing', now(), now());
    })();
  }
  private linkHash(row: WriteRecord, hash: Hex) {
    const links = JSON.parse(row.links_json) as NonNullable<WriteOperation['links']>;
    if (links.intentId) this.db.prepare("UPDATE intents SET status='submitted',reason=NULL,tx_hash=? WHERE id=?").run(hash, links.intentId);
    if (links.refundId) this.db.prepare('UPDATE refunds SET tx_hash=? WHERE id=?').run(hash, links.refundId);
    if (links.subscriptionId) this.db.prepare('UPDATE subscriptions SET pending_tx_hash=? WHERE id=?').run(hash, links.subscriptionId);
    if (links.replacementSubscriptionId) this.db.prepare('UPDATE subscriptions SET pending_tx_hash=? WHERE id=?').run(hash, links.replacementSubscriptionId);
    if (links.approvalId) this.db.prepare("UPDATE approval_attempts SET status='pending',reason='approval_pending',tx_hash=?,updated_at=? WHERE id=?").run(hash, now(), links.approvalId);
  }
  notSent(operationId: string, reason = 'preparation_failed') {
    const row = this.record(operationId);
    if (!row || !['preparing', 'signed'].includes(row.phase)) return;
    this.db.transaction(() => {
      this.db.prepare("UPDATE relayer_operations SET phase='not_sent',reason=?,updated_at=? WHERE operation_id=?").run(reason, now(), operationId);
      const links = JSON.parse(row.links_json) as NonNullable<WriteOperation['links']>;
      if (links.intentId) this.db.prepare("UPDATE intents SET status='failed',reason=? WHERE id=?").run(reason, links.intentId);
      if (links.refundId) this.db.prepare("UPDATE refunds SET status='failed' WHERE id=?").run(links.refundId);
      if (links.subscriptionId) {
        // Reservation never changes a renewal/cancellation's business status.
        // Do not restore a stale snapshot over an event indexed during preparation.
        this.db.prepare(`UPDATE subscriptions SET
          status=CASE WHEN ?='subscribe' AND status='pending' THEN 'failed' ELSE status END,
          pending_tx_hash=NULL WHERE id=? AND (pending_tx_hash IS NULL OR lower(pending_tx_hash)=lower(?))`)
          .run(row.kind, links.subscriptionId, row.tx_hash);
      }
      if (links.replacementSubscriptionId) this.db.prepare("UPDATE subscriptions SET status='failed',pending_tx_hash=NULL WHERE id=? AND status='pending'").run(links.replacementSubscriptionId);
      if (links.approvalId) this.db.prepare("UPDATE approval_attempts SET status='failed',reason=?,updated_at=? WHERE id=?").run(reason, now(), links.approvalId);
    })();
  }
  async execute(operation: WriteOperation, count: () => Promise<number>, prepare: (nonce: number) => Promise<PreparedWrite>, broadcast: (raw: Hex) => Promise<Hex>): Promise<Hex> {
    if (!this.record(operation.id)) this.reserve(operation);
    const original = this.record(operation.id)!;
    if (original.phase !== 'preparing') throw new Refusal('operation_replay');
    let tx: PreparedWrite;
    try {
      const pending = await count();
      if (!Number.isSafeInteger(pending) || pending < 0) throw new Error('Invalid pending nonce');
      const floor = this.rows().reduce((n, r) => r.phase !== 'not_sent' && r.nonce !== null ? Math.max(n, r.nonce + 1) : n, 0);
      const nonce = Math.max(pending, floor);
      this.db.prepare('UPDATE relayer_operations SET nonce=?,updated_at=? WHERE operation_id=?').run(nonce, now(), operation.id);
      tx = await prepare(nonce); // Estimates and local signing are NEVER broadcast.
      if (keccak256(tx.raw) !== tx.hash) throw new Error('Prepared transaction hash mismatch');
      this.db.transaction(() => {
        this.db.prepare("UPDATE relayer_operations SET phase='signed',tx_hash=?,updated_at=? WHERE operation_id=?").run(tx.hash, now(), operation.id);
        this.linkHash(original, tx.hash);
      })();
    } catch (error) { this.notSent(operation.id); throw error; }
    // If this commit fails, no send occurs. A restart can safely retire 'signed'.
    try { this.db.prepare("UPDATE relayer_operations SET phase='broadcasting',updated_at=? WHERE operation_id=?").run(now(), operation.id); }
    catch (error) { this.notSent(operation.id); throw error; }
    try {
      const returned = await broadcast(tx.raw);
      if (returned.toLowerCase() !== tx.hash.toLowerCase()) throw new Error('Broadcast hash mismatch');
      this.db.prepare("UPDATE relayer_operations SET phase='submitted',updated_at=? WHERE operation_id=? AND phase='broadcasting'").run(now(), operation.id);
    } catch {
      const changed = this.db.prepare("UPDATE relayer_operations SET phase='uncertain',reason='broadcast_uncertain',updated_at=? WHERE operation_id=? AND phase='broadcasting'").run(now(), operation.id);
      const links = changed.changes ? operation.links : undefined;
      if (links?.approvalId) this.db.prepare("UPDATE approval_attempts SET reason='broadcast_uncertain' WHERE id=?").run(links.approvalId);
      if (links?.intentId) this.db.prepare("UPDATE intents SET reason='broadcast_uncertain' WHERE id=?").run(links.intentId);
      // Return the locally computed identity, not a false failure or invitation
      // to retry. Domain records already point at this hash before transport.
    }
    return tx.hash;
  }
  resolve(hash: Hex, block: bigint, status: 'success' | 'reverted') {
    this.db.prepare("UPDATE relayer_operations SET phase='confirmed',receipt_block=?,receipt_status=?,updated_at=? WHERE chain_id=? AND relayer=? AND lower(tx_hash)=lower(?) AND phase IN ('broadcasting','submitted','uncertain')").run(block.toString(), status, now(), this.chainId, this.relayer.toLowerCase(), hash);
    this.db.prepare('DELETE FROM relayer_write_block WHERE lower(tx_hash)=lower(?)').run(hash);
  }
  // Explicit OFFLINE operator path; deliberately not exposed by an HTTP route.
  // Requires a discovered transaction, caller-reviewed calldata fingerprint and
  // read-only RPC evidence. There is no "clear unknown and retry" operation.
  async adoptLegacy(operation: WriteOperation, hash: Hex, expected: { to: Address; dataHash: Hex; note: string; acknowledgeUnknown?: boolean }, reader: {
    chainId(): Promise<number>;
    transaction(hash: Hex): Promise<{ hash: Hex; from: Address; to: Address | null; input: Hex; nonce: number; chainId: number }>;
  }) {
    if (expected.note.trim().length < 20) throw new Error('Operator reconciliation note required');
    const tx = await reader.transaction(hash);
    if (await reader.chainId() !== this.chainId || tx.chainId !== this.chainId || tx.hash.toLowerCase() !== hash.toLowerCase() || tx.from.toLowerCase() !== this.relayer.toLowerCase() || tx.to?.toLowerCase() !== expected.to.toLowerCase() || keccak256(tx.input) !== expected.dataHash || !Number.isSafeInteger(tx.nonce) || tx.nonce < 0) throw new Error('Legacy transaction identity mismatch');
    this.db.transaction(() => {
      this.reserve(operation);
      this.db.prepare("UPDATE relayer_operations SET phase='uncertain',nonce=?,tx_hash=?,reason='operator_adopted',updated_at=? WHERE operation_id=?").run(tx.nonce, hash, now(), operation.id);
      this.linkHash(this.record(operation.id)!, hash);
      for (const [key, value] of Object.entries(operation.links ?? {})) this.db.prepare('DELETE FROM relayer_legacy_holds WHERE reference=?').run(`${key}:${value}`);
      this.db.prepare('DELETE FROM relayer_write_block WHERE lower(tx_hash)=lower(?)').run(hash);
      if (expected.acknowledgeUnknown) this.db.prepare("DELETE FROM relayer_write_block WHERE tx_hash='unknown'").run();
      this.db.prepare('INSERT INTO relayer_recovery_audit VALUES (?,?,?,?,?)').run(id('recovery'), operation.id, hash, expected.note, now());
    })();
  }
  async reconcile(chain: Pick<ChainAdapter, 'chainId' | 'latestBlock' | 'receipt'>, confirmations: bigint) {
    if (confirmations < 1n) confirmations = 1n;
    const rows = this.rows().filter(r => r.tx_hash && ['broadcasting', 'submitted', 'uncertain'].includes(r.phase));
    if (!rows.length) return;
    try {
      if (await chain.chainId() !== this.chainId) return;
      const safe = await chain.latestBlock() - confirmations;
      for (const row of rows) {
        try {
          const receipt = await chain.receipt(row.tx_hash!);
          if (receipt && receipt.txHash.toLowerCase() === row.tx_hash!.toLowerCase() && receipt.block <= safe && ['success', 'reverted'].includes(receipt.status)) this.resolve(row.tx_hash!, receipt.block, receipt.status);
        } catch { /* Missing receipts/read errors never prove a dropped tx. */ }
      }
    } catch { /* Leave persisted uncertainty unchanged. */ }
  }
}
