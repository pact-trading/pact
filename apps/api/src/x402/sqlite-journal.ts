import type { SettleResponse } from '@x402/core/types';
import type { SettlementOperation, X402Journal } from './journal.js';
import { bindSettlement, settlementIdentity } from './call-binding.js';
import { SqlitePendingSettlementStore } from './sqlite-store.js';
import { X402WriteCoordinator } from './write-coordinator.js';
import type { X402Transaction } from './write-ports.js';

export class SqliteX402Journal implements X402Journal {
  readonly pending: SqlitePendingSettlementStore;
  constructor(readonly coordinator: X402WriteCoordinator) {
    this.pending = new SqlitePendingSettlementStore(coordinator.config.db, `1874:${coordinator.address.toLowerCase()}`);
  }
  get address() { return this.coordinator.address; }
  private key(operation: SettlementOperation) {
    const { key, nonce } = settlementIdentity(operation);
    return this.coordinator.claim({ key, nonce, kind: 'x402', payer: operation.payer, merchant: operation.merchant, amount: operation.amount, fingerprint: operation.fingerprint });
  }
  async runOnce(operation: SettlementOperation, execute: () => Promise<SettleResponse>) { return this.coordinator.run(this.key(operation), execute); }
  async submit(operation: SettlementOperation, transaction: X402Transaction) {
    bindSettlement(operation, transaction, this.address);
    return this.coordinator.send(this.key(operation), transaction);
  }
  reconcile() { return this.coordinator.reconcile(); }
}
