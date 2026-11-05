import type { PendingSettlementStore } from '@x402/core/facilitator';
import type { SettleResponse } from '@x402/core/types';
import type { Address, Hex, PublicClient } from 'viem';

export interface SettlementOperation {
  /** Shared across exact/upto: Permit2 nonce is global to this payer. */
  id: string;
  fingerprint: Hex;
  merchant: Address;
  payer: Address;
  amount: bigint;
}
/** Root must adapt the shared durable relayer journal, never a separate production wallet.
 * All adapters must share the single AccountWriter owner; multiple writer processes are unsupported.
 * Serialize runOnce by id. Persist terminal results; reject a different
 * fingerprint for the same id. Reconcile pending transactions before executing again.
 * submit MUST use AccountWriter's durable chain/signer/nonce/hash phases before broadcasting,
 * sharing nonce allocation with every writer. Raw bytes are not persisted. Never automatically
 * resend/re-sign a broadcasting/submitted/uncertain operation, including after a missing receipt.
 * Enforce merchant gas-tank funding, daily gas budget, rate limits and fee ceilings before
 * signing. Reserve/reconcile budgets transactionally, including failed transactions.
 * Never delete uncertain submissions or reuse their nonces after a timeout.
 */
export interface X402Journal {
  readonly address: Address;
  /** Distinct from transaction signer for the explicit funded variant. */
  readonly settlementCaller?: Address;
  readonly variant?: 'direct' | 'funded';
  initialize?(publicClient: PublicClient): Promise<void>;
  readonly pending: PendingSettlementStore;
  runOnce(operation: SettlementOperation, execute: () => Promise<SettleResponse>): Promise<SettleResponse>;
  submit(operation: SettlementOperation, transaction: {
    chainId: 1874; to: Address; data: Hex; value: 0n; gas: bigint;
  }): Promise<Hex>;
}
