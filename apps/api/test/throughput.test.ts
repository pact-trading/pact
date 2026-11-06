import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, keccak256, type Hex } from 'viem';
import { FakeChain, escrowAbi } from '../src/chain.js';
import { Relayer, allowedTargets, callKey, expectedGas, routerGasPrior, transactionGas } from '../src/relayer.js';
import { intentTypedData } from '../src/typed-data.js';
import { gasCost } from '../src/approval-chain.js';
import { openDb, seedMerchant } from '../src/db.js';
import { deliverWebhooks, enqueueWebhook, WEBHOOK_MAX_ATTEMPTS, WEBHOOK_RETRY_SECONDS } from '../src/webhooks.js';
import { startBackgroundJobs } from '../src/background.js';
import { Indexer } from '../src/indexer.js';
import type { IntentRequest } from '../src/types.js';

const signer = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const addresses = { router: '0x0000000000000000000000000000000000000001', escrow: '0x0000000000000000000000000000000000000002', subscription: '0x0000000000000000000000000000000000000003' } as const;
async function request(nonce: bigint, merchant: Hex = signer.address): Promise<IntentRequest> {
  const data = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [`0x${nonce.toString(16).padStart(64, '0')}`, merchant, 1_000_000n, 86400n] });
  const intent = { signer: signer.address, merchant, target: addresses.escrow, dataHash: keccak256(data), amount: 1_000_000n, nonce, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), maxGas: 400_000 };
  return { intent, data, signature: await signer.signTypedData(intentTypedData(intent, addresses.router)) };
}
function fixture(limits: { maxSpendPerMinute?: bigint } = {}) {
  const chain = new FakeChain();
  chain.writer.bind(openDb());
  chain.accepted.set(signer.address.toLowerCase(), 1);
  const relayer = new Relayer(chain, addresses.router, allowedTargets({ escrow: addresses.escrow, subscription: addresses.subscription }), { minAmount: 1_000_000n, maxGas: 1_000_000n, maxGasPrice: 100_000_000_000n, maxSpendPerMinute: limits.maxSpendPerMinute ?? 10n ** 18n });
  return { chain, relayer };
}

describe('admission outside the writer queue', () => {
  it('does not hold other payments behind a slow simulation', async () => {
    const { chain, relayer } = fixture();
    let release!: () => void;
    const slow = new Promise<void>(resolve => { release = resolve; });
    const simulate = chain.simulate.bind(chain);
    vi.spyOn(chain, 'simulate').mockImplementationOnce(async (...args) => { await slow; return simulate(...args); });
    const first = relayer.submit(await request(1n));
    const second = await relayer.submit(await request(2n));
    // The second payment was signed and sent while the first was still simulating.
    expect(second).toMatch(/^0x/);
    expect(chain.sent.map(s => s.request.intent.nonce)).toEqual([2n]);
    release(); await first;
    expect(chain.sent.map(s => [s.request.intent.nonce, s.nonce])).toEqual([[2n, 0], [1n, 1]]);
  });
  it('rechecks budgets inside the queue so concurrent admissions cannot overspend the minute', async () => {
    const first = await request(1n);
    const one = routerGasPrior(first, transactionGas(first)) * new FakeChain().price;
    const { chain, relayer } = fixture({ maxSpendPerMinute: one + one / 2n });
    const results = await Promise.allSettled([relayer.submit(await request(1n)), relayer.submit(await request(2n)), relayer.submit(await request(3n))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason.code)).toEqual(['circuit_budget', 'circuit_budget']);
    expect(chain.sent).toHaveLength(1);
  });
});

describe('circuit breaker', () => {
  it('is not tripped by Pact\'s own budget refusals, so a busy minute never pauses the merchant', async () => {
    const first = await request(1n);
    const one = routerGasPrior(first, transactionGas(first)) * new FakeChain().price;
    const { relayer } = fixture({ maxSpendPerMinute: one });
    await relayer.submit(first);
    for (let n = 2n; n <= 5n; n++) await expect(relayer.submit(await request(n))).rejects.toMatchObject({ code: 'circuit_budget' });
    expect(relayer.pausedFor(signer.address)).toBe(0);
  });
});

describe('budgeting with measured gas', () => {
  it('uses the gas limit until five calls are measured, then 1.25x their 95th percentile', () => {
    expect(expectedGas([100n, 100n, 100n, 100n], 650_000n)).toBe(650_000n);
    expect(expectedGas([200_000n, 210_000n, 220_000n, 230_000n, 300_000n], 650_000n)).toBe(375_000n);
    expect(expectedGas(Array(50).fill(600_000n), 650_000n)).toBe(650_000n);
  });
  it('admits a payment whose fee covers measured gas though not the unmeasured prior', async () => {
    const { chain, relayer } = fixture();
    const value = await request(1n);
    const limit = routerGasPrior(value, transactionGas(value));
    // A WBT price at which the 0.15 USDT minimum fee is below 1.2x the prior but above 1.2x the measured gas.
    chain.policy.usdtPerWbt = 140_000n * 10n ** 18n / (limit * chain.price);
    await expect(relayer.submit(value)).rejects.toMatchObject({ code: 'fee_below_gas' });
    const db = (chain.writer as unknown as { db: ReturnType<typeof openDb> }).db;
    for (let n = 0; n < 5; n++) db.prepare("INSERT INTO relayer_operations(operation_id,kind,object_id,links_json,chain_id,relayer,phase,created_at,updated_at,gas_used,call_key,receipt_status) VALUES (?,'intent','x','{}',1874,?,'confirmed',?,?,?,?,'success')")
      .run(`measured_${n}`, chain.writer.relayer.toLowerCase(), new Date().toISOString(), new Date().toISOString(), String(limit / 3n), callKey(addresses.escrow, value.data));
    await relayer.submit(await request(2n));
    expect(chain.sent).toHaveLength(1);
  });
  it('counts the OP Stack L1 data fee and operator fee in what a write cost', () => {
    expect(gasCost({ gasUsed: 100_000n, effectiveGasPrice: 5_000_000_000n })).toEqual({ gasCostWei: 500_000_000_000_000n, gasUsed: 100_000n });
    const receipt = { gasUsed: 100_000n, effectiveGasPrice: 5_000_000_000n, l1Fee: '0x5f90', operatorFeeScalar: '0x2', operatorFeeConstant: '0x10' };
    expect(gasCost(receipt)).toEqual({ gasCostWei: 500_000_000_000_000n + 0x5f90n + 100_000n * 2n / 1_000_000n + 0x10n, gasUsed: 100_000n });
  });
});

describe('webhook retries', () => {
  it('retries for about three days before giving up', async () => {
    const total = WEBHOOK_RETRY_SECONDS.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(3 * 86_400); expect(total).toBeLessThan(4 * 86_400);
    const db = openDb();
    const { merchantId } = seedMerchant(db, signer.address, { webhookUrl: 'https://merchant.invalid/hook', webhookSecret: 'whsec' });
    enqueueWebhook(db, merchantId, 'payment.captured', 'pay_1');
    const down = vi.fn(async () => new Response('', { status: 503 }));
    let at = Date.now();
    for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
      expect(await deliverWebhooks(db, down as unknown as typeof fetch, new Date(at))).toBe(1);
      at += 1000 * (WEBHOOK_RETRY_SECONDS[attempt - 1] ?? 0) + 1;
    }
    expect(db.prepare('SELECT status,attempt FROM webhook_deliveries').get()).toEqual({ status: 'failed', attempt: WEBHOOK_MAX_ATTEMPTS });
  });
});

describe('background kicks', () => {
  it('runs a kicked job at once, and a kick during a run right after it, never in parallel', async () => {
    let running = 0, maxRunning = 0, runs = 0, finish!: () => void;
    const job = vi.fn(async () => { running++; maxRunning = Math.max(maxRunning, running); runs++; if (runs === 1) await new Promise<void>(r => { finish = r; }); running--; });
    const jobs = startBackgroundJobs([{ name: 'indexer', intervalMs: 3_600_000, run: job }], () => {});
    jobs.kick('indexer');
    await vi.waitFor(() => expect(runs).toBe(1));
    jobs.kick('indexer'); jobs.kick('indexer');
    finish();
    await vi.waitFor(() => expect(runs).toBe(2));
    await new Promise(r => setTimeout(r, 20));
    expect(runs).toBe(2); expect(maxRunning).toBe(1);
    jobs();
  });
});

describe('indexer log windows', () => {
  it('halves its block window when the RPC refuses the range, and still covers every block', async () => {
    const chain = new FakeChain();
    const db = openDb(); chain.writer.bind(db);
    chain.block = 5_000n;
    const ranges: Array<[bigint, bigint]> = [];
    vi.spyOn(chain, 'events').mockImplementation(async (from, to) => {
      if (to - from + 1n > 1_000n) throw new Error('query exceeds max block range 1000');
      ranges.push([from, to]); return [];
    });
    await new Indexer(db, chain, 0n, 1n).poll();
    expect(ranges[0]).toEqual([0n, 999n]);
    expect(ranges.at(-1)![1]).toBe(4_999n);
    for (let i = 1; i < ranges.length; i++) expect(ranges[i][0]).toBe(ranges[i - 1][1] + 1n);
  });
});
