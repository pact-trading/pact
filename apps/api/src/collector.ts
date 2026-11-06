import { encodeAbiParameters, hashDomain, keccak256, parseSignature, recoverTypedDataAddress, toHex, type Address, type Hex } from 'viem';
import { USDT } from './token.js';

/**
 * One-signature checkout. The payer signs a single USDT EIP-3009 `ReceiveWithAuthorization` to the escrow;
 * its nonce is derived from the payment terms by the escrow (`authorizationNonce`), so that one signature
 * fixes the payment id, merchant, amount, refund window and fee product. Pact's relayer submits
 * `PaymentEscrow.chargeWithAuthorization` directly: no permit transaction, no Router intent, no allowance.
 * `receiveWithAuthorization` (not `transfer…`) means only the escrow can use the signature.
 */
export interface ChargeTerms { id: Hex; payer: Address; merchant: Address; amount: bigint; refundWindow: number; product: 0 | 1 }
export interface Authorization { terms: ChargeTerms; nonce: Hex; validAfter: bigint; validBefore: bigint }
/** Whitechain Sepolia USDT's EIP-712 domain (verified against its DOMAIN_SEPARATOR at startup). */
export const USDT_DOMAIN = { name: 'Tether USD', version: '1', chainId: 1874, verifyingContract: USDT } as const;
const RECEIVE_TYPES = { ReceiveWithAuthorization: [
  { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
  { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
] } as const;
/** How long a payer has to sign and submit a prepared charge. */
export const AUTHORIZATION_SECONDS = 300n;

export function receiveAuthorizationTypedData(a: Authorization, escrow: Address) {
  return { domain: USDT_DOMAIN, types: RECEIVE_TYPES, primaryType: 'ReceiveWithAuthorization' as const,
    message: { from: a.terms.payer, to: escrow, value: a.terms.amount, validAfter: a.validAfter, validBefore: a.validBefore, nonce: a.nonce } };
}
export async function authorizationSigner(a: Authorization, escrow: Address, signature: Hex) {
  return recoverTypedDataAddress({ ...receiveAuthorizationTypedData(a, escrow), signature });
}
/** `chargeWithAuthorization` takes v, r, s. */
export function splitSignature(signature: Hex) {
  const { r, s, v, yParity } = parseSignature(signature);
  return { v: Number(v ?? 27n + BigInt(yParity!)), r, s };
}
/** The escrow's terms tuple, as `chargeWithAuthorization` takes it. */
export const termsTuple = (t: ChargeTerms) => ({ id: t.id, payer: t.payer, merchant: t.merchant, amount: t.amount, refundWindow: t.refundWindow, product: t.product });
/** `PaymentEscrow.TERMS_TYPEHASH`. */
export const TERMS_TYPEHASH = keccak256(toHex('Terms(bytes32 id,address payer,address merchant,uint256 amount,uint32 refundWindow,uint8 product)'));
/**
 * `PaymentEscrow.authorizationNonce(t)`, computed locally (it is pure in the terms, the escrow and the chain):
 * keccak256(abi.encode(TERMS_TYPEHASH, id, payer, merchant, amount, refundWindow, product, escrow, chainid)).
 * The live adapter checks it against the escrow once before relying on it.
 */
export function authorizationNonceOf(t: ChargeTerms, escrow: Address, chainId = 1874n): Hex {
  return keccak256(encodeAbiParameters([{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint32' }, { type: 'uint8' }, { type: 'address' }, { type: 'uint256' }],
    [TERMS_TYPEHASH, t.id, t.payer, t.merchant, t.amount, t.refundWindow, t.product, escrow, chainId]));
}
export const offlineAuthorizationNonce = authorizationNonceOf;
/** The domain separator the typed data above produces, to compare with the token's `DOMAIN_SEPARATOR()`. */
export const usdtDomainSeparator = () => hashDomain({ domain: { ...USDT_DOMAIN, chainId: BigInt(USDT_DOMAIN.chainId) }, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] } });
