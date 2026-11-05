import type { Db } from '../../src/db.js';
import { FakeChain } from '../../src/chain.js';
import { runKeeper as schedule } from '../../src/keeper.js';
import { reserveRenewal } from '../../src/write-reservations.js';
import type { Hex } from 'viem';

// Historical direct-renewal receipts/retry fixtures remain valid. Explicitly
// inject this synthetic driver; the runtime keeper has NO direct-send fallback.
export function runLegacyTestKeeper(db: Db, chain: FakeChain, at = new Date()) {
  return schedule(db, chain, at, { chain, async renew(subscriptionId: string) {
    const sub = db.prepare('SELECT s.chain_id,p.amount_minor FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.id=?').get(subscriptionId) as { chain_id: Hex; amount_minor: string };
    const operation = reserveRenewal(db, chain, subscriptionId);
    await chain.renew(sub.chain_id, BigInt(sub.amount_minor), operation);
    return { state: 'pending', reason: 'legacy_synthetic_fixture' };
  } });
}
