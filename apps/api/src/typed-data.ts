import type { Address } from 'viem';
import type { Intent, Mandate } from './types.js';

export const intentTypes = {
  Intent: [
    { name: 'signer', type: 'address' },
    { name: 'merchant', type: 'address' },
    { name: 'target', type: 'address' },
    { name: 'dataHash', type: 'bytes32' },
    { name: 'amount', type: 'uint256' },
    { name: 'feeUSDT', type: 'uint256' },
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

export function intentTypedData(intent: Intent, verifyingContract: Address) {
  return {
    domain: { name: 'Settle Router', version: '1', chainId: 1874, verifyingContract },
    types: intentTypes,
    primaryType: 'Intent' as const,
    message: intent,
  };
}

export function mandateTypedData(mandate: Mandate, verifyingContract: Address, version: '1' | '2' = '1') {
  return {
    domain: { name: 'Settle Subscription', version, chainId: 1874, verifyingContract },
    types: mandateTypes,
    primaryType: 'Mandate' as const,
    message: mandate,
  };
}
export function consentTypedData(mandateHash: `0x${string}`, deadline: bigint, verifyingContract: Address) {
  return { domain: { name: 'Settle Subscription', version: '2', chainId: 1874, verifyingContract }, types: { SponsorshipConsent: [{ name: 'mandateHash', type: 'bytes32' }, { name: 'deadline', type: 'uint64' }] }, primaryType: 'SponsorshipConsent' as const, message: { mandateHash, deadline } };
}
export function cancellationTypedData(id: `0x${string}`, deadline: bigint, verifyingContract: Address) {
  return { domain: { name: 'Settle Subscription', version: '2', chainId: 1874, verifyingContract }, types: { Cancel: [{ name: 'id', type: 'bytes32' }, { name: 'deadline', type: 'uint64' }] }, primaryType: 'Cancel' as const, message: { id, deadline } };
}
