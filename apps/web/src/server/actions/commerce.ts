'use server';

import { revalidatePath } from 'next/cache';
import { toMinor } from '@/lib/format';
import { getData } from '../data';
import { DataError } from '../data/errors';
import type { ManualOrderInput, PaymentLinkInput } from '../data/parts/commerce';
import type { DiscountInput } from '../data/parts/commerce';
import type { CheckoutMetadata } from '@pactagent/core/checkout-fields';
import { attempt } from './result';

const commerce = async () => (await getData()).commerce;
const done = async <T>(work: () => Promise<T>) =>
  attempt(async () => {
    const result = await work();
    revalidatePath('/dashboard', 'layout');
    return result;
  });

export const createDiscount = async (input: DiscountInput) => done(async () => (await commerce()).createDiscount(input));
export const archiveDiscount = async (id: string) => done(async () => (await commerce()).archiveDiscount(id));

// ---------------------------------------------------------- payment links

export const createPaymentLink = async (input: PaymentLinkInput) =>
  done(async () => (await commerce()).createPaymentLink(input));
export const deactivatePaymentLink = async (id: string) =>
  done(async () => (await commerce()).deactivatePaymentLink(id));
export const reactivatePaymentLink = async (id: string) =>
  done(async () => (await commerce()).reactivatePaymentLink(id));

/**
 * Starts the payer's checkout for a link. `amount` is the decimal the payer typed on a link where
 * they choose the amount; it is parsed and bounded here and in the data source, never trusted.
 */
export const startLinkCheckout = async (id: string, amount?: string, discountCode?: string, metadata?: CheckoutMetadata) =>
  attempt(async () => {
    let amountMinor: string | undefined;
    if (amount !== undefined) {
      let minor: bigint;
      try {
        minor = toMinor(amount);
      } catch {
        throw new DataError('invalid_amount', 'Enter an amount like 20 or 12.50.', 400);
      }
      if (minor <= 0n) throw new DataError('invalid_amount', 'Enter an amount above $0.', 400);
      amountMinor = minor.toString();
    }
    return (await commerce()).startLinkCheckout(id, amountMinor, discountCode, metadata);
  });

// ----------------------------------------------------------- manual orders

export const quoteOrder = async (input: ManualOrderInput) =>
  attempt(async () => (await commerce()).quoteOrder(input));
export const createManualOrder = async (input: ManualOrderInput) =>
  done(async () => (await commerce()).createManualOrder(input));
export const startOrderCheckout = async (orderId: string) =>
  attempt(async () => (await commerce()).startOrderCheckout(orderId));

// ------------------------------------------------------------------ plans

export const archivePlan = async (id: string) => done(async () => (await commerce()).archivePlan(id));
export const restorePlan = async (id: string) => done(async () => (await commerce()).restorePlan(id));
