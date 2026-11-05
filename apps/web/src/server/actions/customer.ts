'use server';

import type { CheckoutMetadata } from '@pactagent/core/checkout-fields';
import { revalidatePath } from 'next/cache';
import { getData } from '../data';
import type { ApprovalSignature, CardDetails } from '../data/types';
import { attempt } from './result';

const customer = async () => (await getData()).customer;
const checkout = async () => (await getData()).checkout;
const done = async <T>(work: () => Promise<T>) =>
  attempt(async () => {
    const result = await work();
    revalidatePath('/', 'layout');
    return result;
  });

export const claimTestFunds = async () => done(async () => (await customer()).claimTestFunds());

export const prepareCancel = async (id: string) => attempt(async () => (await customer()).prepareCancel(id));
export const submitCancel = async (token: string, signature: string) =>
  done(async () => (await customer()).submitCancel(token, signature));
export const prepareChangePlan = async (id: string, planId: string) =>
  attempt(async () => (await customer()).prepareChangePlan(id, planId));
export const submitChangePlan = async (token: string, signature: string) =>
  done(async () => (await customer()).submitChangePlan(token, signature));

export const prepareAcknowledge = async (id: string) =>
  attempt(async () => (await customer()).prepareAcknowledge(id));
export const submitAcknowledge = async (token: string, signature: string) =>
  done(async () => (await customer()).submitAcknowledge(token, signature));

export const prepareAgentLimits = async (
  id: string,
  limits: { perCallCapMinor: string; dailyCapMinor: string },
) => attempt(async () => (await customer()).prepareAgentLimits(id, limits));
export const submitAgentLimits = async (token: string, signature: string) =>
  done(async () => (await customer()).submitAgentLimits(token, signature));
export const prepareRevokeAgent = async (id: string) =>
  attempt(async () => (await customer()).prepareRevokeAgent(id));
export const submitRevokeAgent = async (token: string, signature: string) =>
  done(async () => (await customer()).submitRevokeAgent(token, signature));
export const runAgent = async (id: string, count: number) =>
  done(async () => (await customer()).runAgent(id, count));

export const updateCustomerNotifications = async (input: { events: string[]; telegramEvents?: string[] }) =>
  done(async () => (await customer()).updateNotificationPreferences(input));
export const connectCustomerTelegram = async () => attempt(async () => (await customer()).connectTelegram());
export const disconnectCustomerTelegram = async () => done(async () => (await customer()).disconnectTelegram());
export const startProductCheckout = async (productId: string, discountCode?: string, metadata?: CheckoutMetadata) =>
  attempt(async () => (await checkout()).startProductCheckout(productId, discountCode, metadata));
export const startInvoiceCheckout = async (invoiceId: string, amountMinor: string) =>
  attempt(async () => (await checkout()).startInvoiceCheckout(invoiceId, amountMinor));
export const checkoutStatus = async (sessionId: string) =>
  attempt(async () => (await checkout()).session(sessionId));
export const preparePayment = async (sessionId: string) =>
  attempt(async () => (await checkout()).preparePayment(sessionId));
export const submitApproval = async (token: string, approval: ApprovalSignature) =>
  attempt(async () => {
    const source = await checkout();
    if (!source.submitApproval) throw new Error('Approvals are only needed with live data');
    return source.submitApproval(token, approval);
  });
export const submitPayment = async (token: string, signature: string) =>
  done(async () => (await checkout()).submitPayment(token, signature));
/** Demo sandbox only: the data source validates the card and decides the outcome. */
export const payByCard = async (sessionId: string, card: CardDetails) =>
  done(async () => (await checkout()).payByCard(sessionId, card));
/** Demo sandbox only: the payer says a bank or own-wallet transfer was sent. */
export const confirmTransfer = async (sessionId: string, method: 'bank' | 'wallet') =>
  done(async () => (await checkout()).confirmTransfer(sessionId, method));
export const prepareSubscribe = async (planId: string) =>
  attempt(async () => (await checkout()).prepareSubscribe(planId));
export const submitSubscribe = async (token: string, signature: string) =>
  done(async () => (await checkout()).submitSubscribe(token, signature));

export const agentMerchants = async () =>
  attempt(async () => {
    const source = await customer();
    return source.agentMerchants ? source.agentMerchants() : [];
  });
export const prepareCreateAgent = async (input: {
  name: string;
  description?: string;
  perCallCapMinor: string;
  dailyCapMinor: string;
  merchantIds: string[];
}) =>
  attempt(async () => {
    const source = await customer();
    if (!source.prepareCreateAgent) throw new Error('Creating agents needs live data');
    return source.prepareCreateAgent(input);
  });
/** The signature argument is a JSON array: session limits, then the Permit2 approval. */
export const submitCreateAgent = async (token: string, signatures: string) =>
  done(async () => {
    const source = await customer();
    if (!source.submitCreateAgent) throw new Error('Creating agents needs live data');
    return source.submitCreateAgent(token, JSON.parse(signatures) as string[]);
  });
export const fundAgent = async (id: string) =>
  done(async () => {
    const source = await customer();
    if (!source.fundAgent) throw new Error('Test funds exist only on a local fork');
    return source.fundAgent(id);
  });

export const continueSigned = async (token: string, signature: string) =>
  attempt(async () => {
    const source = await customer();
    if (!source.continueSigned) throw new Error('Multi-step signing needs live data');
    return source.continueSigned(token, signature);
  });
