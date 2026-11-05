import type { AccountWriter, PreparedWrite, WriteOperation } from './account-writer.js';
import type { ApprovalChain } from './approval-chain.js';
import type { Address, Hex } from 'viem';

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
export interface IntentRequest { intent: Intent; signature: Hex; data: Hex }
export interface Mandate { payer: Address; merchant: Address; planId: Hex; amountCap: bigint; periodSeconds: bigint; maxPeriods: number; endTime: bigint; nonce: bigint }
export interface MerchantConsent { deadline: bigint; signature: Hex }
export interface ChainEvent {
  id: string;
  block: bigint;
  txHash: Hex;
  contract: 'escrow' | 'subscription' | 'router' | 'gasTank' | 'receivables';
  name: string;
  args: Record<string, string | bigint | number>;
  timestamp?: string;
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
}
export interface TransactionGas { gas: bigint; gasPrice: bigint }
export interface Simulation { accepted: boolean; reason?: string; gas: bigint }
export interface RouterPolicy { blockNumber: bigint; usdtPerWbt: bigint; maxGasPerCall: bigint; maxGasPriceWei: bigint; minimumAmountMinor: bigint; maxPayerCallsPerDay?: number }
export interface MerchantBalance { token: Address; blockNumber: bigint; balanceMinor: bigint }
export interface ChainAdapter {
  readonly subscriptionVersion: 1 | 2;
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
  gasTank(merchant: Address): Promise<{ balanceWei: bigint; dailyCapWei: bigint; spentTodayWei: bigint }>;
  renew(subscriptionId: Hex, amount: bigint, operation?: WriteOperation): Promise<Hex>;
  subscribe(mandate: Mandate, signature: Hex, operation?: WriteOperation, consent?: MerchantConsent): Promise<Hex>;
  cancelSigned(subscriptionId: Hex, deadline: bigint, signature: Hex, operation?: WriteOperation): Promise<Hex>;
  mandateNonce(payer: Address): Promise<bigint>;
}
export class Refusal extends Error {
  constructor(public code: string, message = code) { super(message); this.name = 'Refusal'; }
}
