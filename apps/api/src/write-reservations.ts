import type { ChainAdapter, IntentRequest } from './types.js';
import { Refusal } from './types.js';
import { id, now, type Db } from './db.js';
import type { WriteOperation } from './account-writer.js';

// Call synchronously before the route/keeper's first submission await. The
// domain reservation and journal identity commit in the same SQLite transaction.
export function reserveIntent(db: Db, chain: Pick<ChainAdapter, 'writer'>, merchantId: string, request: IntentRequest, kind: 'intent' | 'refund' | 'cancel' | 'replace', objectId: string, links: WriteOperation['links'] = {}, additional?: (intentId: string) => void) {
  const intentId = id('int');
  const operation: WriteOperation = { id: intentId, kind, objectId, links: { ...links, intentId } };
  chain.writer.reserve(operation, () => {
    additional?.(intentId);
    db.prepare('INSERT INTO intents VALUES (?,?,?,?,?,?,?,?,?)').run(intentId, merchantId, request.intent.signer.toLowerCase(), request.intent.nonce.toString(), JSON.stringify(request, (_, v) => typeof v === 'bigint' ? v.toString() : v), 'reconciliation_required', 'preparing', null, now());
  });
  return operation;
}
export function assertSubscriptionAvailable(db: Db, subscriptionId: string) {
  const sub = db.prepare('SELECT status,pending_tx_hash FROM subscriptions WHERE id=?').get(subscriptionId) as { status: string; pending_tx_hash: string | null } | undefined;
  if (!sub || sub.status === 'cancelled') throw new Refusal('subscription_unavailable');
  if (sub.pending_tx_hash || db.prepare("SELECT 1 FROM relayer_operations WHERE object_id=? AND kind IN ('renew','subscribe','cancel','replace','intent') AND phase IN ('preparing','signed','broadcasting','submitted','uncertain')").get(subscriptionId)
    || db.prepare("SELECT 1 FROM relayer_operations o, json_each(o.links_json,'$.subscriptionIds') j WHERE o.kind='renew' AND o.object_id='batch' AND j.value=? AND o.phase IN ('preparing','signed','broadcasting','submitted','uncertain')").get(subscriptionId)) throw new Refusal('subscription_pending');
}
export function reserveRenewal(db: Db, chain: ChainAdapter, subscriptionId: string) {
  const operation: WriteOperation = { id: id('renew'), kind: 'renew', objectId: subscriptionId, links: { subscriptionId } };
  chain.writer.reserve(operation, () => {
    assertSubscriptionAvailable(db, subscriptionId);
    operation.links!.previousSubscriptionStatus = (db.prepare('SELECT status FROM subscriptions WHERE id=?').get(subscriptionId) as { status: string }).status;
  });
  return operation;
}

/** Nonces handed out recently but not yet submitted, per signer, so two open offers never share one. */
const offered = new Map<string, { nonce: bigint; at: number }[]>();
const OFFER_MS = 15 * 60_000;
/**
 * The next Router nonce for a signer. Sequential (not random) so the Router's bitmap keeps 256 of a
 * signer's nonces in one storage slot: after the first, a nonce costs a warm slot update instead of a new
 * 22k-gas slot. Starts after every nonce the signer used here and every nonce offered in the last 15 minutes.
 */
export function nextRouterNonce(db: Db, signer: string): bigint {
  const key = signer.toLowerCase(), now = Date.now();
  let next = 0n;
  for (const row of db.prepare('SELECT nonce FROM intents WHERE signer=?').all(key) as Array<{ nonce: string }>) {
    const n = BigInt(row.nonce);
    if (n < 2n ** 64n && n >= next) next = n + 1n;
  }
  const recent = (offered.get(key) ?? []).filter(o => now - o.at < OFFER_MS);
  for (const o of recent) if (o.nonce >= next) next = o.nonce + 1n;
  recent.push({ nonce: next, at: now });
  offered.set(key, recent);
  if (offered.size > 10_000) offered.delete(offered.keys().next().value!);
  return next;
}
