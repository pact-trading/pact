import type { Db } from './db.js';
import type { ChainAdapter } from './types.js';
import { FundedRenewals } from './funded-renewals.js';
import { KeeperRenewals } from './subscriptions-live.js';

export function renewalService(db: Db, chain: ChainAdapter) {
  return chain.subscriptionVersion === 1 ? new KeeperRenewals(db, chain) : new FundedRenewals(db, chain);
}
