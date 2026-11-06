import type { AccountWriter, PreparedWrite, WriteOperation } from './account-writer.js';
import type { ApprovalChain } from './approval-chain.js';
import type { Address, Hex } from 'viem';

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
export interface IntentRequest { intent: Intent; signature: Hex; data: Hex }
export interface Mandate { payer: Address; merchant: Address; planId: Hex; amountCap: bigint; periodSeconds: bigint; maxPeriods: number; endTime: bigint; nonce: bigint }
export interface ChainEvent {
  id: string;
  block: bigint;
  txHash: Hex;
  contract: 'escrow' | 'subscription' | 'router' | 'receivables';
  name: string;
  args: Record<string, string | bigint | number>;
  timestamp?: string;
  /** Where the FeeSchedule sent fees at this event's block: Pact's relayer, later a fee vault. */
  feeRecipient?: Address;
  /** Escrow state read at this event's block; not an invented event argument. */
  paymentTerms?: { refundWindowSeconds: string; refundDeadlineUnix: string };
}
export interface ChainReceipt {
  txHash: Hex;
  block: bigint;
  status: 'success' | 'reverted';
  // Only decoded events from the configured suite, never arbitrary log emitters.
  events: ChainEvent[];
  /** What the transaction cost its sender in WBT wei (gas used times the effective price), when known. */
  gasCostWei?: bigint;
}
export interface TransactionGas { gas: bigint; gasPrice: bigint }
export interface Simulation { accepted: boolean; reason?: string; gas: bigint }
/** Router limits, plus the FeeSchedule's WBT price that converts gas to USDT. */
export interface RouterPolicy { blockNumber: bigint; usdtPerWbt: bigint; maxGasPerCall: bigint; maxGasPriceWei: bigint; minimumAmountMinor: bigint; maxPayerCallsPerDay?: number }
export interface MerchantBalance { token: Address; blockNumber: bigint; balanceMinor: bigint }
/** One product's rate in the FeeSchedule: `bps` of the amount, at least `minFeeMinor`, at most `maxFeeMinor` (0: no cap). */
export interface FeeRate { bps: number; minFeeMinor: bigint; maxFeeMinor: bigint }
export interface FeeTerms { checkout: FeeRate; invoice: FeeRate }
/** A merchant's position in the FeeSchedule. */
export interface MerchantFees {
  /** The version the merchant signed, or 0: until it signs, Pact cannot take its payments. */
  acceptedVersion: number;
  latestVersion: number;
  accepted: FeeTerms | null;
  latest: FeeTerms;
  /** Where fees go. */
  recipient: Address;
  usdtPerWbt: bigint;
  /** The merchant's acceptance-signature nonce. */
  nonce: bigint;
}
export interface ChainAdapter {
  writer: AccountWriter;
  approval: ApprovalChain;
  chainId(): Promise<number>;
  latestBlock(): Promise<bigint>;
  // null means not found/pending, never evidence of a dropped transaction.
  receipt(hash: Hex): Promise<ChainReceipt | null>;
  events(from: bigint, to: bigint): Promise<ChainEvent[]>;
  simulate(request: IntentRequest, transaction: TransactionGas): Promise<Simulation>;
  prepareIntent(request: IntentRequest, gas: bigint, nonce: number, gasPrice: bigint): Promise<PreparedWrite>;
  broadcastTransaction(raw: Hex): Promise<Hex>;
  transactionCount(): Promise<number>;
  gasPrice(): Promise<bigint>;
  routerPolicy(): Promise<RouterPolicy>;
  merchantBalance(merchant: Address): Promise<MerchantBalance>;
  merchantFees(merchant: Address): Promise<MerchantFees>;
  /**
   * A direct write from Pact's relayer (not through the Router): permits, fee-terms acceptance and
   * signed financing orders. Simulated first, so a call that would revert is refused before it costs
   * gas; journaled and budgeted like every other relayer write.
   */
  relay(operation: WriteOperation, to: Address, data: Hex, gas: bigint): Promise<Hex>;
  renew(subscriptionId: Hex, amount: bigint, operation?: WriteOperation): Promise<Hex>;
  subscribe(mandate: Mandate, signature: Hex, operation?: WriteOperation): Promise<Hex>;
  cancelSigned(subscriptionId: Hex, deadline: bigint, signature: Hex, operation?: WriteOperation): Promise<Hex>;
  mandateNonce(payer: Address): Promise<bigint>;
}
export class Refusal extends Error {
  constructor(public code: string, message = code) { super(message); this.name = 'Refusal'; }
}
