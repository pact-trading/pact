import type { Address, Hex } from 'viem';
import { USDT } from './token.js';
import type { Intent, Mandate } from './types.js';

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

/** Router v2: the intent carries no fee. Fees are set by the merchant's accepted FeeSchedule terms. */
export function intentTypedData(intent: Intent, verifyingContract: Address) {
  return {
    domain: { name: 'Settle Router', version: '2', chainId: 1874, verifyingContract },
    types: intentTypes,
    primaryType: 'Intent' as const,
    message: intent,
  };
}

export function mandateTypedData(mandate: Mandate, verifyingContract: Address) {
  return {
    domain: { name: 'Settle Subscription', version: '2', chainId: 1874, verifyingContract },
    types: mandateTypes,
    primaryType: 'Mandate' as const,
    message: mandate,
  };
}

export function cancellationTypedData(id: Hex, deadline: bigint, verifyingContract: Address) {
  return { domain: { name: 'Settle Subscription', version: '2', chainId: 1874, verifyingContract }, types: { Cancel: [{ name: 'id', type: 'bytes32' }, { name: 'deadline', type: 'uint64' }] }, primaryType: 'Cancel' as const, message: { id, deadline } };
}

/** Whitechain USDT's EIP-2612 permit ("Tether USD", version 1): how wallets approve without gas. */
export function permitTypedData(owner: Address, spender: Address, value: bigint, nonce: bigint, deadline: bigint) {
  return {
    domain: { name: 'Tether USD', version: '1', chainId: 1874, verifyingContract: USDT },
    types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'Permit' as const,
    message: { owner, spender, value, nonce, deadline },
  };
}

/** A merchant's acceptance of one FeeSchedule version ("Pact Fees", version 1). */
export function acceptTermsTypedData(merchant: Address, version: number, nonce: bigint, deadline: bigint, verifyingContract: Address) {
  return {
    domain: { name: 'Pact Fees', version: '1', chainId: 1874, verifyingContract },
    types: { AcceptTerms: [{ name: 'merchant', type: 'address' }, { name: 'version', type: 'uint32' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    primaryType: 'AcceptTerms' as const,
    message: { merchant, version, nonce, deadline },
  };
}
