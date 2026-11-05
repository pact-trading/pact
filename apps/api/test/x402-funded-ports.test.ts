import { describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, keccak256, toHex, TransactionReceiptNotFoundError, type PublicClient } from 'viem';
import { ViemChain } from '../src/chain.js';
import type { IntentRequest } from '../src/types.js';
import { EXACT, UPTO } from '../src/x402/constants.js';
import { fundedRouterAbi } from '../src/x402/funded-operations.js';
import { ViemFundedX402WritePorts } from '../src/x402/viem-funded-ports.js';

function fixture() {
  const chain = new ViemChain('http://127.0.0.1:1', toHex(0x402a11cen, { size: 32 }), { router: EXACT, escrow: EXACT, gasTank: EXACT, subscription: EXACT });
  const base = { txHash: keccak256('0x12'), block: 10n, status: 'success' as const, logs: [{ address: EXACT, topics: [keccak256('0x34')], data: '0x' as const }] };
  vi.spyOn(chain, 'x402Receipt').mockResolvedValue(base);
  const reader = { getChainId: vi.fn(async () => 1874), getTransactionReceipt: vi.fn(async () => ({ transactionHash: base.txHash, blockNumber: base.block, status: base.status, logs: base.logs, gasUsed: 400_000n, effectiveGasPrice: 2n })) };
  const ports = new ViemFundedX402WritePorts(chain, reader as unknown as PublicClient);
  return { chain, base, reader, ports };
}

describe('funded Viem ports (existing signer/writer; mock read-only transport)', () => {
  it('adds gas metadata only to the same raw receipt seen by the existing chain', async () => {
    const { chain, base, reader, ports } = fixture();
    expect(ports.writer).toBe(chain.writer);
    expect(await ports.receipt(base.txHash)).toEqual({ ...base, gasUsed: 400_000n, effectiveGasPrice: 2n });
    expect(reader.getTransactionReceipt).toHaveBeenCalledWith({ hash: base.txHash });
    vi.mocked(chain.x402Receipt).mockResolvedValue(null);
    expect(await ports.receipt(base.txHash)).toBeNull(); expect(reader.getTransactionReceipt).toHaveBeenCalledTimes(1);
  });
  it.each(['hash', 'block', 'status', 'logs'] as const)('refuses disagreeing %s from the read-only receipt port', async field => {
    const { base, reader, ports } = fixture();
    const raw = await reader.getTransactionReceipt();
    const changed = { ...raw, ...(field === 'hash' ? { transactionHash: keccak256('0x56') } : field === 'block' ? { blockNumber: 11n } : field === 'status' ? { status: 'reverted' } : { logs: [] }) };
    reader.getTransactionReceipt.mockResolvedValue(changed as typeof raw);
    await expect(ports.receipt(base.txHash)).rejects.toThrow('funded_receipt_reader_mismatch');
  });
  it('retains uncertainty for missing/error reads and rejects a different chain', async () => {
    const { base, reader, ports } = fixture();
    reader.getTransactionReceipt.mockRejectedValueOnce(new TransactionReceiptNotFoundError({ hash: base.txHash }));
    expect(await ports.receipt(base.txHash)).toBeNull();
    reader.getTransactionReceipt.mockRejectedValueOnce(new Error('RPC unavailable'));
    await expect(ports.receipt(base.txHash)).rejects.toThrow('RPC unavailable');
    reader.getChainId.mockResolvedValue(1);
    await expect(ports.receipt(base.txHash)).rejects.toThrow('wrong_funded_receipt_chain');
  });
  it('simulates only the exact pre-authorized Router envelope and propagates Router refusal', async () => {
    const { chain, ports } = fixture();
    const request: IntentRequest = { intent: { signer: EXACT, merchant: EXACT, target: UPTO, dataHash: keccak256('0x1234'), amount: 10_000n, feeUSDT: 1n, nonce: 3n, deadline: 100n, maxGas: 500_000 }, data: '0x1234', signature: '0x12' };
    const envelope = { chainId: 1874 as const, to: EXACT, value: 0n as const, gas: 900_000n, maxFeePerGas: 2n, data: encodeFunctionData({ abi: fundedRouterAbi, functionName: 'execute', args: [request.intent, request.data, request.signature] }) };
    const simulate = vi.spyOn(chain, 'simulate').mockResolvedValue({ accepted: true, gas: envelope.gas });
    await ports.simulateFunded(request, envelope);
    expect(simulate).toHaveBeenCalledWith(request, { gas: 900_000n, gasPrice: 2n });
    await expect(ports.simulateFunded(request, { ...envelope, data: '0x1234' })).rejects.toThrow('funded_envelope_conflict');
    await expect(ports.simulateFunded(request, { ...envelope, to: UPTO })).rejects.toThrow('funded_envelope_conflict');
    expect(simulate).toHaveBeenCalledTimes(1);
    simulate.mockResolvedValue({ accepted: false, reason: 'GasTank', gas: 0n });
    await expect(ports.simulateFunded(request, envelope)).rejects.toThrow('funded_simulation_refused');
  });
});
