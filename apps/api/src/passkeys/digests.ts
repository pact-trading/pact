import { encodePacked, hashTypedData, keccak256, type Address, type Hex } from 'viem';
import type { ChargeTerms } from '../collector.js';

/**
 * Permit2 `PermitWitnessTransferFrom` with the escrow's `Terms` as witness: what `chargeWithPermit2`
 * verifies (spender = the escrow, which calls Permit2). Permit2's domain has no version. The witness type
 * string (Terms then TokenPermissions, alphabetical) matches `PaymentEscrow.PERMIT2_WITNESS_TYPE`.
 */
export function permit2WitnessTypedData(terms: ChargeTerms, permit: { token: Address; amount: bigint; nonce: bigint; deadline: bigint }, escrow: Address, permit2: Address) {
  return {
    domain: { name: 'Permit2', chainId: 1874, verifyingContract: permit2 },
    types: {
      PermitWitnessTransferFrom: [
        { name: 'permitted', type: 'TokenPermissions' }, { name: 'spender', type: 'address' }, { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' }, { name: 'witness', type: 'Terms' },
      ],
      TokenPermissions: [{ name: 'token', type: 'address' }, { name: 'amount', type: 'uint256' }],
      Terms: [
        { name: 'id', type: 'bytes32' }, { name: 'payer', type: 'address' }, { name: 'merchant', type: 'address' },
        { name: 'amount', type: 'uint256' }, { name: 'refundWindow', type: 'uint32' }, { name: 'product', type: 'uint8' },
      ],
    },
    primaryType: 'PermitWitnessTransferFrom' as const,
    message: { permitted: { token: permit.token, amount: permit.amount }, spender: escrow, nonce: permit.nonce, deadline: permit.deadline, witness: terms },
  };
}
/** The Permit2 digest a passkey account approves (via ERC-1271) for this charge. */
export const permit2Digest = (...args: Parameters<typeof permit2WitnessTypedData>) => hashTypedData(permit2WitnessTypedData(...args));

/**
 * `PasskeyAccount.replaySafeHash(hash)`: EIP-712 `PasskeyMessage(bytes32 hash)` in the account's own domain
 * ("Pact Passkey Account", "1", chain, account). The passkey signs this, so its signature is valid for this
 * account only. Computed locally: a counterfactual account has no code to ask yet.
 */
export function replaySafeHash(account: Address, hash: Hex): Hex {
  return hashTypedData({ domain: { name: 'Pact Passkey Account', version: '1', chainId: 1874, verifyingContract: account }, types: { PasskeyMessage: [{ name: 'hash', type: 'bytes32' }] }, primaryType: 'PasskeyMessage', message: { hash } });
}
/** One Permit2 nonce per payment and account: a second signature for the same payment cannot be a second charge. */
export const permit2Nonce = (paymentId: Hex, account: Address) => BigInt(keccak256(encodePacked(['string', 'bytes32', 'address'], ['pact-passkey-charge', paymentId, account])));
