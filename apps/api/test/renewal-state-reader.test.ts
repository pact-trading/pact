import { describe, it, expect, vi } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import { ViemRenewalStateReader, type RenewalReadPort } from '../src/renewal-state-reader.js';
import type { RenewalGrant } from '../src/funded-renewal-store.js';
import { assertLocalRenewalCapability, assertRenewalLoopback, type LocalRenewalCapability } from '../src/local/renewal-fork.js';
import { FakeChain } from '../src/chain.js';
const addresses = { router: '0x0000000000000000000000000000000000000001', subscription: '0x0000000000000000000000000000000000000002', gasTank: '0x0000000000000000000000000000000000000003', escrow: '0x0000000000000000000000000000000000000004' } as const;
const token = '0x0000000000000000000000000000000000000005', digest = keccak256(toHex('mandate'));
function fixture() {
  const code = '0x60006000' as Hex;
  const head = { number: 42n, hash: keccak256(toHex('42')), timestamp: 1800000000n };
  const state = [token, addresses.router, digest, 1000000n, 86400n, 12, 2, 1900000000n, 1800000000n, false];
  const read = vi.fn(async (address, _abi, name) => {
    if (name === 'subscriptions') return state;
    if (name === 'allowed') return [true, true];
    if (name === 'usdt') return token;
    if (name === 'router') return addresses.router;
    if (name === 'gasTank') return addresses.gasTank;
    if (name === 'hashMandate') return digest;
    throw new Error(`Unexpected ${address}:${name}`);
  });
  const port: RenewalReadPort = { chainId: vi.fn(async () => 1874), block: vi.fn(async () => ({ ...head })), code: vi.fn(async () => code), read };
  const hashes = { router: keccak256(code), subscription: keccak256(code), gasTank: keccak256(code), escrow: keccak256(code), token: keccak256(code) };
  const grant = { router: addresses.router, manager: addresses.subscription, token, chainSubscriptionId: digest, mandateHash: digest, mandate: {} } as unknown as RenewalGrant;
  return { port, head, state, grant, read, reader: new ViemRenewalStateReader(addresses, hashes, port) };
}
describe('block-pinned V2/Router reader', () => {
  it('pins every code and contract read, verifies the final hash, and maps actual V2 state', async () => {
    const f = fixture(), snapshot = await f.reader.read(f.grant);
    expect(snapshot).toMatchObject({ blockNumber: 42n, blockHash: f.head.hash, chargeAllowed: true, mustReturnTrue: true, subscription: { payer: token, amountCap: 1000000n, periodSeconds: 86400n, chargedPeriods: 2, nextChargeAt: 1800000000n, cancelled: false } });
    expect(f.port.code).toHaveBeenCalledTimes(5);
    for (const args of vi.mocked(f.port.code).mock.calls) expect(args[1]).toBe(42n);
    for (const args of vi.mocked(f.port.read).mock.calls) expect(args[4]).toBe(42n);
    expect(f.port.block).toHaveBeenNthCalledWith(1);
    expect(f.port.block).toHaveBeenNthCalledWith(2, 42n);
  });
  it.each(['wrong_chain', 'changed_code', 'wrong_domain', 'wrong_router', 'reorg', 'rpc_error', 'malformed'] as const)('fails closed on %s without latest fallback', async scenario => {
    const f = fixture();
    if (scenario === 'wrong_chain') vi.mocked(f.port.chainId).mockResolvedValue(1);
    if (scenario === 'changed_code') vi.mocked(f.port.code).mockResolvedValue('0x6001');
    if (scenario === 'reorg') vi.mocked(f.port.block).mockResolvedValueOnce(f.head).mockResolvedValue({ ...f.head, hash: keccak256(toHex('reorg')) });
    const original = f.read.getMockImplementation()!;
    if (['wrong_domain', 'wrong_router', 'rpc_error', 'malformed'].includes(scenario)) f.read.mockImplementation(async (...args) => {
      if (scenario === 'rpc_error') throw new Error('RPC unavailable');
      if (scenario === 'wrong_domain' && args[2] === 'hashMandate') return keccak256(toHex('V1 digest'));
      if (scenario === 'wrong_router' && args[2] === 'router') return token;
      if (scenario === 'malformed' && args[2] === 'subscriptions') return [];
      return original(...args);
    });
    await expect(f.reader.read(f.grant)).rejects.toThrow();
    expect(f.port.block).toHaveBeenCalledTimes(scenario === 'reorg' ? 2 : scenario === 'wrong_chain' ? 0 : 1);
  });
  it('returns disabled or non-true-returning policy honestly for service rejection', async () => {
    const f = fixture(), original = f.read.getMockImplementation()!;
    f.read.mockImplementation(async (...args) => args[2] === 'allowed' ? [true, false] : original(...args));
    expect(await f.reader.read(f.grant)).toMatchObject({ chargeAllowed: true, mustReturnTrue: false });
  });
});
describe('owned local-fork capability boundary', () => {
  it.each(['https://rpc.testnet.whitechain.io', 'http://localhost:8545', 'http://127.0.0.1:3000', 'http://127.0.0.1:3001', 'http://127.0.0.1:3002', 'http://127.0.0.1:8545/proxy', 'http://user:pass@127.0.0.1:8545', 'http://127.0.0.1:8545/?url=remote'])('rejects %s', url => {
    expect(() => assertRenewalLoopback(url)).toThrow('Isolated loopback');
  });
  it('accepts the loopback syntax without treating it as attestation; forged capability never enables a writer', () => {
    expect(() => assertRenewalLoopback('http://127.0.0.1:45678')).not.toThrow();
    expect(() => assertLocalRenewalCapability({} as LocalRenewalCapability, new FakeChain(false, 2), {})).toThrow('invalid local-fork capability');
  });
});
