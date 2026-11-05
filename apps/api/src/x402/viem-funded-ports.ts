import { encodeFunctionData, TransactionReceiptNotFoundError, type Hex, type PublicClient } from 'viem';
import type { ViemChain } from '../chain.js';
import type { IntentRequest } from '../types.js';
import { fundedRouterAbi } from './funded-operations.js';
import { same } from './call-binding.js';
import { fingerprint } from './sqlite-store.js';
import { ViemX402WritePorts } from './viem-write-ports.js';
import type { X402Receipt, X402Transaction } from './write-ports.js';

/** Reuses the existing ViemChain signer/writer. Additional port is READ-ONLY gas receipt data.
 * Root need not edit chain.ts: supply the same public client used by the facilitator. */
export class ViemFundedX402WritePorts extends ViemX402WritePorts {
  constructor(chain: ViemChain, private readonly reader: Pick<PublicClient, 'getChainId' | 'getTransactionReceipt'>) { super(chain); }
  async simulateFunded(request: IntentRequest, envelope: X402Transaction & { maxFeePerGas: bigint }) {
    if (!same(envelope.to, this.chain.addresses.router) || envelope.data !== encodeFunctionData({ abi: fundedRouterAbi, functionName: 'execute', args: [request.intent, request.data, request.signature] })) throw new Error('funded_envelope_conflict');
    const result = await this.chain.simulate(request, { gas: envelope.gas, gasPrice: envelope.maxFeePerGas });
    if (!result.accepted) throw new Error('funded_simulation_refused');
  }
  override async receipt(hash: Hex): Promise<X402Receipt | null> {
    const base = await super.receipt(hash);
    if (!base) return null;
    if (await this.reader.getChainId() !== 1874) throw new Error('wrong_funded_receipt_chain');
    try {
      const r = await this.reader.getTransactionReceipt({ hash });
      const comparable = { txHash: r.transactionHash, block: r.blockNumber, status: r.status, logs: r.logs.map(({ address, topics, data }) => ({ address, topics, data })) };
      if (fingerprint(base) !== fingerprint(comparable)) throw new Error('funded_receipt_reader_mismatch');
      return { ...base, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice };
    } catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; }
  }
}
