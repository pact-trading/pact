/**
 * The invoice financing rules fixed in the receivables contract at deployment. The pricing rule
 * (discount per day plus a late-history premium) is the API's; the contract only caps the discount.
 * Every deploy script uses these values, so the local fork and the testnet behave the same.
 */
export const FINANCING_TERMS = {
  /** Pact's fee on face value sold, taken from the price. */
  feeBps: 50,
  /** Held back from the price until the customer pays. */
  reserveBps: 1_000,
  /** Paid to the holders from the reserve when the customer pays after maturity. */
  lateFeeBps: 100,
  /** The largest discount a listing may carry. */
  maxDiscountBps: 2_000,
  gracePeriodSeconds: 7 * 86_400,
  /** Transfers and purchases stop this long before maturity. */
  recordPeriodSeconds: 86_400,
  /** The smallest share an investor can buy or send, unless it is all that is left (1 USDT). */
  minShareMinor: 1_000_000n,
  /** Bounds the gas of a customer payment, which pays every holder in the same transaction. */
  maxHolders: 8,
} as const;

/** The API's pricing rule: a discount per whole day to maturity, plus a premium for late payers. */
export const FINANCING_PRICING = { dayRateBps: 10, latePremiumBps: 100 } as const;

/** How long an investor approval lasts. */
export const APPROVAL_DAYS = 365;

/** Gas the API budgets for a sponsored customer payment that pays `holders` holders. */
export const paymentGas = (holders: number) => Math.min(900_000, 200_000 + 75_000 * Math.max(1, holders));

/**
 * Constructor arguments, in the contract's Config order. `predecessors` are earlier receivables
 * deployments whose pledged invoices and acknowledgements the new one refuses to list again.
 */
export function receivablesConfig(addresses: { usdt: `0x${string}`; router: `0x${string}`; registry: `0x${string}`; feeVault: `0x${string}`; predecessors?: `0x${string}`[] }) {
  const t = FINANCING_TERMS;
  return {
    usdt: addresses.usdt, router: addresses.router, registry: addresses.registry, feeVault: addresses.feeVault,
    feeBps: t.feeBps, reserveBps: t.reserveBps, lateFeeBps: t.lateFeeBps, maxDiscountBps: t.maxDiscountBps,
    gracePeriod: t.gracePeriodSeconds, recordPeriod: t.recordPeriodSeconds, minShare: t.minShareMinor, maxHolders: t.maxHolders,
    predecessors: addresses.predecessors ?? [],
  };
}
