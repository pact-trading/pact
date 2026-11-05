import { decodeFunctionData, encodeFunctionData, hashTypedData, isAddress, isHash, type Address, type Hex } from 'viem';
import { x402ExactPermit2ProxyABI, x402UptoPermit2ProxyABI, permit2WitnessTypes, uptoPermit2WitnessTypes } from '@x402/evm';
import { fingerprint } from './sqlite-store.js';
import type { ReservedPayment } from './account-client.js';
import type { SettlementOperation } from './journal.js';
import type { X402Transaction } from './write-ports.js';
import { EXACT, NETWORK, PERMIT2, UPTO, USDT } from './constants.js';
export const exactSettlementAbi = x402ExactPermit2ProxyABI;
export const uptoSettlementAbi = x402UptoPermit2ProxyABI;
export const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export function settlementIdentity(op: SettlementOperation) {
  const match = /^eip155:1874:permit2:(0x[0-9a-fA-F]{40}):(\d{1,78})$/.exec(op.id);
  if (!match || !isAddress(op.payer) || !isAddress(op.merchant) || !same(match[1], op.payer) || BigInt(match[2]) >= 2n ** 256n || !isHash(op.fingerprint) || op.amount <= 0n) throw new Error('invalid_settlement_identity');
  const nonce = BigInt(match[2]).toString();
  return { key: `${NETWORK}:permit2:${op.payer.toLowerCase()}:${nonce}`, nonce };
}
export function validateEnvelope(tx: X402Transaction) {
  if (tx.chainId !== 1874 || tx.value !== 0n || !isAddress(tx.to) || !/^0x(?:[a-fA-F0-9]{2})+$/.test(tx.data) || tx.gas <= 0n || tx.gas > 1_000_000n) throw new Error('invalid_x402_transaction');
}
export function bindSettlement(op: SettlementOperation, tx: X402Transaction, relayer: Address) {
  validateEnvelope(tx);
  const { nonce } = settlementIdentity(op);
  if (same(tx.to, EXACT)) {
    const decoded = decodeFunctionData({ abi: exactSettlementAbi, data: tx.data });
    if (decoded.functionName !== 'settle') throw new Error('unsupported_settlement_function');
    const { args } = decoded;
    const [permit, owner, witness] = args;
    if (!same(permit.permitted.token, USDT) || permit.nonce !== BigInt(nonce) || !same(owner, op.payer) || !same(witness.to, op.merchant) || permit.permitted.amount !== op.amount || !same(encodeFunctionData({ abi: exactSettlementAbi, functionName: 'settle', args }), tx.data)) throw new Error('settlement_call_mismatch');
  } else if (same(tx.to, UPTO)) {
    const decoded = decodeFunctionData({ abi: uptoSettlementAbi, data: tx.data });
    if (decoded.functionName !== 'settle') throw new Error('unsupported_settlement_function');
    const { args } = decoded;
    const [permit, amount, owner, witness] = args;
    if (!same(permit.permitted.token, USDT) || permit.nonce !== BigInt(nonce) || !same(owner, op.payer) || !same(witness.to, op.merchant) || amount !== op.amount || amount > permit.permitted.amount || !same(witness.facilitator, relayer) || !same(encodeFunctionData({ abi: uptoSettlementAbi, functionName: 'settle', args }), tx.data)) throw new Error('settlement_call_mismatch');
  } else throw new Error('unsupported_settlement_target');
}
/** Official Permit2 witness digest, also implemented by X402AgentAccount.permitDigest. */
export function reservationDigest(p: ReservedPayment): Hex {
  const exact = same(p.spender, EXACT);
  if ((!exact && !same(p.spender, UPTO)) || p.amount <= 0n || !isAddress(p.to) || !isAddress(p.facilitator) || (exact && BigInt(p.facilitator) !== 0n) || (!exact && BigInt(p.facilitator) === 0n)) throw new Error('invalid_reservation');
  return hashTypedData({ domain: { name: 'Permit2', chainId: 1874, verifyingContract: PERMIT2 }, primaryType: 'PermitWitnessTransferFrom',
    types: exact ? permit2WitnessTypes : uptoPermit2WitnessTypes, message: { permitted: { token: USDT, amount: p.amount }, spender: p.spender, nonce: p.nonce, deadline: p.deadline, witness: { to: p.to, facilitator: p.facilitator, validAfter: p.validAfter } } });
}

export function reservationFingerprint(payment: ReservedPayment, signature: Hex): Hex {
  return fingerprint({ payment: { ...payment, spender: payment.spender.toLowerCase(), to: payment.to.toLowerCase(), facilitator: payment.facilitator.toLowerCase() }, signature: signature.toLowerCase() });
}
