import type { Hex } from 'viem';
import type { AccountWriter } from './account-writer.js';

export interface WatchdogChain {
  /** Transactions of the relayer account already mined (the `latest` nonce). */
  minedNonce(): Promise<number>;
  broadcastTransaction(raw: Hex): Promise<Hex>;
}
export interface WatchdogOptions {
  /** Resend an unmined transaction this long after its last broadcast. */
  rebroadcastAfterMs: number;
  /** Stop admitting writes when the lowest unmined transaction has been out this long without being mined. */
  stuckAfterMs: number;
}
export const DEFAULT_WATCHDOG: WatchdogOptions = { rebroadcastAfterMs: 6_000, stuckAfterMs: 90_000 };
/** The node already has this transaction, or its nonce is spent (by it): resending changed nothing. */
const BENIGN = /already known|known transaction|already imported|nonce too low|nonce has already been used|replacement transaction underpriced/i;

/**
 * Keeps the relayer account's nonce sequence moving. A broadcast can be lost (an RPC timeout, a sequencer
 * restart, a mempool eviction) and every later nonce then waits behind it. The journal holds each signed
 * transaction's exact bytes, so the watchdog resends those bytes: same nonce, same hash, so it can never
 * create a second payment. Only the lowest unmined nonce matters; later ones follow it into the block.
 * When even that cannot be sent (no gas, a rejected transaction) the account is marked stuck: new writes
 * are refused (`relayer_stuck`) and the operator is alerted, rather than queueing behind a gap.
 */
export class RelayerWatchdog {
  constructor(private writer: AccountWriter, private chain: WatchdogChain, private options: WatchdogOptions = DEFAULT_WATCHDOG, private now = () => Date.now()) {}
  async run(): Promise<{ resent: number; stuck: string | null }> {
    const rows = this.writer.unsettled();
    if (!rows.length) { this.writer.stuck = null; return { resent: 0, stuck: null }; }
    const mined = await this.chain.minedNonce();
    let resent = 0;
    const waiting = rows.filter(row => row.nonce! >= mined);
    if (!waiting.length) { this.writer.stuck = null; return { resent: 0, stuck: null }; }
    for (const row of waiting) {
      const age = this.now() - Date.parse(row.updated_at ?? new Date(0).toISOString());
      if (age < this.options.rebroadcastAfterMs) continue;
      try {
        await this.chain.broadcastTransaction(row.raw_tx!);
        this.writer.noteBroadcast(row.operation_id, true);
        resent++;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.writer.noteBroadcast(row.operation_id, BENIGN.test(message), BENIGN.test(message) ? undefined : message.slice(0, 500));
      }
    }
    // Stuck: the lowest unmined transaction has been out too long and its last resend failed.
    const lowest = this.writer.record(waiting[0].operation_id)!;
    const outFor = this.now() - Date.parse((lowest as { created_at?: string }).created_at ?? lowest.updated_at ?? new Date().toISOString());
    const failing = !!(lowest as { last_error?: string | null }).last_error;
    if (failing && outFor >= this.options.stuckAfterMs) {
      const reason = `nonce ${lowest.nonce} (${lowest.tx_hash}) cannot be broadcast: ${(lowest as { last_error?: string }).last_error}`;
      if (this.writer.stuck !== reason) console.error(`Relayer ${this.writer.relayer} stuck: ${reason}`);
      this.writer.stuck = reason;
    } else this.writer.stuck = null;
    return { resent, stuck: this.writer.stuck };
  }
}
