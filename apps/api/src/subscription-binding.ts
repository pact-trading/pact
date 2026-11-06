import type { Address } from 'viem';
import type { Db } from './db.js';

/** A database services one subscription deployment. Never reinterpret old rows
 * by pointing the API at another contract; keep their original servicing runtime. */
export function bindSubscriptions(db: Db, address: Address) {
  // A database from before fee-from-payment bound a (contract, version) pair; with no subscriptions it can be rebound.
  if ((db.pragma('table_info(subscription_binding)') as Array<{ name: string }>).some(c => c.name === 'version')) {
    if (db.prepare('SELECT 1 FROM subscriptions LIMIT 1').get()) throw new Error('Subscription deployment mismatch: this database holds subscriptions from an earlier SubscriptionManager. Start the new deployment with a fresh database.');
    db.exec('DROP TABLE subscription_binding');
  }
  db.exec('CREATE TABLE IF NOT EXISTS subscription_binding(id INTEGER PRIMARY KEY CHECK(id=1), address TEXT NOT NULL)');
  db.transaction(() => {
    const binding = db.prepare('SELECT address FROM subscription_binding WHERE id=1').get() as { address: string } | undefined;
    const hasRows = !!db.prepare('SELECT 1 FROM subscriptions LIMIT 1').get();
    if (hasRows && binding && binding.address !== address.toLowerCase()) throw new Error('Subscription deployment mismatch: rows in this database belong to another SubscriptionManager. Start the new deployment with a fresh database.');
    db.prepare('INSERT INTO subscription_binding VALUES (1,?) ON CONFLICT(id) DO UPDATE SET address=excluded.address').run(address.toLowerCase());
  })();
}
