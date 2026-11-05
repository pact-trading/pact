import type { IntentRequest } from '../types.js';
import type { Address, Hex } from 'viem';
import type { AccountWriter, PreparedWrite } from '../account-writer.js';

export interface X402Transaction { chainId: 1874; to: Address; data: Hex; value: 0n; gas: bigint }
export interface SponsorshipRequest {
  operationId: string; kind: 'x402' | 'x402_reservation'; merchant: Address; payer: Address;
  variant?: 'direct' | 'funded';
  amount: bigint; transaction: X402Transaction;
}
export interface SponsorshipGrant {
  policyId: string;
  maxFeePerGas: bigint;
  merchantDailyLimitWei: bigint;
  merchantDailyCalls: number;
}
/** REQUIRED gate, with no default permissive implementation. Must refuse until root has approved
 * and integrated merchant sponsorship and actual M7 reimbursement. A balance read is NOT proof of
 * reimbursement. Bind authorization to this exact account/merchant/action/calldata/gas envelope.
 * SQLite limits below are conservative admission limits, not an onchain gas-tank implementation. */
export interface MerchantSponsorshipPolicy { authorize(request: SponsorshipRequest): Promise<SponsorshipGrant> }
export interface X402Receipt {
  txHash: Hex; block: bigint; status: 'success' | 'reverted';
  gasUsed?: bigint; effectiveGasPrice?: bigint;
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[];
}
/** Connect these to the existing chain's signing/transport implementation, not a new wallet.
 * prepare MUST sign exactly this envelope, supplied nonce, gas and maximum fee; it must never
 * broadcast. Returned raw bytes live only in AccountWriter.execute's call stack, never SQLite.
 * Read methods are read-only; null receipts and errors never authorize retransmission. */
export interface X402WritePorts {
  /** Real transport exposes its existing writer so coordinator construction can reject
   * accidentally creating a second queue, even for the same relayer address. */
  readonly writer?: AccountWriter;
  simulateFunded?(request: IntentRequest, envelope: X402Transaction & { maxFeePerGas: bigint }): Promise<void>;
  chainId(): Promise<number>;
  transactionCount(): Promise<number>;
  prepare(request: X402Transaction & { maxFeePerGas: bigint }, nonce: number): Promise<PreparedWrite>;
  broadcast(raw: Hex): Promise<Hex>;
  latestBlock(): Promise<bigint>;
  receipt(hash: Hex): Promise<X402Receipt | null>;
  /** Actual ERC-1271 read against the account's current state, including revocation/expiry. */
  reservationValid(account: Address, permitDigest: Hex, signature: Hex): Promise<boolean>;
}

export class X402WriteRefusal extends Error {
  constructor(readonly code: string) { super(code); }
}
