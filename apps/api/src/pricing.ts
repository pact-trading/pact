import { amountString } from './db.js';
import type { FeeRate, FeeTerms } from './types.js';
import { Refusal } from './types.js';
import { INITIAL_TERMS } from './suite.js';

/** FeeSchedule products: the checkout rate (payments, captures, renewals) and the invoice rate. */
export const CHECKOUT = 0;
export const INVOICE = 1;
export type Product = typeof CHECKOUT | typeof INVOICE;

/** The deployed starting rates, used by the in-memory chain. */
export const DEFAULT_TERMS: FeeTerms = INITIAL_TERMS;

/** The FeeSchedule's `feeFor`, exactly: rounded up, clamped to the floor and cap, never above the amount. */
export function feeFor(terms: FeeTerms, product: Product, amount: bigint): bigint {
  const rate = product === INVOICE ? terms.invoice : terms.checkout;
  let fee = (amount * BigInt(rate.bps) + 9_999n) / 10_000n;
  if (fee < rate.minFeeMinor) fee = rate.minFeeMinor;
  if (rate.maxFeeMinor !== 0n && fee > rate.maxFeeMinor) fee = rate.maxFeeMinor;
  if (fee > amount) throw new Refusal('amount_below_fee', `The amount is below the ${amountString(rate.minFeeMinor)} USDT minimum fee`);
  return fee;
}

/** `wbtWei` of gas in USDT base units at `usdtPerWbt`, rounded up, as the FeeSchedule's `gasFee`. */
export function gasInUsdt(wbtWei: bigint, usdtPerWbt: bigint): bigint {
  return (wbtWei * usdtPerWbt + 10n ** 18n - 1n) / 10n ** 18n;
}

function rateView(rate: FeeRate) {
  return { bps: rate.bps, percent: `${(rate.bps / 100).toFixed(2)}%`, minimumUsdt: amountString(rate.minFeeMinor), capUsdt: rate.maxFeeMinor === 0n ? null : amountString(rate.maxFeeMinor) };
}
/** Fee terms as the dashboard and docs show them. */
export function termsView(terms: FeeTerms) {
  return { checkout: rateView(terms.checkout), invoice: rateView(terms.invoice) };
}
