import { decodeEventLog, decodeFunctionData, encodeFunctionData, isAddress, keccak256, parseAbi, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import type { Intent, IntentRequest } from '../types.js';
import { intentTypedData } from '../typed-data.js';
import { EXACT, UPTO, USDT } from './constants.js';
import { exactSettlementAbi, reservationDigest, same, uptoSettlementAbi } from './call-binding.js';
import type { X402Receipt } from './write-ports.js';

// Handwritten interface of our own contract, checked against the actual Foundry artifact in tests.
export const fundedGatewayAbi = parseAbi([
  'function settleExact(((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) p,address payer,(address to,uint256 validAfter) w,bytes sig) returns (bool)',
  'function settleUpto(((address token,uint256 amount) permitted,uint256 nonce,uint256 deadline) p,uint256 actual,address payer,(address to,address facilitator,uint256 validAfter) w,bytes sig) returns (bool)',
  'function sponsorshipQuote(bytes data) view returns (address merchant,uint256 amount)',
  'event PaymentSettled(bytes32 indexed permitDigest,address indexed payer,address indexed merchant,address proxy,uint256 nonce,uint256 ceiling,uint256 amount)',
]);
export interface GatewayPayment {
  readonly gateway: Address; readonly data: Hex; readonly proxy: Address; readonly proxyData: Hex;
  readonly payer: Address; readonly merchant: Address; readonly nonce: bigint; readonly ceiling: bigint;
  readonly amount: bigint; readonly deadline: bigint; readonly permitDigest: Hex;
}
/** Explicit transformation BEFORE merchant authorization, fingerprinting, budgets and signing.
 * Not a prepare hook. An old EOA-facilitator upto permit is rejected, never rewritten/re-signed. */
export function gatewayPayment(proxy: Address, proxyData: Hex, gateway: Address): GatewayPayment {
  if (!isAddress(gateway) || BigInt(gateway) === 0n) throw new Error('invalid_gateway');
  const exact = same(proxy, EXACT);
  if (!exact && !same(proxy, UPTO)) throw new Error('unsupported_proxy');
  const decoded = decodeFunctionData({ abi: exact ? exactSettlementAbi : uptoSettlementAbi, data: proxyData });
  if (decoded.functionName !== 'settle') throw new Error('unsupported_proxy_function');
  // Decode each ABI independently to retain typed canonical tuples.
  if (exact) {
    const { args, functionName } = decodeFunctionData({ abi: exactSettlementAbi, data: proxyData });
    if (functionName !== 'settle' || !same(encodeFunctionData({ abi: exactSettlementAbi, functionName, args }), proxyData)) throw new Error('noncanonical_proxy_call');
    const [p, payer, w, sig] = args;
    validate(p.permitted.token, p.permitted.amount, p.permitted.amount, payer, w.to, sig);
    const data = encodeFunctionData({ abi: fundedGatewayAbi, functionName: 'settleExact', args: [p, payer, w, sig] });
    return Object.freeze({ gateway, data, proxy: EXACT, proxyData, payer, merchant: w.to, nonce: p.nonce, ceiling: p.permitted.amount, amount: p.permitted.amount, deadline: p.deadline,
      permitDigest: reservationDigest({ spender: EXACT, amount: p.permitted.amount, nonce: p.nonce, deadline: p.deadline, to: w.to, facilitator: '0x0000000000000000000000000000000000000000', validAfter: w.validAfter }) });
  }
  const { args, functionName } = decodeFunctionData({ abi: uptoSettlementAbi, data: proxyData });
  if (functionName !== 'settle' || !same(encodeFunctionData({ abi: uptoSettlementAbi, functionName, args }), proxyData)) throw new Error('noncanonical_proxy_call');
  const [p, actual, payer, w, sig] = args;
  if (!same(w.facilitator, gateway)) throw new Error('upto_requires_gateway_witness');
  validate(p.permitted.token, p.permitted.amount, actual, payer, w.to, sig);
  return Object.freeze({ gateway, data: encodeFunctionData({ abi: fundedGatewayAbi, functionName: 'settleUpto', args: [p, actual, payer, w, sig] }), proxy: UPTO, proxyData, payer, merchant: w.to, nonce: p.nonce, ceiling: p.permitted.amount, amount: actual, deadline: p.deadline,
    permitDigest: reservationDigest({ spender: UPTO, amount: p.permitted.amount, nonce: p.nonce, deadline: p.deadline, to: w.to, facilitator: w.facilitator, validAfter: w.validAfter }) });
}
function validate(token: Address, ceiling: bigint, amount: bigint, payer: Address, merchant: Address, sig: Hex) {
  if (!same(token, USDT) || ceiling > 100_000_000n || amount <= 0n || amount > ceiling
    || BigInt(payer) === 0n || BigInt(merchant) === 0n || same(payer, merchant) || !/^0x[0-9a-fA-F]{130}$/.test(sig)) throw new Error('invalid_gateway_payment');
}
export interface MerchantIntentTerms { nonce: bigint; deadline: bigint; feeUSDT: bigint; maxGas: number }
/** This port means actual merchant signing authority (e.g. approved Privy delegation), never an
 * application secret. No implementation or permissive production policy is supplied here. */
export interface ExactMerchantIntentAuthorizer {
  signExactIntent(router: Address, intent: Readonly<Intent>): Promise<Hex>;
}
export async function authorizeGatewayPayment(payment: GatewayPayment, router: Address, terms: MerchantIntentTerms,
  authority: ExactMerchantIntentAuthorizer): Promise<IntentRequest> {
  // Reconstruct, so a structurally forged/mutated GatewayPayment cannot acquire a different intent.
  const bound = gatewayPayment(payment.proxy, payment.proxyData, payment.gateway);
  if ((Object.keys(bound) as (keyof GatewayPayment)[]).some(key => bound[key] !== payment[key])) throw new Error('gateway_payment_conflict');
  if (!isAddress(router) || BigInt(router) === 0n || terms.nonce < 0n || terms.nonce >= 2n ** 256n
    || terms.deadline <= 0n || terms.deadline > bound.deadline || terms.deadline >= 2n ** 64n
    || terms.feeUSDT <= 0n || terms.feeUSDT >= 2n ** 256n || !Number.isSafeInteger(terms.maxGas)
    || terms.maxGas <= 0 || terms.maxGas > 1_000_000) throw new Error('invalid_merchant_intent_terms');
  const intent = Object.freeze({ signer: bound.merchant, merchant: bound.merchant, target: bound.gateway, dataHash: keccak256(bound.data), amount: bound.amount, nonce: terms.nonce, deadline: terms.deadline, feeUSDT: terms.feeUSDT, maxGas: terms.maxGas });
  const signature = await authority.signExactIntent(router, intent);
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature) || !same(await recoverTypedDataAddress({ ...intentTypedData(intent, router), signature }), bound.merchant)) throw new Error('merchant_signing_authority_required');
  return Object.freeze({ intent, data: bound.data, signature });
}
const settlementEvents = parseAbi([
  'event Executed(address indexed signer,address indexed merchant,uint256 indexed nonce,address target,uint256 reimbursement,uint256 feeUSDT)',
  'event Reimbursed(address indexed merchant,address indexed relayer,uint256 amount)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event Settled()',
]);
/** Strict payment evidence only. Does not release a journal hold or decide confirmation depth.
 * Root must bind receipt.txHash to the frozen prepared hash and enforce finality independently. */
export function fundedReceipt(receipt: X402Receipt, payment: GatewayPayment, request: IntentRequest,
  addresses: { router: Address; gasTank: Address; feeVault: Address; relayer: Address }, gasPrice: bigint) {
  if (receipt.status !== 'success' || request.data !== payment.data || request.intent.dataHash !== keccak256(payment.data)
    || !same(request.intent.signer, payment.merchant) || !same(request.intent.merchant, payment.merchant)
    || !same(request.intent.target, payment.gateway) || request.intent.amount !== payment.amount || gasPrice <= 0n) throw new Error('funded_evidence_mismatch');
  const counts = { gateway: 0, proxy: 0, executed: 0, reimbursed: 0, payment: 0, fee: 0 };
  let reimbursement = 0n, paidReimbursement = 0n, mismatch = false;
  for (const log of receipt.logs) {
    const topics = [...log.topics] as [Hex, ...Hex[]];
    if (same(log.address, payment.gateway)) {
      try {
        const event = decodeEventLog({ abi: fundedGatewayAbi, topics, data: log.data });
        const a = event.args;
        if (event.eventName === 'PaymentSettled' && same(a.permitDigest, payment.permitDigest) && same(a.payer, payment.payer)
          && same(a.merchant, payment.merchant) && same(a.proxy, payment.proxy) && a.nonce === payment.nonce
          && a.ceiling === payment.ceiling && a.amount === payment.amount) counts.gateway++;
        else mismatch = true;
      } catch { /* Unrelated log. */ }
    }
    try {
      const e = decodeEventLog({ abi: settlementEvents, topics, data: log.data });
      if (e.eventName === 'Settled' && same(log.address, payment.proxy) && log.data === '0x' && log.topics.length === 1) counts.proxy++;
      if (e.eventName === 'Executed' && same(log.address, addresses.router) && same(e.args.signer, payment.merchant)
        && same(e.args.merchant, payment.merchant) && e.args.nonce === request.intent.nonce && same(e.args.target, payment.gateway)
        && e.args.feeUSDT === request.intent.feeUSDT) { counts.executed++; reimbursement = e.args.reimbursement; }
      if (e.eventName === 'Reimbursed' && same(log.address, addresses.gasTank) && same(e.args.merchant, payment.merchant)
        && same(e.args.relayer, addresses.relayer)) { counts.reimbursed++; paidReimbursement = e.args.amount; }
      if (e.eventName === 'Transfer' && same(log.address, USDT)) {
        if (same(e.args.from, payment.payer) && same(e.args.to, payment.merchant)) { counts.payment++; if (e.args.value !== payment.amount) mismatch = true; }
        if (same(e.args.from, payment.merchant) && same(e.args.to, addresses.feeVault)) { counts.fee++; if (e.args.value !== request.intent.feeUSDT) mismatch = true; }
      }
    } catch { /* Unrelated log. */ }
  }
  const cap = (BigInt(request.intent.maxGas) + 40_000n) * gasPrice;
  if (mismatch || Object.values(counts).some(n => n !== 1) || reimbursement <= 0n || reimbursement !== paidReimbursement || reimbursement > cap) throw new Error('funded_evidence_mismatch');
  return { reimbursement, cap, feeUSDT: request.intent.feeUSDT, amount: payment.amount };
}
