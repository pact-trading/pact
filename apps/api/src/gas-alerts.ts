import type { Address } from 'viem';
import type { Db } from './db.js';
import { gasPolicyPreferences, runwayDays } from './gas-tank.js';
import { queueMerchantAlert } from './notifications.js';
import type { ChainAdapter } from './types.js';

/** Emails a merchant, at most once a day, when the tank has less runway than they asked to be warned about. */
export async function checkGasRunways(db: Db, chain: Pick<ChainAdapter, 'gasTank'>, at = new Date()) {
  const since = new Date(at.getTime() - 7 * 86_400_000).toISOString();
  const merchants = db.prepare('SELECT DISTINCT m.id,m.address FROM merchants m JOIN gas_ledger g ON g.merchant_id=m.id WHERE g.created_at>=?').all(since) as Array<{ id: string; address: Address }>;
  for (const merchant of merchants) {
    try {
      const { balanceWei } = await chain.gasTank(merchant.address);
      const days = runwayDays(db, merchant.id, balanceWei, at), limit = gasPolicyPreferences(db, merchant.id).lowRunwayAlertDays;
      if (days === null || days >= limit) continue;
      queueMerchantAlert(db, `gas_runway:${merchant.id}:${at.toISOString().slice(0, 10)}`, merchant.id, 'gas_tank.low_runway', {
        subject: `Your gas tank has about ${days} day${days === 1 ? '' : 's'} left`,
        lines: [`At your recent spend, your gas tank will run out in about ${days} day${days === 1 ? '' : 's'}.`, 'Sponsored payments and renewals stop when it is empty. Add WBT under Gas tank in your dashboard.'],
      });
    } catch (error) {
      console.error(`Gas runway check failed for ${merchant.id}:`, error instanceof Error ? error.message : 'unknown error');
    }
  }
}
