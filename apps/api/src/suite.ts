import type { FeeTerms } from './types.js';

/**
 * The deployed suite's settings, shared by the deploy scripts and the relayer, and mirrored by
 * contracts/script/Deploy.s.sol. Change them in both places together.
 */

/** Starting fee terms (FeeSchedule version 1): checkout and renewals 0.8%, at least 0.15 USDT;
 * invoices 0.5%, at least 0.15 and at most 10 USDT. */
export const INITIAL_TERMS: FeeTerms = {
  checkout: { bps: 80, minFeeMinor: 150_000n, maxFeeMinor: 0n },
  invoice: { bps: 50, minFeeMinor: 150_000n, maxFeeMinor: 10_000_000n },
};
/** FeeSchedule.Terms as the constructor and `publish` take it. */
export const termsTuple = (terms: FeeTerms) => ({
  checkout: { bps: terms.checkout.bps, minFee: terms.checkout.minFeeMinor, maxFee: terms.checkout.maxFeeMinor },
  invoice: { bps: terms.invoice.bps, minFee: terms.invoice.minFeeMinor, maxFee: terms.invoice.maxFeeMinor },
});

/** Router.setLimits: a higher per-payer daily count than the default 10, so one tester can try every flow. */
export const ROUTER_LIMITS = { minAmount: 1_000_000n, maxPayerCallsPerDay: 40, maxGasPerCall: 1_000_000, maxGasPrice: 100_000_000_000n } as const;

/**
 * Every Router allowlist entry, with how the relayer prices it. `fee`: the target takes Pact's fee out
 * of the money it moves (product 0 checkout, 1 invoice). `gas`: the merchant signs, sends money and
 * pays the call's gas in USDT (the Router's `chargesGas`). `free`: Pact absorbs the gas.
 */
export interface AllowEntry {
  contract: 'escrow' | 'subscription' | 'receivables';
  fn: string;
  mustReturnTrue: boolean;
  checksAmount: boolean;
  charge: 'fee' | 'gas' | 'free';
  product?: 0 | 1;
}
export const ALLOWLIST: AllowEntry[] = [
  { contract: 'escrow', fn: 'authorize', mustReturnTrue: false, checksAmount: true, charge: 'free' },
  { contract: 'escrow', fn: 'capture', mustReturnTrue: false, checksAmount: true, charge: 'fee', product: 0 },
  { contract: 'escrow', fn: 'charge', mustReturnTrue: false, checksAmount: true, charge: 'fee', product: 0 },
  { contract: 'escrow', fn: 'chargeInvoice', mustReturnTrue: false, checksAmount: true, charge: 'fee', product: 1 },
  { contract: 'escrow', fn: 'void', mustReturnTrue: false, checksAmount: false, charge: 'free' },
  { contract: 'escrow', fn: 'reclaim', mustReturnTrue: false, checksAmount: false, charge: 'free' },
  { contract: 'escrow', fn: 'refund', mustReturnTrue: false, checksAmount: true, charge: 'gas' },
  { contract: 'subscription', fn: 'subscribe', mustReturnTrue: false, checksAmount: true, charge: 'free' },
  { contract: 'subscription', fn: 'charge', mustReturnTrue: true, checksAmount: true, charge: 'fee', product: 0 },
  { contract: 'subscription', fn: 'cancel', mustReturnTrue: false, checksAmount: false, charge: 'free' },
  { contract: 'subscription', fn: 'replace', mustReturnTrue: false, checksAmount: true, charge: 'free' },
  // A financed invoice's payment carries no fee: Pact took its share when the units sold.
  { contract: 'receivables', fn: 'pay', mustReturnTrue: false, checksAmount: true, charge: 'free' },
  { contract: 'receivables', fn: 'buyBack', mustReturnTrue: false, checksAmount: false, charge: 'gas' },
];
/** Router.setAllowed arguments for an entry: (enabled, mustReturnTrue, chargesGas, checksAmount). */
export const allowFlags = (entry: AllowEntry) => [true, entry.mustReturnTrue, entry.charge === 'gas', entry.checksAmount] as const;
