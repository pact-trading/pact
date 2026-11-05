'use server';

import type { CheckoutField } from '@pactagent/core/checkout-fields';
import { revalidatePath } from 'next/cache';
import type { InvoiceRequest, MerchantSettingsUpdate, SubscriptionPlanRequest } from '@pactagent/core/api-types';
import type { Product } from '@pactagent/core/commerce-types';
import type { ApiKey, GasPolicy } from '@pactagent/core/platform-types';
import { getData } from '../data';
import { merchantApi, SessionError } from '../api-client';
import { DataError } from '../data/errors';
import type { CancelEffective, MerchantPreferences } from '../data/types';
import { attempt } from './result';

const merchant = async () => (await getData()).merchant;
const refresh = () => revalidatePath('/dashboard', 'layout');
const done = async <T>(work: () => Promise<T>) =>
  attempt(async () => {
    const result = await work();
    refresh();
    return result;
  });

export const updateMerchantNotifications = async (input: { email: string | null; events: string[]; telegramEvents?: string[] }) =>
  done(async () => (await merchant()).updateNotificationPreferences(input));
export const connectMerchantTelegram = async () => attempt(async () => (await merchant()).connectTelegram());
export const disconnectMerchantTelegram = async () => done(async () => (await merchant()).disconnectTelegram());
export const updateSettings = async (update: MerchantSettingsUpdate) =>
  done(async () => (await merchant()).updateSettings(update));

export const createProduct = async (input: {
  name: string;
  description: string;
  priceMinor: string;
  status: Product['status'];
  checkoutFields?: CheckoutField[];
}) => done(async () => (await merchant()).createProduct(input));
export const updateProduct = async (
  id: string,
  input: Partial<{ name: string; description: string; priceMinor: string; status: Product['status']; checkoutFields: CheckoutField[] }>,
) => done(async () => (await merchant()).updateProduct(id, input));

export const prepareRefund = async (orderId: string, amountMinor: string, reason: string) =>
  attempt(async () => (await merchant()).prepareRefund(orderId, amountMinor, reason));
export const submitRefund = async (token: string, signature: string) =>
  done(async () => (await merchant()).submitRefund(token, signature));

export const createInvoice = async (input: InvoiceRequest & { customerName?: string }) =>
  done(async () => (await merchant()).createInvoice(input));
export const sendInvoice = async (id: string) => done(async () => (await merchant()).sendInvoice(id));
export const remindInvoice = async (id: string) => done(async () => (await merchant()).remindInvoice(id));

export const createPlan = async (input: SubscriptionPlanRequest & { description?: string }) =>
  done(async () => (await merchant()).createPlan(input));
export const runRenewal = async (id: string) => done(async () => (await merchant()).runRenewal(id));

export const updateGasPolicy = async (update: Partial<GasPolicy>) =>
  done(async () => (await merchant()).updateGasPolicy(update));
export const claimFaucet = async () => done(async () => (await merchant()).claimFaucet());
export const runDrainSimulation = async () => done(async () => (await merchant()).runDrainSimulation());

export const createApiKey = async (input: { name: string; kind: ApiKey['kind'] }) =>
  done(async () => (await merchant()).createApiKey(input));
export const revokeApiKey = async (id: string) => done(async () => (await merchant()).revokeApiKey(id));

export const configureWebhook = async (url: string) =>
  done(async () => (await merchant()).configureWebhook(url));
export const replayWebhook = async (eventId: string) =>
  done(async () => (await merchant()).replayWebhook(eventId));
export const sendTestWebhook = async () => done(async () => (await merchant()).sendTestWebhook());

// Merchant polish: preferences, gas deposits, written reminders and subscription controls.
export const updatePreferences = async (update: Partial<MerchantPreferences>) =>
  done(async () => (await merchant()).updatePreferences(update));
export const depositGas = async (amountWei: string) =>
  done(async () => (await merchant()).depositGas(amountWei));
export const sendReminder = async (id: string, input: { message: string; sendAt: string | null }) =>
  done(async () => (await merchant()).sendReminder(id, input));
export const cancelReminder = async (id: string, reminderId: string) =>
  done(async () => (await merchant()).cancelReminder(id, reminderId));
export const simulateRenewalFailure = async (id: string) =>
  done(async () => (await merchant()).simulateRenewalFailure(id));
export const prepareCancelSubscription = async (id: string, effective: CancelEffective) =>
  attempt(async () => (await merchant()).prepareCancelSubscription(id, effective));
export const submitCancelSubscription = async (token: string, signature: string) =>
  done(async () => (await merchant()).submitCancelSubscription(token, signature));

export const cancelMerchantSubscription = async (id: string) =>
  done(async () => {
    try {
      return await merchantApi(`/v1/subscriptions/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ by: 'merchant' }),
      });
    } catch (error) {
      if (error instanceof SessionError)
        throw new DataError(
          error.code,
          error.code === 'subscription_pending'
            ? 'A charge is already pending. Wait for it to settle, then cancel again.'
            : error.code.replaceAll('_', ' '),
          error.status,
        );
      throw error;
    }
  });
