import type { Address } from 'viem';
import { now, type Db } from './db.js';
import { Refusal } from './types.js';

export interface SponsorshipLimits {
  /** WBT a merchant may have Pact absorb each UTC day before it earns any fees. */
  starterWeiPerDay: bigint;
  /** Share of the merchant's last 30 days of Pact fees, in WBT, added to that allowance. */
  revenueShareBps: number;
}
export const DEFAULT_SPONSORSHIP: SponsorshipLimits = { starterWeiPerDay: 50_000_000_000_000_000n, revenueShareBps: 2_500 };

export function sponsorshipLimits(env: NodeJS.ProcessEnv = process.env): SponsorshipLimits {
  const starter = BigInt(env.SPONSORSHIP_STARTER_WEI_PER_DAY ?? DEFAULT_SPONSORSHIP.starterWeiPerDay.toString());
  const share = Number(env.SPONSORSHIP_REVENUE_SHARE_BPS ?? DEFAULT_SPONSORSHIP.revenueShareBps);
  if (starter < 0n || !Number.isInteger(share) || share < 0 || share > 10_000) throw new Error('Invalid sponsorship limits');
  return { starterWeiPerDay: starter, revenueShareBps: share };
}

const DAY = 86_400_000;
const day = (at: Date) => at.toISOString().slice(0, 10);

/**
 * The gas Pact absorbs on calls that move no money to the merchant: subscribing, cancelling,
 * authorizing and voiding, permits, fee-terms acceptance and signed financing orders. Each merchant
 * gets a small daily allowance plus a share of the fees it paid Pact over the last 30 days, so a
 * merchant (or someone acting against it) cannot make Pact pay unbounded gas.
 */
export class SponsorshipBudget {
  constructor(private db: Db, private limits: SponsorshipLimits = DEFAULT_SPONSORSHIP) {}
  merchantFor(address: Address): string | null {
    return (this.db.prepare('SELECT id FROM merchants WHERE lower(address)=lower(?) ORDER BY created_at LIMIT 1').get(address) as { id: string } | undefined)?.id ?? null;
  }
  /** Today's allowance in wei, and what was already used. */
  usage(merchantId: string, usdtPerWbt: bigint, at = new Date()) {
    const since = new Date(at.getTime() - 30 * DAY).toISOString();
    let feesMinor = 0n;
    for (const row of this.db.prepare("SELECT fee_minor FROM accounting_entries WHERE merchant_id=? AND kind IN ('Payment','Subscription') AND occurred_at>=?").iterate(merchantId, since) as Iterable<{ fee_minor: string }>) feesMinor += BigInt(row.fee_minor);
    const earnedWei = usdtPerWbt > 0n ? (feesMinor * 10n ** 18n / usdtPerWbt) * BigInt(this.limits.revenueShareBps) / 10_000n : 0n;
    let usedWei = 0n;
    for (const row of this.db.prepare('SELECT cost_wei FROM sponsored_spend WHERE merchant_id=? AND day=?').iterate(merchantId, day(at)) as Iterable<{ cost_wei: string }>) usedWei += BigInt(row.cost_wei);
    return { allowanceWei: this.limits.starterWeiPerDay + earnedWei, usedWei };
  }
  /** Refuses when `costWei` would take the merchant past today's allowance. */
  assert(merchantId: string, costWei: bigint, usdtPerWbt: bigint, at = new Date()) {
    const { allowanceWei, usedWei } = this.usage(merchantId, usdtPerWbt, at);
    if (usedWei + costWei > allowanceWei) throw new Refusal('sponsorship_budget', 'Pact has covered as much free activity for this business as it can today. Try again tomorrow.');
  }
  record(operationId: string, merchantId: string, costWei: bigint, kind: string, at = new Date()) {
    this.db.prepare('INSERT OR IGNORE INTO sponsored_spend VALUES (?,?,?,?,?,?)').run(operationId, merchantId, day(at), costWei.toString(), kind, now());
  }
}
