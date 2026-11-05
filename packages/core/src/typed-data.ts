import { hashTypedData, type Address, type Hex } from 'viem';
import { WHITECHAIN_CHAIN_ID } from './chain.js';

/** Mirrors Router.Intent and its EIP-712 type string exactly. */
export interface Intent {
  signer: Address;
  merchant: Address;
  target: Address;
  dataHash: Hex;
  amount: bigint;
  feeUSDT: bigint;
  nonce: bigint;
  deadline: bigint;
  maxGas: number;
}

/** Mirrors SubscriptionManager.Mandate and its EIP-712 type string exactly. */
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
    domain: { name: 'Settle Router', version: '1', chainId: WHITECHAIN_CHAIN_ID, verifyingContract },
    types: intentTypes,
    primaryType: 'Intent' as const,
    message: intent,
  };
}

export function mandateTypedData(mandate: Mandate, verifyingContract: Address) {
  return {
    domain: { name: 'Settle Subscription', version: '1', chainId: WHITECHAIN_CHAIN_ID, verifyingContract },
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

/** V2 retains the mandate fields but uses a distinct EIP-712 domain. */
export function mandateV2TypedData(mandate: Mandate, verifyingContract: Address) {
  return {
    domain: { name: 'Settle Subscription', version: '2', chainId: WHITECHAIN_CHAIN_ID, verifyingContract },
    types: mandateTypes,
    primaryType: 'Mandate' as const,
    message: mandate,
  };
}

/** Full V2 EIP-712 digest, including its chain and verifying contract. */
export function hashMandateV2(mandate: Mandate, verifyingContract: Address): Hex {
  return hashTypedData(mandateV2TypedData(mandate, verifyingContract));
}

export const sponsorshipConsentV2Types = {
  SponsorshipConsent: [{ name: 'mandateHash', type: 'bytes32' }, { name: 'deadline', type: 'uint64' }],
} as const;

/** Merchant signs this consent; deadline must be current and <= mandate.endTime. */
export function sponsorshipConsentV2TypedData(mandate: Mandate, deadline: bigint, verifyingContract: Address) {
  return {
    domain: { name: 'Settle Subscription', version: '2', chainId: WHITECHAIN_CHAIN_ID, verifyingContract },
    types: sponsorshipConsentV2Types,
    primaryType: 'SponsorshipConsent' as const,
    message: { mandateHash: hashMandateV2(mandate, verifyingContract), deadline },
  };
}

export const cancellationV2Types = {
  Cancel: [{ name: 'id', type: 'bytes32' }, { name: 'deadline', type: 'uint64' }],
} as const;
export const SUBSCRIPTION_V2_CANCEL_MAX_SECONDS = 300;

/** Payer signs the on-chain bytes32 ID, not the API sub_ ID. API enforces a <=300s deadline. */
export function cancellationV2TypedData(id: Hex, deadline: bigint, verifyingContract: Address) {
  return {
    domain: { name: 'Settle Subscription', version: '2', chainId: WHITECHAIN_CHAIN_ID, verifyingContract },
    types: cancellationV2Types,
    primaryType: 'Cancel' as const,
    message: { id, deadline },
  };
}
