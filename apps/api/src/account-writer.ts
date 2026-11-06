import { AsyncLocalStorage } from 'node:async_hooks';
import { keccak256, type Address, type Hex } from 'viem';
import { id, now, openDb, type Db } from './db.js';
import { Refusal, type ChainAdapter } from './types.js';

export interface WriteOperation {
  id: string; kind: 'intent' | 'refund' | 'cancel' | 'subscribe' | 'renew' | 'approval' | 'x402' | 'x402_reservation' | 'replace' | 'financing' | 'fees' | 'relay' | 'treasury'; objectId: string;
  /** `merchantId` names whose sponsorship budget a write Pact absorbs counts against. */
  links?: { intentId?: string; refundId?: string; subscriptionId?: string; /** A batched renewal: every subscription it charges. */ subscriptionIds?: string[]; replacementSubscriptionId?: string; approvalId?: string; previousSubscriptionStatus?: string; merchantId?: string };
}
export interface PreparedWrite { raw: Hex; hash: Hex }
export interface WriteRecord {
  operation_id: string; kind: WriteOperation['kind']; object_id: string; links_json: string;
  chain_id: number; relayer: Address; nonce: number | null; tx_hash: Hex | null;
  phase: 'preparing' | 'signed' | 'broadcasting' | 'submitted' | 'uncertain' | 'confirmed' | 'not_sent';
  reason: string | null;
  raw_tx?: Hex | null;
  broadcast_attempts?: string | null;
  updated_at?: string;
}
/** Kinds whose writer slot is released once their nonce is committed (see `run`). x402 keeps the slot to the end. */
const PIPELINED: ReadonlySet<WriteOperation['kind']> = new Set(['intent', 'refund', 'cancel', 'subscribe', 'renew', 'approval', 'replace', 'financing', 'fees', 'relay', 'treasury']);

// Exactly one process owns this account. The journal is the nonce authority;
// neither restart nor a lagging pending-count RPC can erase a signed operation.
export class AccountWriter {
  private queue: Promise<unknown> = Promise.resolve();
  private db = openDb();
  private bound = false;
  private slot = new AsyncLocalStorage<() => void>();
  /** Set by the watchdog while the lowest unmined transaction cannot be (re)broadcast: later nonces would wait behind it. */
  stuck: string | null = null;
  /** Release the writer slot after the nonce is committed, so the next write signs while this one is in transit. */
  pipeline = process.env.RELAYER_PIPELINE !== '0';
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
  /** Every journal row, in write order. Diagnostics, startup and tests only: hot paths use indexed queries below. */
  rows(): WriteRecord[] { return this.db.prepare('SELECT * FROM relayer_operations WHERE chain_id=? AND relayer=? ORDER BY rowid').all(this.chainId, this.relayer.toLowerCase()) as WriteRecord[]; }
  record(operationId: string) { return this.db.prepare('SELECT * FROM relayer_operations WHERE operation_id=? AND chain_id=? AND relayer=?').get(operationId, this.chainId, this.relayer.toLowerCase()) as WriteRecord | undefined; }
  /** Operations whose transaction may be on its way or in the mempool: the reconcile loop's work list. */
  inFlight(): WriteRecord[] { return this.db.prepare("SELECT * FROM relayer_operations WHERE chain_id=? AND relayer=? AND phase IN ('broadcasting','submitted','uncertain') AND tx_hash IS NOT NULL ORDER BY nonce").all(this.chainId, this.relayer.toLowerCase()) as WriteRecord[]; }
  /** The next nonce the journal allows: one past the highest nonce any sent or possibly-sent operation holds. */
  private nonceFloor() {
    const row = this.db.prepare("SELECT MAX(nonce) AS n FROM relayer_operations WHERE chain_id=? AND relayer=? AND nonce IS NOT NULL AND phase!='not_sent'").get(this.chainId, this.relayer.toLowerCase()) as { n: number | null };
    return row.n === null ? 0 : row.n + 1;
  }
  /** Another operation holds or may hold a signed transaction: a new write must not take a nonce past it yet. */
  /**
   * Another operation holds a nonce whose transaction could not be resent as signed: one being prepared or
   * signed right now, or an ambiguous one journaled without its raw bytes (before raw storage existed). A
   * write that is broadcasting or uncertain WITH its raw bytes does not block: the watchdog resends exactly
   * those bytes, so a later nonce can only wait behind it, never conflict with it.
   */
  private othersInFlight(ownOperation?: string, onlyAmbiguous = false) {
    const transient = onlyAmbiguous ? '' : " OR phase='signed' OR (phase='preparing' AND nonce IS NOT NULL)";
    // x402 settlements keep their stricter rule: an ambiguous one blocks every write until its receipt resolves.
    return !!this.db.prepare(`SELECT 1 FROM relayer_operations WHERE chain_id=? AND relayer=? AND operation_id!=? AND ((phase IN ('broadcasting','uncertain') AND (raw_tx IS NULL OR kind IN ('x402','x402_reservation')))${transient}) LIMIT 1`).get(this.chainId, this.relayer.toLowerCase(), ownOperation ?? '');
  }
  /** Unmined operations with their raw transaction, lowest nonce first: what the watchdog may resend. */
  unsettled(): WriteRecord[] {
    return this.db.prepare("SELECT * FROM relayer_operations WHERE chain_id=? AND relayer=? AND phase IN ('broadcasting','submitted','uncertain') AND raw_tx IS NOT NULL AND nonce IS NOT NULL AND kind NOT IN ('x402','x402_reservation') ORDER BY nonce").all(this.chainId, this.relayer.toLowerCase()) as WriteRecord[];
  }
  /** Records a (re)broadcast attempt: accepted moves an ambiguous write to submitted; an error is kept for the operator. */
  noteBroadcast(operationId: string, accepted: boolean, error?: string) {
    this.db.prepare(`UPDATE relayer_operations SET broadcast_attempts=CAST(COALESCE(broadcast_attempts,'0') AS INTEGER)+1,updated_at=?,last_error=?,
      phase=CASE WHEN ? AND phase IN ('broadcasting','uncertain') THEN 'submitted' ELSE phase END WHERE operation_id=?`).run(now(), accepted ? null : error ?? 'broadcast_failed', accepted ? 1 : 0, operationId);
  }
  reserveSpend(operationId: string, cost: bigint, limit: bigint, at = Date.now()) {
    if (cost <= 0n || limit <= 0n) throw new Refusal('invalid_gas_budget');
    this.db.transaction(() => {
      const operation = this.record(operationId);
      if (!operation || operation.phase !== 'preparing') throw new Refusal('operation_replay');
      const minute = Math.floor(at / 60_000);
      const existing = this.db.prepare('SELECT cost_wei,minute FROM relayer_spend_reservations WHERE operation_id=?').get(operationId) as { cost_wei: string; minute: number } | undefined;
      if (existing) {
        if (existing.cost_wei !== cost.toString() || existing.minute !== minute) throw new Refusal('operation_replay');
        return;
      }
      const rows = this.db.prepare(`SELECT s.cost_wei FROM relayer_spend_reservations s JOIN relayer_operations o ON o.operation_id=s.operation_id WHERE s.minute=? AND o.chain_id=? AND o.relayer=? AND o.phase!='not_sent'`).all(minute, this.chainId, this.relayer.toLowerCase()) as Array<{ cost_wei: string }>;
      if (rows.reduce((sum, row) => sum + BigInt(row.cost_wei), 0n) + cost > limit) throw new Refusal('circuit_budget');
      this.db.prepare('INSERT INTO relayer_spend_reservations VALUES (?,?,?)').run(operationId, minute, cost.toString());
    })();
  }
  // Reservations created by the caller before its first await are admitted only
  // by their owner. Other operations must not mistake them for abandoned work.
  run<T>(work: () => Promise<T>, ownOperation?: string): Promise<T> {
    // The next write waits until this one commits its nonce and starts broadcasting (pipelined kinds), or ends.
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const result = this.queue.then(() => {
      if (this.db.prepare('SELECT 1 FROM relayer_write_block LIMIT 1').get() || this.db.prepare('SELECT 1 FROM relayer_legacy_holds LIMIT 1').get() || this.othersInFlight(ownOperation)) throw new Refusal('relayer_pending');
      if (this.stuck) throw new Refusal('relayer_stuck', this.stuck);
      return this.slot.run(release, work);
    });
    this.queue = Promise.race([released, result.then(() => undefined, () => undefined)]);
    return result;
  }
  /** Throws `relayer_pending` when a new write could not be admitted right now. A hint only: `run` decides. */
  assertAvailable(ownOperation?: string) {
    if (this.db.prepare('SELECT 1 FROM relayer_write_block LIMIT 1').get() || this.db.prepare('SELECT 1 FROM relayer_legacy_holds LIMIT 1').get() || this.othersInFlight(ownOperation, true)) throw new Refusal('relayer_pending');
    if (this.stuck) throw new Refusal('relayer_stuck', this.stuck);
  }
  operation(kind: WriteOperation['kind'], objectId: string): WriteOperation { return { id: id('op'), kind, objectId }; }
  /** Names the call an operation makes (`target:selector`), so its measured gas prices later calls of the same kind. */
  label(operationId: string, callKey: string) { this.db.prepare('UPDATE relayer_operations SET call_key=? WHERE operation_id=?').run(callKey.toLowerCase(), operationId); }
  /** Execution gas of the latest successful calls of this kind, newest first. */
  measuredGas(callKey: string, limit = 50): bigint[] {
    return (this.db.prepare("SELECT gas_used FROM relayer_operations WHERE call_key=? AND gas_used IS NOT NULL AND receipt_status='success' ORDER BY rowid DESC LIMIT ?").all(callKey.toLowerCase(), limit) as Array<{ gas_used: string }>).map(row => BigInt(row.gas_used));
  }
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
    for (const subscriptionId of links.subscriptionIds ?? []) this.db.prepare('UPDATE subscriptions SET pending_tx_hash=? WHERE id=?').run(hash, subscriptionId);
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
      for (const subscriptionId of links.subscriptionIds ?? []) this.db.prepare('UPDATE subscriptions SET pending_tx_hash=NULL WHERE id=? AND (pending_tx_hash IS NULL OR lower(pending_tx_hash)=lower(?))').run(subscriptionId, row.tx_hash);
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
      const nonce = Math.max(pending, this.nonceFloor());
      this.db.prepare('UPDATE relayer_operations SET nonce=?,updated_at=? WHERE operation_id=?').run(nonce, now(), operation.id);
      tx = await prepare(nonce); // Estimates and local signing are NEVER broadcast.
      if (keccak256(tx.raw) !== tx.hash) throw new Error('Prepared transaction hash mismatch');
      this.db.transaction(() => {
        this.db.prepare("UPDATE relayer_operations SET phase='signed',tx_hash=?,raw_tx=?,updated_at=? WHERE operation_id=?").run(tx.hash, tx.raw, now(), operation.id);
        this.linkHash(original, tx.hash);
      })();
    } catch (error) { this.notSent(operation.id); throw error; }
    // If this commit fails, no send occurs. A restart can safely retire 'signed'.
    try { this.db.prepare("UPDATE relayer_operations SET phase='broadcasting',updated_at=? WHERE operation_id=?").run(now(), operation.id); }
    catch (error) { this.notSent(operation.id); throw error; }
    // The nonce and the exact signed bytes are durable: the next write may take the next nonce now.
    if (this.pipeline && PIPELINED.has(original.kind)) this.slot.getStore()?.();
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
  /** Marks the write confirmed, with what it actually cost the relayer in gas when the receipt says. */
  resolve(hash: Hex, block: bigint, status: 'success' | 'reverted', gasCostWei?: bigint, gasUsed?: bigint) {
    this.db.prepare("UPDATE relayer_operations SET phase='confirmed',receipt_block=?,receipt_status=?,gas_cost_wei=COALESCE(?,gas_cost_wei),gas_used=COALESCE(?,gas_used),updated_at=? WHERE chain_id=? AND relayer=? AND lower(tx_hash)=lower(?) AND phase IN ('broadcasting','submitted','uncertain')").run(block.toString(), status, gasCostWei?.toString() ?? null, gasUsed?.toString() ?? null, now(), this.chainId, this.relayer.toLowerCase(), hash);
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
    const rows = this.inFlight();
    if (!rows.length) return;
    try {
      if (await chain.chainId() !== this.chainId) return;
      const safe = await chain.latestBlock() - confirmations;
      for (const row of rows) {
        try {
          const receipt = await chain.receipt(row.tx_hash!);
          if (receipt && receipt.txHash.toLowerCase() === row.tx_hash!.toLowerCase() && receipt.block <= safe && ['success', 'reverted'].includes(receipt.status)) this.resolve(row.tx_hash!, receipt.block, receipt.status, receipt.gasCostWei, receipt.gasUsed);
        } catch { /* Missing receipts/read errors never prove a dropped tx. */ }
      }
    } catch { /* Leave persisted uncertainty unchanged. */ }
  }
}
