'use server';

import { revalidatePath } from 'next/cache';
import { getData } from '../data';
import type { InvestorApplication } from '../data/parts/financing';
import { attempt } from './result';

const financing = async () => (await getData()).financing;
const done = async <T>(work: () => Promise<T>) =>
  attempt(async () => {
    const result = await work();
    revalidatePath('/dashboard', 'layout');
    revalidatePath('/investor', 'layout');
    revalidatePath('/compliance', 'layout');
    return result;
  });
/** A prepare can record a refusal (a purchase or transfer the contract would revert), so pages refresh. */
const prepared = async <T>(work: () => Promise<T>) =>
  attempt(async () => {
    try {
      return await work();
    } finally {
      revalidatePath('/investor', 'layout');
      revalidatePath('/compliance', 'layout');
    }
  });

export const prepareRequestFinancing = async (invoiceId: string) =>
  attempt(async () => (await financing()).prepareRequest(invoiceId));
export const submitRequestFinancing = async (token: string, signature: string) =>
  done(async () => (await financing()).submitRequest(token, signature));
export const prepareCancelFinancing = async (invoiceId: string) =>
  attempt(async () => (await financing()).prepareCancel(invoiceId));
export const submitCancelFinancing = async (token: string, signature: string) =>
  done(async () => (await financing()).submitCancel(token, signature));
export const prepareBuyBack = async (invoiceId: string) =>
  attempt(async () => (await financing()).prepareBuyBack(invoiceId));
export const submitBuyBack = async (token: string, signature: string) =>
  done(async () => (await financing()).submitBuyBack(token, signature));

export const preparePurchase = async (invoiceId: string, faceMinor: string) =>
  prepared(async () => (await financing()).preparePurchase(invoiceId, faceMinor));
export const submitPurchase = async (token: string, signature: string) =>
  done(async () => (await financing()).submitPurchase(token, signature));
export const prepareTransfer = async (invoiceId: string, toInvestorId: string, faceMinor: string) =>
  prepared(async () => (await financing()).prepareTransfer(invoiceId, toInvestorId, faceMinor));
export const submitTransfer = async (token: string, signature: string) =>
  done(async () => (await financing()).submitTransfer(token, signature));
export const applyAsInvestor = async (application: InvestorApplication) =>
  done(async () => (await financing()).apply(application));

export const prepareInvestorApproval = async (investorId: string, decision: 'approve' | 'revoke') =>
  attempt(async () => (await financing()).prepareApproval(investorId, decision));
export const submitInvestorApproval = async (token: string, signature: string) =>
  done(async () => (await financing()).submitApproval(token, signature));

export const prepareCancelOrders = async (role: 'investor' | 'compliance') =>
  attempt(async () => (await financing()).prepareCancelOrders(role));
export const submitCancelOrders = async (token: string, signature: string) =>
  done(async () => (await financing()).submitCancelOrders(token, signature));

export const simulateCustomerPayment = async (invoiceId: string) =>
  done(async () => (await financing()).simulateCustomerPayment(invoiceId));

export const simulateAgentRequest = async (scenarioId: string) =>
  done(async () => (await financing()).simulateAgentRequest(scenarioId));
