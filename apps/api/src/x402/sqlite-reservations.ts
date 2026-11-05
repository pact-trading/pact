import { encodeFunctionData, isAddress, type Address, type Hex } from 'viem';
import { agentAccountAbi, type AccountReservationAdapter, type ReservedPayment } from './account-client.js';
import { reservationDigest, reservationFingerprint } from './call-binding.js';
import { NETWORK } from './constants.js';
import { X402WriteCoordinator } from './write-coordinator.js';

export class ReservationPendingError extends Error {
  constructor(readonly operationId: string, readonly transaction: string, readonly reason: string) { super(`x402_reservation_${reason}`); }
}
export class SqliteAccountReservationAdapter implements AccountReservationAdapter {
  constructor(readonly coordinator: X402WriteCoordinator, private readonly gas: bigint) {
    if (gas <= 0n || gas > 1_000_000n) throw new Error('invalid_reservation_gas');
  }
  async reserve(account: Address, payment: ReservedPayment, signature: Hex): Promise<void> {
    if (!isAddress(account) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('invalid_reservation_signature');
    const digest = reservationDigest(payment);
    const key = this.coordinator.claim({ key: `${NETWORK}:reservation:${account.toLowerCase()}:${digest}`, kind: 'x402_reservation', payer: account, nonce: payment.nonce.toString(), merchant: payment.to, amount: payment.amount, permitDigest: digest, fingerprint: reservationFingerprint(payment, signature) });
    const result = await this.coordinator.run(key, async () => {
      await this.coordinator.send(key, { chainId: 1874, to: account, data: encodeFunctionData({ abi: agentAccountAbi, functionName: 'reserve', args: [payment, signature] }), value: 0n, gas: this.gas });
    });
    if (!result.success) throw new ReservationPendingError(key, result.transaction, result.errorReason ?? 'pending');
    // A historic success does not make an expired/revoked/rotated session valid now. A read failure
    // never returns the signature and never invites another reservation transaction.
    if (!await this.coordinator.config.ports.reservationValid(account, digest, signature)) throw new ReservationPendingError(key, result.transaction, 'not_currently_valid');
  }
}
