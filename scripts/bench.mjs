#!/usr/bin/env node
// Checkout benchmark against a running local stack (`pnpm live --no-web`, ideally with --chaos so RPC
// calls are counted and latency can be injected). Sets up merchants and funded test customers through
// the API, then runs concurrent product checkouts exactly as the web does and reports per-stage
// latency, throughput, RPC calls per payment and gas per payment.
//   pnpm bench -- --merchants 3 --customers 10 --concurrency 10 --payments 50 [--latency-ms 500]
// Flags: --api URL --rpc URL (the chain, never the proxy) --proxy URL (chaos proxy; default: probe
// chain port + 100) --price-minor 40000000 --idle-seconds 10 --label NAME --skip-permits --json-only
//   --client web|fast (web: poll like the web app, 1 s, session + readiness; fast: session only, 250 ms)
// The default price is 40 USDT: at Whitechain's 5 gwei floor the pre-v3 relayer refuses smaller
// checkouts (fee_below_gas, see docs/benchmarks.md).
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem, platform, release as osRelease } from 'node:os';
import { resolve } from 'node:path';
import { Pact, pool, signable } from './lib/pact.mjs';
import { flags, percentile, root, sleep } from './lib/workspace.mjs';

const f = flags();
const chainPort = Number(process.env.LIVE_CHAIN_PORT ?? 8545);
const urls = {
  api: String(f.api ?? process.env.BENCH_API ?? `http://127.0.0.1:${process.env.LIVE_API_PORT ?? 3001}`),
  rpc: String(f.rpc ?? process.env.BENCH_RPC ?? `http://127.0.0.1:${chainPort}`),
  proxy: f.proxy === false ? undefined : String(f.proxy ?? process.env.BENCH_PROXY ?? `http://127.0.0.1:${Number(process.env.LIVE_PROXY_PORT ?? chainPort + 100)}`),
};
const config = {
  merchants: Number(f.merchants ?? 3), customers: Number(f.customers ?? 10), concurrency: Number(f.concurrency ?? 10),
  payments: Number(f.payments ?? 50), latencyMs: f['latency-ms'] === undefined ? null : Number(f['latency-ms']),
  priceMinor: String(f['price-minor'] ?? '40000000'), client: f.client === 'fast' ? 'fast' : 'web', idleSeconds: Number(f['idle-seconds'] ?? 10), permits: !f['skip-permits'],
  label: String(f.label ?? 'bench'),
};
if (config.concurrency > config.customers) throw new Error('--concurrency cannot exceed --customers: one payer has one checkout in flight at a time');
const log = (...m) => { if (!f['json-only']) console.info('[bench]', ...m); };

const pact = new Pact(urls);
await pact.call('/health');
if (urls.proxy) {
  try { await pact.chaos('/health'); } catch { urls.proxy = undefined; }
}
if (config.latencyMs !== null && !urls.proxy) throw new Error('--latency-ms needs the chaos proxy (start the stack with pnpm live --chaos)');
log(`api ${urls.api}  chain ${urls.rpc}  proxy ${urls.proxy ?? 'none (RPC calls not counted)'}`);

// 1. Setup (not measured): merchants with signed fee terms and a product; funded customers.
const setupStart = performance.now();
const perCustomer = Math.ceil(config.payments / config.customers);
if (perCustomer > 40) log(`warning: ${perCustomer} payments per customer exceeds the Router's 40 per payer per day`);
const fund = Math.ceil((perCustomer * Number(config.priceMinor)) / 1e6) + 2;
log(`setting up ${config.merchants} merchants and ${config.customers} customers (${fund} USDT each)`);
const merchants = await pool(Array.from({ length: config.merchants }), 4, () => pact.merchant({ priceMinor: config.priceMinor, permits: config.permits }));
const customers = await pool(Array.from({ length: config.customers }), 4, () => pact.customer({ usdt: fund }));
const setupMs = Math.round(performance.now() - setupStart);
log(`setup done in ${(setupMs / 1000).toFixed(1)}s`);

// 2. Idle RPC rate: what the background jobs cost with no payments in flight.
let idle = null;
if (urls.proxy) {
  await pact.chaos('/reset', {});
  await sleep(config.idleSeconds * 1000);
  const s = await pact.chaos('/stats');
  idle = { seconds: config.idleSeconds, callsPerSecond: +(s.calls / config.idleSeconds).toFixed(2), byMethodPerSecond: Object.fromEntries(Object.entries(s.byMethod).map(([m, n]) => [m, +(n / config.idleSeconds).toFixed(2)])) };
  log(`idle: ${idle.callsPerSecond} RPC calls/s`);
}

// 3. Measured run.
let previousChaos = null;
if (config.latencyMs !== null) {
  previousChaos = await pact.chaos();
  await pact.chaos('', { latencyMs: config.latencyMs });
  log(`injected ${config.latencyMs} ms RPC latency`);
}
if (urls.proxy) await pact.chaos('/reset', {});
// Each customer gets exactly its share of the payments (it was funded for that many) and pays them one
// after another; up to `concurrency` customers pay at the same time.
const queues = customers.map(() => []);
for (let i = 0; i < config.payments; i++) queues[i % customers.length].push(i);
log(`running ${config.payments} checkouts, ${config.concurrency} at a time`);
const runStart = performance.now();
const records = new Array(config.payments);
await pool(queues.map((queue, c) => ({ queue, customer: customers[c] })), config.concurrency, async ({ queue, customer }) => {
  for (const i of queue) {
    const merchant = merchants[i % merchants.length];
    const record = await pact.checkout(customer, merchant.productId, { client: config.client });
    record.merchant = merchant.address;
    if (!f['json-only']) process.stdout.write(record.outcome === 'paid' ? '.' : 'x');
    records[i] = record;
  }
});
const wallMs = Math.round(performance.now() - runStart);
if (!f['json-only']) process.stdout.write('\n');
const stats = urls.proxy ? await pact.chaos('/stats') : null;
if (previousChaos) await pact.chaos('', { latencyMs: previousChaos.latencyMs ?? 0 });

// 4. Gas, from the receipts (read from the chain directly, not counted).
for (const r of records) {
  for (const [field, hash] of [['approval', r.approvalTx], ['charge', r.chargeTx]]) {
    const receipt = await pact.receipt(hash);
    if (receipt) r[`${field}Gas`] = { gasUsed: Number(BigInt(receipt.gasUsed)), costWei: (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)).toString(), status: receipt.status };
  }
}

// 4b. Endpoint profile: RPC calls made inside each checkout request, for one fresh payment on a quiet
// system (after the next minute boundary, so the relayer's per-minute budgets have reset).
let endpoints = null;
if (urls.proxy && !f['no-profile']) {
  log('profiling one checkout request by request');
  await sleep(60_000 - (Date.now() % 60_000) + 1000);
  endpoints = {};
  const merchant = merchants[0];
  const customer = await pact.customer({ usdt: Number(config.priceMinor) / 1e6 + 2 });
  const measure = async (name, fn) => {
    await pact.chaos('/reset', {});
    const t = performance.now();
    const value = await fn();
    const ms = performance.now() - t;
    const s = await pact.chaos('/stats');
    endpoints[name] = { calls: s.calls, netOfIdle: +Math.max(0, s.calls - (idle ? (idle.callsPerSecond * ms) / 1000 : 0)).toFixed(1), ms: Math.round(ms), byMethod: s.byMethod };
    return value;
  };
  const created = await pact.call('/v1/commerce/checkout-sessions', { token: customer.token, body: { productId: merchant.productId, rail: 'whitechain' }, headers: { 'idempotency-key': `profile-${Date.now()}` } });
  const base = `/v1/commerce/checkout-sessions/${encodeURIComponent(created.session.id)}`;
  let readiness = await measure('GET readiness', () => pact.call(`${base}/readiness`, { token: customer.token }));
  if (readiness.status === 'needs_approval') {
    const signature = await customer.account.signTypedData(signable(readiness.typedData));
    await measure('POST approval (permit relay)', () => pact.call(`${base}/approval`, { token: customer.token, body: { deadline: readiness.deadline, signature, ...(readiness.permitNonce !== null ? { nonce: readiness.permitNonce } : {}) } }));
    for (let i = 0; i < 120 && readiness.status !== 'ready'; i++) { await sleep(500); readiness = await pact.call(`${base}/readiness`, { token: customer.token }); }
  }
  const request = await measure('GET intent', () => pact.call(`${base}/intent`, { token: customer.token }));
  const signature = await customer.account.signTypedData(signable(request.typedData));
  await measure('POST intent (relayer submit)', () => pact.call(`${base}/intent`, { token: customer.token, body: { data: request.data, intent: request.intent, signature } }));
  await pact.waitPaid(customer, { sessionId: created.session.id, ms: {} }, { client: 'fast' });
  await measure('GET session (status poll)', () => pact.call(base, { token: customer.token }));
}

// 5. Aggregate.
const paid = records.filter(r => r.outcome === 'paid');
const dist = values => { const v = values.filter(x => Number.isFinite(x)); return v.length ? { n: v.length, p50: percentile(v, 50), p95: percentile(v, 95), max: Math.max(...v) } : null; };
const stage = {
  prepare: dist(paid.map(r => r.ms.signed)),
  approval: dist(paid.filter(r => r.ms.approvalReady !== undefined).map(r => r.ms.approvalReady - r.ms.created)),
  submitResponse: dist(paid.map(r => r.ms.submitted - r.ms.signed)),
  submitToPaid: dist(paid.map(r => r.ms.paid - r.ms.signed)),
  total: dist(paid.map(r => r.ms.paid)),
};
const avg = values => values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null;
const gas = {
  approvalGas: avg(paid.filter(r => r.approvalGas).map(r => r.approvalGas.gasUsed)),
  chargeGas: avg(paid.filter(r => r.chargeGas).map(r => r.chargeGas.gasUsed)),
  approvalsPerPayment: paid.length ? +(paid.filter(r => r.approvalTx).length / paid.length).toFixed(2) : null,
  txPerPayment: paid.length ? +(paid.reduce((n, r) => n + (r.approvalTx ? 1 : 0) + (r.chargeTx ? 1 : 0), 0) / paid.length).toFixed(2) : null,
  costWeiPerPayment: paid.length ? (paid.reduce((n, r) => n + BigInt(r.approvalGas?.costWei ?? 0) + BigInt(r.chargeGas?.costWei ?? 0), 0n) / BigInt(paid.length)).toString() : null,
};
let rpcCalls = null;
if (stats) {
  const seconds = wallMs / 1000;
  const background = idle ? idle.callsPerSecond * seconds : 0;
  const byMethod = Object.entries(stats.byMethod).sort((a, b) => b[1] - a[1]);
  rpcCalls = {
    total: stats.calls, httpRequests: stats.httpRequests,
    perPayment: paid.length ? +(stats.calls / paid.length).toFixed(1) : null,
    perPaymentNetOfIdle: paid.length ? +(Math.max(0, stats.calls - background) / paid.length).toFixed(1) : null,
    byMethodPerPayment: Object.fromEntries(byMethod.map(([m, n]) => [m, paid.length ? +(n / paid.length).toFixed(2) : n])),
  };
}
const failures = records.filter(r => r.outcome !== 'paid');
const result = {
  label: config.label, startedAt: new Date(Date.now() - wallMs).toISOString(),
  machine: { cpu: cpus()[0]?.model, cores: cpus().length, memoryGb: Math.round(totalmem() / 2 ** 30), platform: `${platform()} ${osRelease()}`, node: process.version },
  urls, config, setupMs, idle,
  run: { wallMs, payments: records.length, paid: paid.length, failed: failures.length, throughputPerSecond: +(paid.length / (wallMs / 1000)).toFixed(3), failureReasons: Object.fromEntries(Object.entries(failures.reduce((m, r) => ({ ...m, [`${r.outcome}:${r.reason}`]: (m[`${r.outcome}:${r.reason}`] ?? 0) + 1 }), {}))) },
  stage, rpc: rpcCalls, endpoints, gas, payments: records,
};
const dir = resolve(root, '.runtime/bench/results');
mkdirSync(dir, { recursive: true });
const file = resolve(dir, `${result.startedAt.replace(/[:.]/g, '-')}-${config.label}.json`);
writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);

const fmt = d => (d ? `${d.p50} / ${d.p95} / ${d.max}` : '—');
const table = [
  `### ${config.label}: ${config.payments} checkouts of ${Number(config.priceMinor) / 1e6} USDT, ${config.merchants} merchants, ${config.customers} customers, concurrency ${config.concurrency}, injected RPC latency ${config.latencyMs ?? 0} ms, ${config.client} client`,
  '',
  '| Metric | Value |',
  '| --- | --- |',
  `| Paid / failed | ${paid.length} / ${failures.length}${failures.length ? ` (${Object.entries(result.run.failureReasons).map(([k, v]) => `${k} ×${v}`).join(', ')})` : ''} |`,
  `| Wall time | ${(wallMs / 1000).toFixed(1)} s |`,
  `| Throughput | ${result.run.throughputPerSecond} payments/s (${(result.run.throughputPerSecond * 60).toFixed(1)}/min) |`,
  `| Prepare (session → signed, incl. permit) p50 / p95 / max | ${fmt(stage.prepare)} ms |`,
  `| Permit (submitted → ready) p50 / p95 / max | ${fmt(stage.approval)} ms |`,
  `| Submit → API response p50 / p95 / max | ${fmt(stage.submitResponse)} ms |`,
  `| Submit → paid p50 / p95 / max | ${fmt(stage.submitToPaid)} ms |`,
  `| Total (session → paid) p50 / p95 / max | ${fmt(stage.total)} ms |`,
  `| Transactions per payment | ${gas.txPerPayment ?? '—'} (permits ${gas.approvalsPerPayment ?? '—'}) |`,
  `| Gas: permit / charge | ${gas.approvalGas ?? '—'} / ${gas.chargeGas ?? '—'} |`,
  `| Relayer cost per payment | ${gas.costWeiPerPayment ? `${(Number(gas.costWeiPerPayment) / 1e18).toFixed(6)} WBT` : '—'} |`,
  `| RPC calls per payment (gross / net of idle) | ${rpcCalls ? `${rpcCalls.perPayment} / ${rpcCalls.perPaymentNetOfIdle}` : 'not counted'} |`,
  `| Idle background RPC | ${idle ? `${idle.callsPerSecond} calls/s` : '—'} |`,
  '',
  rpcCalls ? `Top RPC methods per payment: ${Object.entries(rpcCalls.byMethodPerPayment).slice(0, 8).map(([m, n]) => `${m} ${n}`).join(', ')}` : '',
  ...(endpoints ? ['', '| Request (one payment, quiet system) | RPC calls | Time | Methods |', '| --- | --- | --- | --- |',
    ...Object.entries(endpoints).map(([name, e]) => `| ${name} | ${e.calls} | ${e.ms} ms | ${Object.entries(e.byMethod).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} ${n}`).join(', ')} |`), ''] : []),
  `Results: ${file}`,
].join('\n');
console.info(table);
