import { hashTypedData, type Address, type Hex } from 'viem';
import { USDT_ADDRESS, WHITECHAIN_CHAIN_ID } from './chain.js';

/**
 * Mirrors Router.Intent and its EIP-712 type string exactly. The intent carries no fee: Pact's fee
 * is set by the terms the merchant signed in the FeeSchedule and taken out of the payment on chain.
 */
export interface Intent {
  signer: Address;
  merchant: Address;
  target: Address;
  dataHash: Hex;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
  maxGas: number;
}

/** Mirrors SubscriptionManagerV2.Mandate and its EIP-712 type string exactly. */
export interface Mandate {
  payer: Address;
  merchant: Address;
  planId: Hex;
  amountCap: bigint;
  periodSeconds: bigint;
  maxPeriods: number;
  endTime: bigint;
  nonce: bigint;
}

export const intentTypes = {
  Intent: [
    { name: 'signer', type: 'address' },
    { name: 'merchant', type: 'address' },
    { name: 'target', type: 'address' },
    { name: 'dataHash', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
    { name: 'maxGas', type: 'uint32' },
  ],
} as const;

export const mandateTypes = {
  Mandate: [
    { name: 'payer', type: 'address' },
    { name: 'merchant', type: 'address' },
    { name: 'planId', type: 'bytes32' },
    { name: 'amountCap', type: 'uint256' },
    { name: 'periodSeconds', type: 'uint64' },
    { name: 'maxPeriods', type: 'uint32' },
    { name: 'endTime', type: 'uint64' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const;

/** Router domain "Settle Router", version 2. */
export function intentTypedData(intent: Intent, verifyingContract: Address) {
  return {
    domain: { name: 'Settle Router', version: '2', chainId: WHITECHAIN_CHAIN_ID, verifyingContract },
    types: intentTypes,
    primaryType: 'Intent' as const,
    message: intent,
  };
}

/** SubscriptionManager domain "Settle Subscription", version 2. Only the payer signs a mandate. */
export function mandateTypedData(mandate: Mandate, verifyingContract: Address) {
  return {
    domain: { name: 'Settle Subscription', version: '2', chainId: WHITECHAIN_CHAIN_ID, verifyingContract },
    types: mandateTypes,
    primaryType: 'Mandate' as const,
    message: mandate,
  };
}

export function hashIntent(intent: Intent, verifyingContract: Address): Hex {
  return hashTypedData(intentTypedData(intent, verifyingContract));
}

export function hashMandate(mandate: Mandate, verifyingContract: Address): Hex {
  return hashTypedData(mandateTypedData(mandate, verifyingContract));
}

export const cancellationTypes = {
  Cancel: [{ name: 'id', type: 'bytes32' }, { name: 'deadline', type: 'uint64' }],
} as const;
/** The API refuses a cancellation whose deadline is more than this far ahead. */
export const SUBSCRIPTION_CANCEL_MAX_SECONDS = 300;

/** The payer signs the on-chain bytes32 subscription ID, not the API sub_ ID. Pact's relayer submits it. */
export function cancellationTypedData(id: Hex, deadline: bigint, verifyingContract: Address) {
  return {
    domain: { name: 'Settle Subscription', version: '2', chainId: WHITECHAIN_CHAIN_ID, verifyingContract },
    types: cancellationTypes,
    primaryType: 'Cancel' as const,
    message: { id, deadline },
  };
}

export const permitTypes = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

/**
 * Whitechain USDT's EIP-2612 permit ("Tether USD", version 1). Payers and merchants approve USDT by
 * signing this; Pact's relayer submits it and pays the gas, so nobody needs WBT.
 */
export function permitTypedData(owner: Address, spender: Address, value: bigint, nonce: bigint, deadline: bigint) {
  return {
    domain: { name: 'Tether USD', version: '1', chainId: WHITECHAIN_CHAIN_ID, verifyingContract: USDT_ADDRESS },
    types: permitTypes,
    primaryType: 'Permit' as const,
    message: { owner, spender, value, nonce, deadline },
  };
}

export const acceptTermsTypes = {
  AcceptTerms: [
    { name: 'merchant', type: 'address' },
    { name: 'version', type: 'uint32' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

/** A merchant's acceptance of one FeeSchedule version ("Pact Fees", version 1). */
export function acceptTermsTypedData(merchant: Address, version: number, nonce: bigint, deadline: bigint, verifyingContract: Address) {
  return {
    domain: { name: 'Pact Fees', version: '1', chainId: WHITECHAIN_CHAIN_ID, verifyingContract },
    types: acceptTermsTypes,
    primaryType: 'AcceptTerms' as const,
    message: { merchant, version, nonce, deadline },
  };
}
