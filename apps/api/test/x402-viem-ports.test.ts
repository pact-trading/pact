import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { keccak256, parseTransaction, recoverTransactionAddress, toHex, type Hex, type TransactionSerialized } from 'viem';
import { AccountWriter } from '../src/account-writer.js';
import { openDb } from '../src/db.js';
import { X402WriteCoordinator } from '../src/x402/write-coordinator.js';
import { ViemChain } from '../src/chain.js';
import { ViemX402WritePorts, inactiveSponsorshipPolicy } from '../src/x402/viem-write-ports.js';
import { EXACT } from '../src/x402/constants.js';
import type { SponsorshipRequest, X402Transaction } from '../src/x402/write-ports.js';

const servers: Server[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(s => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); }))); });
async function fixture() {
  let chainId = 1874;
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    let input = ''; for await (const part of req) input += part;
    const { id, method } = JSON.parse(input); calls.push(method);
    const result = method === 'eth_chainId' ? toHex(chainId) : method === 'eth_getTransactionCount' ? '0x7'
      : method === 'eth_blockNumber' ? '0x21' : method === 'eth_getTransactionReceipt' ? null
      : method === 'eth_call' ? `0x1626ba7e${'0'.repeat(56)}` : null;
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
  servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const chain = new ViemChain(`http://127.0.0.1:${(server.address() as { port: number }).port}`, toHex(0x402a11cen, { size: 32 }), { router: EXACT, escrow: EXACT, fees: EXACT, subscription: EXACT });
  return { chain, ports: new ViemX402WritePorts(chain), calls, setChain: (id: number) => chainId = id };
}
const request: X402Transaction & { maxFeePerGas: bigint } = { chainId: 1874, to: EXACT, data: '0x12345678', value: 0n, gas: 500_000n, maxFeePerGas: 2_000_000_000n };

describe('existing ViemChain x402 signing bridge (mock RPC, real synthetic signatures)', () => {
  it('uses the existing writer and signs exact calldata, nonce and capped cost without broadcasting', async () => {
    const { chain, ports, calls } = await fixture();
    expect(ports.writer).toBe(chain.writer);
    const prepared = await ports.prepare(request, 7);
    expect(prepared.hash).toBe(keccak256(prepared.raw));
    const tx = parseTransaction(prepared.raw);
    expect(tx).toMatchObject({ type: 'legacy', chainId: 1874, to: EXACT.toLowerCase(), data: request.data, nonce: 7, gas: request.gas, gasPrice: request.maxFeePerGas });
    expect(tx.gas! * tx.gasPrice!).toBe(1_000_000_000_000_000n);
    expect(await recoverTransactionAddress({ serializedTransaction: prepared.raw as TransactionSerialized })).toBe(chain.writer.relayer);
    expect(calls).toEqual(['eth_chainId']);
    expect(await ports.transactionCount()).toBe(7);
    expect(await ports.latestBlock()).toBe(33n);
    expect(await ports.receipt(prepared.hash)).toBeNull();
    expect(await ports.reservationValid(EXACT, prepared.hash, '0x12')).toBe(true);
  });
  it.each(['gas', 'data', 'nonce', 'fee', 'hash', 'signer'] as const)('rejects a prepare implementation that changes %s', async field => {
    const { chain, ports, calls } = await fixture();
    const original = chain.prepareX402Transaction.bind(chain);
    // A separate synthetic signer is used only to test rejection, never by the adapter.
    const stranger = new ViemChain('http://127.0.0.1:1', toHex(99n, { size: 32 }), chain.addresses);
    vi.spyOn(stranger, 'chainId').mockResolvedValue(1874);
    vi.spyOn(chain, 'prepareX402Transaction').mockImplementation(async (r, n) => {
      if (field === 'signer') return stranger.prepareX402Transaction(r, n);
      const result = await original({ ...r, gas: field === 'gas' ? r.gas - 1n : r.gas,
        data: field === 'data' ? '0x87654321' : r.data, maxFeePerGas: field === 'fee' ? r.maxFeePerGas + 1n : r.maxFeePerGas }, field === 'nonce' ? n + 1 : n);
      return field === 'hash' ? { ...result, hash: toHex(0n, { size: 32 }) } : result;
    });
    await expect(ports.prepare(request, 7)).rejects.toThrow('signed_x402_envelope_mismatch');
    expect(calls).not.toContain('eth_sendRawTransaction');
  });
  it('refuses wrong network, invalid gas/fee/nonce before any broadcast', async () => {
    const { ports, calls, setChain } = await fixture();
    for (const [gas, fee, nonce] of [[0n, 1n, 0], [1_000_001n, 1n, 0], [1n, 0n, 0], [1n, 100_000_000_001n, 0], [1n, 1n, -1], [1n, 1n, 0.5]] as const) {
      await expect(ports.prepare({ ...request, gas, maxFeePerGas: fee }, nonce)).rejects.toThrow();
    }
    setChain(1); await expect(ports.prepare(request, 0)).rejects.toThrow('Invalid x402 envelope');
    await expect(ports.reservationValid(EXACT, toHex(0n, { size: 32 }), '0x12')).rejects.toThrow('Wrong chain');
    expect(calls).not.toContain('eth_sendRawTransaction');
  });
  it('rejects a second writer queue even for the same relayer', async () => {
    const { ports, chain } = await fixture();
    const db = openDb();
    try {
      expect(() => new X402WriteCoordinator({ db, ports, writer: new AccountWriter(chain.writer.relayer), sponsorship: inactiveSponsorshipPolicy, maxSpendPerMinuteWei: 1n, confirmations: 2n })).toThrow('x402_shared_writer_required');
      expect(new X402WriteCoordinator({ db, ports, writer: chain.writer, sponsorship: inactiveSponsorshipPolicy, maxSpendPerMinuteWei: 1n, confirmations: 2n }).address).toBe(chain.writer.relayer);
    } finally { db.close(); }
  });
  it('has no permissive production sponsorship policy', async () => {
    await expect(inactiveSponsorshipPolicy.authorize({} as SponsorshipRequest)).rejects.toThrow('x402_sponsorship_unconfigured');
  });
});
