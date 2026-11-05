import type { Address } from 'viem';
import type { Db } from './db.js';

/** A database services one subscription deployment. Never reinterpret old rows
 * by changing an environment variable; keep their original servicing runtime. */
export function bindSubscriptions(db: Db, address: Address, version: 1 | 2) {
  db.exec('CREATE TABLE IF NOT EXISTS subscription_binding(id INTEGER PRIMARY KEY CHECK(id=1), address TEXT NOT NULL, version INTEGER NOT NULL)');
  db.transaction(() => {
    const binding = db.prepare('SELECT address,version FROM subscription_binding WHERE id=1').get() as { address: string; version: number } | undefined;
    const hasRows = !!db.prepare('SELECT 1 FROM subscriptions LIMIT 1').get();
    if (hasRows && ((!binding && version !== 1) || (binding && (binding.address !== address.toLowerCase() || binding.version !== version)))) throw new Error('Subscription deployment mismatch: retain the original servicing database or use a fresh database for V2');
    db.prepare('INSERT INTO subscription_binding VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET address=excluded.address,version=excluded.version').run(address.toLowerCase(), version);
  })();
}
