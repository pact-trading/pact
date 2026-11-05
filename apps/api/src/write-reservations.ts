import type { ChainAdapter, IntentRequest } from './types.js';
import { Refusal } from './types.js';
import { id, now, type Db } from './db.js';
import type { WriteOperation } from './account-writer.js';

// Call synchronously before the route/keeper's first submission await. The
// domain reservation and journal identity commit in the same SQLite transaction.
export function reserveIntent(db: Db, chain: ChainAdapter, merchantId: string, request: IntentRequest, kind: 'intent' | 'refund' | 'cancel' | 'replace', objectId: string, links: WriteOperation['links'] = {}, additional?: (intentId: string) => void) {
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
  if (sub.pending_tx_hash || db.prepare("SELECT 1 FROM relayer_operations WHERE object_id=? AND kind IN ('renew','subscribe','cancel','replace','intent') AND phase IN ('preparing','signed','broadcasting','submitted','uncertain')").get(subscriptionId)) throw new Refusal('subscription_pending');
}
export function reserveRenewal(db: Db, chain: ChainAdapter, subscriptionId: string) {
  const operation: WriteOperation = { id: id('renew'), kind: 'renew', objectId: subscriptionId, links: { subscriptionId } };
  chain.writer.reserve(operation, () => {
    assertSubscriptionAvailable(db, subscriptionId);
    operation.links!.previousSubscriptionStatus = (db.prepare('SELECT status FROM subscriptions WHERE id=?').get(subscriptionId) as { status: string }).status;
  });
  return operation;
}
