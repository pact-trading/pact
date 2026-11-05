import { describe, expect, it, vi } from 'vitest';
import { keccak256, type PublicClient } from 'viem';
import { Permit2Facilitator } from '../src/x402/facilitator.js';
import { x402Routes } from '../src/x402/routes.js';
import { EXACT, NETWORK, PERMIT2, UPTO, USDT } from '../src/x402/constants.js';
import type { X402Journal } from '../src/x402/journal.js';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
const merchant = '0x0000000000000000000000000000000000001234';
function fixture(missing = false) {
  const submit = vi.fn();
  const journal = { address: merchant, submit, runOnce: vi.fn(), pending: { get: vi.fn(), set: vi.fn(), delete: vi.fn() } } as unknown as X402Journal;
  const publicClient = { getChainId: async () => 1874, getCode: async ({ address }: { address: string }) => missing && address === UPTO ? undefined : '0x6000', readContract: async ({ functionName }: { functionName: string }) => functionName === 'decimals' ? 6 : PERMIT2 } as unknown as PublicClient;
  const runtimeHashes = { [PERMIT2]: keccak256('0x6000'), [EXACT]: keccak256('0x6000'), [UPTO]: keccak256('0x6000') };
  const facilitator = new Permit2Facilitator({ journal, publicClient, runtimeHashes, merchants: [merchant], maxAmount: 10000n, maxGas: 500000n });
  return { facilitator, submit, journal };
}
const requirements: PaymentRequirements = { scheme: 'exact', network: NETWORK, asset: USDT, amount: '10000', payTo: merchant, maxTimeoutSeconds: 120, extra: { assetTransferMethod: 'permit2' } };
const payload: PaymentPayload = { x402Version: 2, accepted: requirements, payload: {} };
describe('x402 activation and HTTP boundary', () => {
  it('advertises no support until all runtimes are attested', async () => {
    const { facilitator, submit } = fixture(true);
    expect(facilitator.getSupported().kinds).toEqual([]);
    await expect(facilitator.initialize()).rejects.toThrow('runtime_unavailable');
    expect(facilitator.getSupported().kinds).toEqual([]);
    expect((await facilitator.settle(payload, requirements)).success).toBe(false);
    expect(submit).not.toHaveBeenCalled();
  });
  it('advertises exactly official v2 exact and upto, with no unsupported sponsorship extension', async () => {
    const { facilitator } = fixture(); await facilitator.initialize();
    expect(facilitator.getSupported().kinds.map(k => [k.x402Version, k.scheme, k.network])).toEqual([[2, 'exact', NETWORK], [2, 'upto', NETWORK]]);
    expect(facilitator.getSupported().extensions).toEqual([]);
  });
  it.each([
    ['wrong network', { network: 'eip155:1' }],
    ['wrong token', { asset: merchant }],
    ['unregistered merchant', { payTo: PERMIT2 }],
    ['over amount cap', { amount: '10001' }],
    ['zero amount', { amount: '0' }],
    ['excess deadline', { maxTimeoutSeconds: 301 }],
    ['unsupported method', { extra: { assetTransferMethod: 'eip3009' } }],
  ])('rejects %s without accessing write journal', async (_, changes) => {
    const { facilitator, submit, journal } = fixture(); await facilitator.initialize();
    const req = { ...requirements, ...changes } as PaymentRequirements;
    expect((await facilitator.verify(payload, req)).isValid).toBe(false);
    expect((await facilitator.settle(payload, req)).success).toBe(false);
    expect(submit).not.toHaveBeenCalled(); expect(journal.runOnce).not.toHaveBeenCalled();
  });
  it('rejects malformed input, unauthorized merchants and excessive bodies at HTTP boundary', async () => {
    const { facilitator } = fixture(); await facilitator.initialize();
    const authorize = vi.fn(async () => false);
    const app = x402Routes({ facilitator, authorize });
    expect((await app.request('/verify', { method: 'POST', body: '{' })).status).toBe(400);
    expect((await app.request('/settle', { method: 'POST', body: '{}' })).status).toBe(400);
    expect((await app.request('/settle', { method: 'POST', body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirements }) })).status).toBe(401);
    expect((await app.request('/settle', { method: 'POST', body: 'a'.repeat(32769) })).status).toBe(413);
  });
  it('preserves inactive API response and empty support when unconfigured', async () => {
    const app = x402Routes();
    expect((await app.request('/settle', { method: 'POST' })).status).toBe(501);
    expect(await (await app.request('/supported')).json()).toEqual({ kinds: [], networks: [], extensions: [], signers: {} });
    expect((await app.request('/health')).status).toBe(503);
  });
});
