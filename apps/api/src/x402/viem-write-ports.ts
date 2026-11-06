import { keccak256, parseTransaction, recoverTransactionAddress, type Hex, type TransactionSerialized } from 'viem';
import type { ViemChain } from '../chain.js';
import type { PreparedWrite } from '../account-writer.js';
import { same, validateEnvelope } from './call-binding.js';
import { X402WriteRefusal, type MerchantSponsorshipPolicy, type X402Transaction, type X402WritePorts } from './write-ports.js';

/** No key, wallet, RPC URL or nonce manager is accepted here. Root must pass the same
 * ViemChain instance used by every other relayer feature, and its writer to the coordinator.
 * Signs the exact supplied envelope without wrapping; the transport authorizes nothing itself. */
export class ViemX402WritePorts implements X402WritePorts {
  readonly writer;
  constructor(readonly chain: ViemChain) { this.writer = chain.writer; }
  chainId() { return this.chain.chainId(); }
  transactionCount() { return this.chain.transactionCount(); }
  latestBlock() { return this.chain.x402BlockNumber(); }
  receipt(hash: Hex) { return this.chain.x402Receipt(hash); }
  reservationValid(...args: Parameters<ViemChain['x402ReservationValid']>) { return this.chain.x402ReservationValid(...args); }
  broadcast(raw: Hex) { return this.chain.broadcastTransaction(raw); }
  async prepare(request: X402Transaction & { maxFeePerGas: bigint }, nonce: number): Promise<PreparedWrite> {
    request = Object.freeze({ ...request });
    validateEnvelope(request);
    if (!Number.isSafeInteger(nonce) || nonce < 0 || request.maxFeePerGas <= 0n || request.maxFeePerGas > 100_000_000_000n) throw new X402WriteRefusal('invalid_x402_fee_or_nonce');
    const prepared = await this.chain.prepareX402Transaction(request, nonce);
    // Verify the actual signed bytes before AccountWriter can enter broadcasting. This also
    // prevents a future prepare implementation from silently changing targets or wrapping data.
    const tx = parseTransaction(prepared.raw);
    if (tx.type !== 'legacy' || tx.chainId !== 1874 || tx.nonce !== nonce
      || !tx.to || !same(tx.to, request.to) || !same(tx.data ?? '0x', request.data)
      || (tx.value ?? 0n) !== 0n || tx.gas !== request.gas || tx.gasPrice !== request.maxFeePerGas
      || !same(keccak256(prepared.raw), prepared.hash)
      || !same(await recoverTransactionAddress({ serializedTransaction: prepared.raw as TransactionSerialized }), this.writer.relayer)) {
      throw new X402WriteRefusal('signed_x402_envelope_mismatch');
    }
    return prepared;
  }
}

/** Fail-closed default: refuses every settlement until a sponsorship policy is configured. */
export const inactiveSponsorshipPolicy: MerchantSponsorshipPolicy = Object.freeze({
  async authorize() { throw new X402WriteRefusal('x402_sponsorship_unconfigured'); },
});
