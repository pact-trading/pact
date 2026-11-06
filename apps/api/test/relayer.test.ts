import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, keccak256, parseTransaction, type Hex } from 'viem';
import { FakeChain, escrowAbi, ViemChain } from '../src/chain.js';
import { Relayer, allowedTargets, routerGasPrior, transactionGas } from '../src/relayer.js';
import { intentTypedData } from '../src/typed-data.js';
import type { IntentRequest } from '../src/types.js';
const key = `0x${'1'.repeat(64)}` as Hex;
const signer = privateKeyToAccount(key);
const addresses = { router: '0x0000000000000000000000000000000000000001', escrow: '0x0000000000000000000000000000000000000002', subscription: '0x0000000000000000000000000000000000000003', fees: '0x0000000000000000000000000000000000000004' } as const;
async function request(nonce = 1n, maxGas = 400_000): Promise<IntentRequest> {
  const data = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [`0x${'a'.repeat(64)}`, signer.address, 1_000_000n, 86400n] });
  const intent = { signer: signer.address, merchant: signer.address, target: addresses.escrow, dataHash: keccak256(data), amount: 1_000_000n, nonce, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), maxGas };
  return { intent, data, signature: await signer.signTypedData(intentTypedData(intent, addresses.router)) };
}
function fixture(maxSpendPerMinute = 10n ** 16n) {
  const chain = new FakeChain();
  chain.accepted.set(String(signer.address.toLowerCase()).toLowerCase(), 1);
  const relayer = new Relayer(chain, addresses.router, allowedTargets({ escrow: addresses.escrow, subscription: addresses.subscription }), { minAmount: 1_000_000n, maxGas: 1_000_000n, maxGasPrice: 100_000_000_000n, maxSpendPerMinute });
  return { chain, relayer };
}
describe('Router transaction gas', () => {
  it('does not send the cheap successful estimate of a nonreverting refusal', async () => {
    const { chain, relayer } = fixture();
    chain.simulation = { accepted: true, gas: 48_000n };
    const simulation = vi.spyOn(chain, 'simulate');
    await relayer.submit(await request());
    expect(chain.sent[0].gas).toBeGreaterThan(480_000n);
    expect(simulation.mock.calls[0]).toEqual([chain.sent[0].request, { gas: chain.sent[0].gas, gasPrice: chain.price }]);
  });
  it('accounts for the whole target allowance plus Router overhead in the minute budget', async () => {
    const value = await request();
    const { chain, relayer } = fixture((routerGasPrior(value, transactionGas(value)) - 1n) * 1_000_000_000n);
    await expect(relayer.submit(value)).rejects.toMatchObject({ code: 'circuit_budget' });
    expect(chain.sent).toHaveLength(0);
  });
  it('permits target gas at its limit plus bounded Router overhead', async () => {
    const { chain, relayer } = fixture();
    await relayer.submit(await request(1n, 1_000_000));
    expect(chain.sent[0].gas).toBeGreaterThan(1_080_000n);
    expect(chain.sent[0].gas).toBeLessThanOrEqual(1_400_000n);
  });
  it('rejects exact-gas refusals without broadcasting or consuming a nonce', async () => {
    const { chain, relayer } = fixture();
    chain.simulation = { accepted: false, reason: 'Router refused intent', gas: 48_000n };
    const value = await request();
    await expect(relayer.submit(value)).rejects.toMatchObject({ code: 'simulation_refused' });
    expect(chain.sent).toHaveLength(0);
    chain.simulation.accepted = true;
    await relayer.submit(value);
    expect(chain.sent[0].nonce).toBe(0);
  });
  it('serializes concurrent requests so duplicates cannot spend twice', async () => {
    const { chain, relayer } = fixture();
    const value = await request();
    const results = await Promise.allSettled([relayer.submit(value), relayer.submit(value)]);
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(chain.sent).toHaveLength(1);
  });
});

describe('Viem exact transaction simulation', () => {
  it('uses identical explicit gas and gas price for eth_call and the signed transaction, without estimation', async () => {
    const adapter = new ViemChain('http://unused.invalid', key, addresses);
    const simulateContract = vi.fn().mockResolvedValue({ result: [true, '0x'] });
    const estimateContractGas = vi.fn().mockResolvedValue(45_000n);
    const writeContract = vi.fn().mockResolvedValue(`0x${'a'.repeat(64)}`);
    Object.assign(adapter, { public: { simulateContract, estimateContractGas }, wallet: { writeContract } });
    const value = await request();
    const transaction = { gas: 660_000n, gasPrice: 5_001_000_000n };
    // EIP-1559: a fee cap of twice the gas price (headroom against a rising base fee) and the tip.
    const fees = { maxFeePerGas: 10_002_000_000n, maxPriorityFeePerGas: 1_000_000n };
    expect(await adapter.simulate(value, transaction)).toMatchObject({ accepted: true, gas: transaction.gas });
    const prepared = await adapter.prepareIntent(value, transaction.gas, 7, transaction.gasPrice);
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({ gas: transaction.gas, ...fees }));
    expect(parseTransaction(prepared.raw)).toMatchObject({ type: 'eip1559', gas: transaction.gas, ...fees, nonce: 7 });
    expect(writeContract).not.toHaveBeenCalled();
    expect(estimateContractGas).not.toHaveBeenCalled();
    simulateContract.mockResolvedValueOnce({ result: [false, '0x'] });
    expect(await adapter.simulate(value, transaction)).toMatchObject({ accepted: false });
    simulateContract.mockRejectedValueOnce(new Error('out of gas'));
    expect(await adapter.simulate(value, transaction)).toMatchObject({ accepted: false, reason: 'out of gas' });
  });
  it('refuses a retry of an ambiguous broadcast, but not other payments, which take the next nonce', async () => {
    const { chain, relayer } = fixture();
    vi.spyOn(chain, 'broadcastTransaction').mockRejectedValueOnce(new Error('RPC rejected'));
    const value = await request();
    const hash = await relayer.submit(value);
    expect(hash).toMatch(/^0x/);
    await expect(relayer.submit(value)).rejects.toMatchObject({ code: 'replay' });
    expect(chain.sent).toHaveLength(0);
    await relayer.submit(await request(2n));
    expect(chain.sent.map(s => [s.request.intent.nonce, s.nonce])).toEqual([[2n, 1]]);
    // The ambiguous one keeps nonce 0 and its exact signed bytes, which the watchdog resends.
    expect(chain.writer.unsettled().map(r => [r.nonce, r.tx_hash, r.phase])[0]).toEqual([0, hash, 'uncertain']);
  });
  it('checks that the fee covers the whole target allowance and Router overhead, not just the target', async () => {
    const { chain, relayer } = fixture();
    const value = await request();
    // A WBT price at which the 0.15 USDT fee covers the 400,000 target gas, but not with the Router overhead.
    const gas = routerGasPrior(value, transactionGas(value)), usdtPerWbt = 130_000n * 10n ** 9n / gas;
    expect(400_000n * usdtPerWbt * chain.price / 10n ** 18n * 12n).toBeLessThan(150_000n * 10n);
    chain.policy.usdtPerWbt = usdtPerWbt;
    await expect(relayer.submit(value)).rejects.toMatchObject({ code: 'fee_below_gas' });
    expect(chain.sent).toHaveLength(0);
  });
});
describe('per-merchant sponsorship limits', () => {
  const merchants = { a: '0x00000000000000000000000000000000000000aa', b: '0x00000000000000000000000000000000000000bb' } as const;
  async function requestFor(merchant: Hex, nonce: bigint): Promise<IntentRequest> {
    const data = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [`0x${nonce.toString(16).padStart(64, '0')}`, merchant, 1_000_000n, 86400n] });
    const intent = { signer: signer.address, merchant, target: addresses.escrow, dataHash: keccak256(data), amount: 1_000_000n, nonce, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), maxGas: 400_000 };
    return { intent, data, signature: await signer.signTypedData(intentTypedData(intent, addresses.router)) };
  }
  function twoMerchants(limits: Partial<{ maxSpendPerMinute: bigint; maxSpendPerMerchantPerMinute: bigint }> = {}) {
    const chain = new FakeChain();
    for (const m of Object.values(merchants)) chain.accepted.set(m.toLowerCase(), 1);
    const relayer = new Relayer(chain, addresses.router, allowedTargets({ escrow: addresses.escrow, subscription: addresses.subscription }), { minAmount: 1_000_000n, maxGas: 1_000_000n, maxGasPrice: 100_000_000_000n, maxSpendPerMinute: 10n ** 17n, ...limits });
    const refusals: string[] = [];
    relayer.onRefusal = (r, refusal) => refusals.push(`${r.intent.merchant}:${refusal.code}`);
    return { chain, relayer, refusals };
  }
  it('pauses only the merchant whose calls keep failing', async () => {
    const { chain, relayer } = twoMerchants();
    chain.simulation = { accepted: false, reason: 'Router refused intent', gas: 48_000n };
    for (let n = 1n; n <= 3n; n++) await expect(relayer.submit(await requestFor(merchants.a, n))).rejects.toMatchObject({ code: 'simulation_refused' });
    chain.simulation = { accepted: true, gas: 300_000n };
    await expect(relayer.submit(await requestFor(merchants.a, 4n))).rejects.toMatchObject({ code: 'circuit_open' });
    expect(relayer.pausedFor(merchants.a)).toBeGreaterThan(0);
    expect(relayer.pausedFor(merchants.b)).toBe(0);
    await relayer.submit(await requestFor(merchants.b, 5n));
    expect(chain.sent).toHaveLength(1);
  });
  it('caps one merchant per minute below the global ceiling', async () => {
    const first = await requestFor(merchants.a, 1n);
    const oneCall = routerGasPrior(first, transactionGas(first)) * new FakeChain().price;
    const { chain, relayer } = twoMerchants({ maxSpendPerMerchantPerMinute: oneCall + oneCall / 2n });
    await relayer.submit(first);
    await expect(relayer.submit(await requestFor(merchants.a, 2n))).rejects.toMatchObject({ code: 'merchant_circuit_budget' });
    await relayer.submit(await requestFor(merchants.b, 3n));
    expect(chain.sent.map(s => s.request.intent.merchant)).toEqual([merchants.a, merchants.b]);
  });
  it('reports every refusal before broadcast to the hook', async () => {
    const { relayer, refusals } = twoMerchants();
    const tampered = await requestFor(merchants.a, 1n);
    tampered.data = `${tampered.data.slice(0, -2)}00` as Hex;
    await expect(relayer.submit(tampered)).rejects.toMatchObject({ code: 'data_hash' });
    const stale = await requestFor(merchants.b, 2n);
    stale.intent.deadline = 1n;
    await expect(relayer.submit(stale)).rejects.toMatchObject({ code: 'deadline' });
    expect(refusals).toEqual([`${merchants.a}:data_hash`, `${merchants.b}:deadline`]);
  });
});
