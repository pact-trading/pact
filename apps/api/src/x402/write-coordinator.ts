import { AsyncLocalStorage } from 'node:async_hooks';
import type { SettleResponse } from '@x402/core/types';
import { decodeEventLog, decodeFunctionData, encodeFunctionData, keccak256, parseAbi, toHex, type Address, type Hex } from 'viem';
import { AccountWriter, type WriteOperation } from '../account-writer.js';
import type { Db } from '../db.js';
import { agentAccountAbi } from './account-client.js';
import { NETWORK, USDT } from './constants.js';
import { canonicalJson, fingerprint, initX402Store } from './sqlite-store.js';
import { bindSettlement, reservationDigest, reservationFingerprint, same, validateEnvelope } from './call-binding.js';
import { X402WriteRefusal } from './write-ports.js';
import type { MerchantSponsorshipPolicy, X402Receipt, X402Transaction, X402WritePorts } from './write-ports.js';
import { gasCost } from '../approval-chain.js';

export interface X402CoordinatorConfig {
  db: Db; writer: AccountWriter; ports: X402WritePorts; sponsorship: MerchantSponsorshipPolicy;
  /** Same relayer-wide limit used by other AccountWriter callers. */
  maxSpendPerMinuteWei: bigint;
  /** Number of successor blocks, matching AccountWriter.reconcile (safe=head-depth). */
  confirmations: bigint;
  clock?: () => number;
}
export interface OperationIdentity {
  key: string; kind: 'x402' | 'x402_reservation'; payer: Address; nonce: string;
  merchant: Address; amount: bigint; fingerprint: Hex; permitDigest?: Hex;
}
interface OperationRow {
  operation_key: string; kind: OperationIdentity['kind']; payer: Address; permit_nonce: string;
  permit_digest: Hex | null; merchant: Address; amount: string; fingerprint: Hex; identity_json: string;
  write_id: string; confirmations: string; state: string; request_json: string | null;
  request_hash: Hex | null; result_json: string | null; receipt_json: string | null;
}
const events = parseAbi([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event Reserved(bytes32 indexed digest,address indexed merchant,uint256 ceiling,uint256 day)',
]);
const settledTopic = keccak256(toHex('Settled()'));

/** Uses the ONE existing AccountWriter queue. No second nonce allocator, signer or broadcast retry.
 * AccountWriter is explicitly single-process owned; sharing this SQLite file does not authorize
 * two writers/processes for the same relayer. Multiple journal instances must share that writer. */
export class X402WriteCoordinator {
  private readonly context = new AsyncLocalStorage<{ key: string; active: boolean; writes: Promise<Hex>[] }>();
  private readonly time: () => number;
  constructor(readonly config: X402CoordinatorConfig) {
    if (config.writer.chainId !== 1874 || config.confirmations < 1n || config.maxSpendPerMinuteWei <= 0n || !config.sponsorship?.authorize) throw new Error('invalid_x402_writer_config');
    if (config.ports.writer && config.ports.writer !== config.writer) throw new Error('x402_shared_writer_required');
    config.writer.bind(config.db);
    initX402Store(config.db);
    this.time = config.clock ?? Date.now;
  }
  get address() { return this.config.writer.relayer; }
  private row(key: string) { return this.config.db.prepare('SELECT * FROM x402_operations WHERE operation_key=?').get(key) as OperationRow | undefined; }
  claim(identity: OperationIdentity): string {
    const { db } = this.config;
    const normalized = { ...identity, payer: identity.payer.toLowerCase(), merchant: identity.merchant.toLowerCase(), fingerprint: identity.fingerprint.toLowerCase() };
    const identityJson = canonicalJson({ ...normalized, relayer: this.address.toLowerCase() });
    db.transaction(() => {
      const existing = this.row(identity.key);
      if (existing) {
        if (existing.identity_json !== identityJson) throw new Error('x402_idempotency_conflict');
        return;
      }
      db.prepare(`INSERT INTO x402_operations(operation_key,kind,chain_id,payer,permit_nonce,permit_digest,merchant,amount,fingerprint,identity_json,write_id,confirmations,created_at,updated_at,variant)
        VALUES (?,?,1874,?,?,?,?,?,?,?,?,?,?,?,?)`).run(identity.key, identity.kind, normalized.payer, identity.nonce, identity.permitDigest ?? null, normalized.merchant, identity.amount.toString(), normalized.fingerprint, identityJson, `x402-write:${fingerprint(identity.key)}`, this.config.confirmations.toString(), this.time(), this.time(), 'direct');
    })();
    return identity.key;
  }
  private response(row: OperationRow, success: boolean, reason?: string): SettleResponse {
    const write = this.config.writer.record(row.write_id);
    return { success, network: NETWORK, transaction: write?.phase === 'not_sent' ? '' : write?.tx_hash ?? '', payer: row.payer, ...(reason ? { errorReason: reason } : {}) };
  }
  private finish(row: OperationRow, success: boolean, reason?: string) {
    const result = this.response(row, success, reason);
    this.config.db.prepare("UPDATE x402_operations SET state=?,result_json=?,updated_at=? WHERE operation_key=? AND state NOT IN ('succeeded','failed')")
      .run(success ? 'succeeded' : 'failed', canonicalJson(result), this.time(), row.operation_key);
  }
  result(key: string): SettleResponse {
    const row = this.row(key); if (!row) throw new Error('unknown_x402_operation');
    return row.result_json ? JSON.parse(row.result_json) as SettleResponse : this.response(row, false, row.state === 'reconciliation_required' ? 'reconciliation_required' : 'settlement_pending');
  }
  async run(key: string, work: () => Promise<SettleResponse | void>): Promise<SettleResponse> {
    await this.reconcile(key);
    let row = this.row(key)!;
    if (row.result_json || this.config.writer.record(row.write_id)?.tx_hash) return this.result(key);
    try {
      return await this.config.writer.run(async () => {
        // A concurrent identical request may have completed while this one waited in the writer queue.
        await this.reconcile(key);
        row = this.row(key)!;
        if (row.result_json || this.config.writer.record(row.write_id)?.tx_hash) return this.result(key);
        let httpResult: SettleResponse | void;
        let failure: string | undefined;
        const scope = { key, active: true, writes: [] as Promise<Hex>[] };
        try { httpResult = await this.context.run(scope, work); }
        catch (error) { failure = error instanceof X402WriteRefusal ? error.code : error && typeof error === 'object' && 'code' in error && error.code === 'circuit_budget' ? 'circuit_budget' : 'submission_failed'; }
        scope.active = false;
        // A callback timeout must not release AccountWriter's queue while its send is still running.
        await Promise.allSettled(scope.writes);
        this.config.db.prepare('UPDATE x402_operations SET http_result_json=?,updated_at=? WHERE operation_key=?')
          .run(canonicalJson(httpResult! ?? { error: failure ?? 'no_http_result' }), this.time(), key);
        await this.reconcile(key);
        row = this.row(key)!;
        if (!row.result_json && !this.config.writer.record(row.write_id)) this.finish(row, false, httpResult! && !httpResult.success ? httpResult.errorReason ?? 'verification_failed' : failure ?? 'no_journaled_submission');
        return this.result(key);
      }, row.write_id);
    } catch (error) {
      // A different uncertain writer operation can block queue admission. No callback/send occurred;
      // keep our identity retryable without pretending to know the other transaction's outcome.
      if (error && typeof error === 'object' && 'code' in error && error.code === 'relayer_pending') return this.result(key);
      throw error;
    }
  }
  send(key: string, transaction: X402Transaction): Promise<Hex> {
    const scope = this.context.getStore();
    if (!scope?.active || scope.key !== key) return Promise.reject(new Error('x402_submit_outside_writer'));
    const write = this.sendBound(key, Object.freeze({ ...transaction }));
    scope.writes.push(write);
    // Attach a rejection handler immediately even if the HTTP callback abandoned its await.
    void write.catch(() => undefined);
    return write;
  }
  private async sendBound(key: string, transaction: X402Transaction): Promise<Hex> {
    validateEnvelope(transaction);
    const { db, writer, ports, sponsorship } = this.config;
    const row = this.row(key)!;
    if (row.kind === 'x402') bindSettlement({ id: row.operation_key, fingerprint: row.fingerprint, payer: row.payer, merchant: row.merchant, amount: BigInt(row.amount) }, transaction, this.address);
    else {
      const decoded = decodeFunctionData({ abi: agentAccountAbi, data: transaction.data });
      if (decoded.functionName !== 'reserve' || !same(transaction.to, row.payer)) throw new Error('reservation_call_mismatch');
      const [payment, signature] = decoded.args;
      if (reservationFingerprint(payment, signature) !== row.fingerprint) throw new Error('reservation_signature_conflict');
      if (!same(reservationDigest(payment), row.permit_digest!) || payment.nonce.toString() !== row.permit_nonce || payment.amount !== BigInt(row.amount) || !same(payment.to, row.merchant) || !same(encodeFunctionData({ abi: agentAccountAbi, functionName: 'reserve', args: decoded.args }), transaction.data)) throw new Error('reservation_call_mismatch');
    }
    const requestJson = canonicalJson(transaction), requestHash = fingerprint(transaction);
    if (row.request_hash && row.request_hash !== requestHash) throw new Error('x402_transaction_conflict');
    const prior = writer.record(row.write_id);
    if (prior) {
      if (prior.phase === 'not_sent') throw new Error('x402_operation_not_sent');
      if (prior.tx_hash) return prior.tx_hash; // Never reconstruct/rebroadcast an ambiguous write.
      throw new Error('x402_operation_preparing');
    }
    db.prepare('UPDATE x402_operations SET request_json=?,request_hash=?,updated_at=? WHERE operation_key=?')
      .run(requestJson, requestHash, this.time(), key);
    if (await ports.chainId() !== 1874) throw new Error('wrong_chain');
    const approved = await sponsorship.authorize({ operationId: key, kind: row.kind, payer: row.payer, merchant: row.merchant, amount: BigInt(row.amount), transaction }).catch(() => { throw new X402WriteRefusal('sponsorship_not_authorized'); });
    const grant = Object.freeze({ ...approved });
    if (!grant.policyId || grant.maxFeePerGas <= 0n || grant.merchantDailyLimitWei <= 0n || !Number.isSafeInteger(grant.merchantDailyCalls) || grant.merchantDailyCalls <= 0) throw new Error('invalid_sponsorship_grant');
    const cost = transaction.gas * grant.maxFeePerGas, at = this.time(), day = Math.floor(at / 86_400_000);
    const operation: WriteOperation = { id: row.write_id, kind: row.kind, objectId: key };
    // All reservations commit before prepare can sign. Any budget rejection rolls back all three.
    db.transaction(() => {
      writer.reserve(operation, () => {
        const usage = db.prepare(`SELECT s.max_cost_wei FROM x402_sponsorship_reservations s JOIN relayer_operations w ON w.operation_id=s.write_id
          WHERE w.chain_id=1874 AND s.merchant=? AND w.phase!='not_sent'
          AND (s.day=? OR w.phase IN ('preparing','signed','broadcasting','submitted','uncertain'))`).all(row.merchant, day) as { max_cost_wei: string }[];
        if (usage.length + 1 > grant.merchantDailyCalls || usage.reduce((sum, x) => sum + BigInt(x.max_cost_wei), 0n) + cost > grant.merchantDailyLimitWei) throw new X402WriteRefusal('merchant_daily_sponsorship_cap');
      });
      writer.reserveSpend(operation.id, cost, this.config.maxSpendPerMinuteWei, at);
      db.prepare('INSERT INTO x402_sponsorship_reservations VALUES (?,?,?,?,?)').run(operation.id, row.merchant, day, cost.toString(), canonicalJson(grant));
      db.prepare("UPDATE x402_operations SET state='pending',updated_at=? WHERE operation_key=?").run(at, key);
    })();
    return writer.execute(operation, () => ports.transactionCount(), nonce => ports.prepare({ ...transaction, maxFeePerGas: grant.maxFeePerGas }, nonce), raw => ports.broadcast(raw));
  }
  private async matches(row: OperationRow, receipt: X402Receipt): Promise<boolean> {
    const request = row.request_json ? JSON.parse(row.request_json) as X402Transaction : undefined;
    if (!request) return false;
    let transfers = 0n, count = 0, proxyEvent = false, reserved = false;
    for (const log of receipt.logs) {
      if (same(log.address, request.to) && log.topics.length === 1 && same(log.topics[0], settledTopic) && log.data === '0x') proxyEvent = true;
      try {
        const event = decodeEventLog({ abi: events, topics: [...log.topics] as [Hex, ...Hex[]], data: log.data });
        if (event.eventName === 'Transfer' && same(log.address, USDT) && same(event.args.from, row.payer) && same(event.args.to, row.merchant)) { transfers += event.args.value; count++; }
        if (event.eventName === 'Reserved' && same(log.address, row.payer) && same(event.args.digest, row.permit_digest!) && same(event.args.merchant, row.merchant) && event.args.ceiling === BigInt(row.amount)) reserved = true;
      } catch { /* Unrelated logs are not settlement evidence. */ }
    }
    return row.kind === 'x402' ? proxyEvent && count === 1 && transfers === BigInt(row.amount) : reserved;
  }
  /** Read-driven reconciliation is independent of the HTTP callback and writer admission gate.
   * Resolve only the exact hash at configured depth; never infer missing/higher nonce outcomes. */
  async reconcile(key?: string): Promise<void> {
    const { db, ports, writer } = this.config;
    const rows = db.prepare("SELECT * FROM x402_operations WHERE state NOT IN ('succeeded','failed') AND (? IS NULL OR operation_key=?)").all(key ?? null, key ?? null) as OperationRow[];
    for (const row of rows) {
      const write = writer.record(row.write_id);
      if (write?.phase === 'not_sent') { this.finish(row, false, 'transaction_not_sent'); continue; }
      if (!write?.tx_hash) continue;
      try {
        if (await ports.chainId() !== 1874) continue;
        const receipt = await ports.receipt(write.tx_hash);
        if (!receipt || !same(receipt.txHash, write.tx_hash) || receipt.block < 0n || !['success', 'reverted'].includes(receipt.status)) continue;
        db.prepare('UPDATE x402_operations SET receipt_json=?,updated_at=? WHERE operation_key=?').run(canonicalJson(receipt), this.time(), row.operation_key);
        if (receipt.block > await ports.latestBlock() - BigInt(row.confirmations)) continue;
        const matches = receipt.status === 'success' && await this.matches(row, receipt);
        db.transaction(() => {
          writer.resolve(write.tx_hash!, receipt.block, receipt.status, gasCost(receipt).gasCostWei);
          if (receipt.status === 'reverted') this.finish(row, false, 'transaction_reverted');
          else if (matches) this.finish(row, true);
          else db.prepare("UPDATE x402_operations SET state='reconciliation_required',updated_at=? WHERE operation_key=? AND state NOT IN ('succeeded','failed')").run(this.time(), row.operation_key);
        })();
      } catch { /* Read/DB errors preserve all hash, nonce and budget reservations. */ }
    }
  }
}
