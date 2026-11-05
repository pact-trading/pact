import type { SettleResponse } from '@x402/core/types';
import type { PublicClient } from 'viem';
import type { SettlementOperation, X402Journal } from './journal.js';
import { bindSettlement, settlementIdentity } from './call-binding.js';
import { SqlitePendingSettlementStore } from './sqlite-store.js';
import { X402WriteCoordinator } from './write-coordinator.js';
import type { X402Transaction } from './write-ports.js';

/** Funded and direct variants claim the SAME x402_operations key and unique payer Permit2 nonce.
 * Only the explicit funded variant can authorize/build a Router envelope. No prepare-time wrapping. */
export class SqliteFundedX402Journal implements X402Journal {
  readonly variant = 'funded' as const;
  readonly pending: SqlitePendingSettlementStore;
  constructor(readonly coordinator: X402WriteCoordinator) {
    if (!coordinator.funded.route || !coordinator.config.ports.simulateFunded) throw new Error('funded_transport_required');
    this.pending = new SqlitePendingSettlementStore(coordinator.config.db, `1874:${coordinator.address.toLowerCase()}:funded:${this.settlementCaller.toLowerCase()}`);
  }
  get address() { return this.coordinator.address; }
  get settlementCaller() { return this.coordinator.funded.route!.gateway; }
  initialize(pub: PublicClient) { return this.coordinator.funded.initialize(pub); }
  private key(operation: SettlementOperation) {
    const { key, nonce } = settlementIdentity(operation);
    return this.coordinator.claim({ key, nonce, kind: 'x402', variant: 'funded', routeFingerprint: this.coordinator.funded.routeFingerprint!, payer: operation.payer, merchant: operation.merchant, amount: operation.amount, fingerprint: operation.fingerprint });
  }
  async runOnce(operation: SettlementOperation, execute: () => Promise<SettleResponse>) { return this.coordinator.run(this.key(operation), execute); }
  async submit(operation: SettlementOperation, canonicalProxyCall: X402Transaction) {
    bindSettlement(operation, canonicalProxyCall, this.settlementCaller);
    return this.coordinator.sendFunded(this.key(operation), operation, canonicalProxyCall);
  }
  reconcile() { return this.coordinator.reconcile(); }
}
