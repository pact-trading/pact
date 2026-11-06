#!/usr/bin/env node
// Fault scenarios against a stack of its own (`live.mjs --no-web --chaos --restart-api` in
// .runtime/chaos, on other ports). Each scenario drives real checkouts, injects one fault and checks
// invariants through the API, the chain and the API's SQLite database (read-only). Prints PASS/FAIL
// with evidence. Several are expected to FAIL on the pre-v3 code: they are acceptance tests.
//   pnpm chaos all
//   pnpm chaos restart-mid-broadcast dropped-broadcast reorg rpc-storm webhook-outage concurrency
// Each scenario gets a fresh stack (a failed scenario can leave the relayer stuck); --shared runs all
// of them on one stack, --reuse keeps the previous state.
// Flags: --shared --reuse --keep --price-minor 40000000 --outage-seconds 300
//   --webhook-wait-seconds 600 --storm-seconds 60 --payments 200 --merchants 20 --customers 40
//   --json (write .runtime/chaos-results/<time>.json)
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Pact, pool, until, viem } from './lib/pact.mjs';
import { flags, loadDefault, root, rpc, sleep } from './lib/workspace.mjs';

const f = flags();
const ALL = ['restart-mid-broadcast', 'dropped-broadcast', 'reorg', 'rpc-storm', 'webhook-outage', 'concurrency'];
const wanted = f._.length === 0 || f._.includes('all') ? ALL : f._;
for (const name of wanted) if (!ALL.includes(name)) throw new Error(`Unknown scenario ${name}. Known: ${ALL.join(', ')}`);
const ports = { chain: Number(process.env.CHAOS_CHAIN_PORT ?? 28545), api: Number(process.env.CHAOS_API_PORT ?? 23001), web: Number(process.env.CHAOS_WEB_PORT ?? 23000), hook: Number(process.env.CHAOS_HOOK_PORT ?? 23999) };
ports.proxy = ports.chain + 100;
const runtimeDir = process.env.CHAOS_RUNTIME_DIR ?? '.runtime/chaos';
const runtime = resolve(root, runtimeDir);
const urls = { api: `http://127.0.0.1:${ports.api}`, rpc: `http://127.0.0.1:${ports.chain}`, proxy: `http://127.0.0.1:${ports.proxy}` };
const PRICE = String(f['price-minor'] ?? '40000000');
const log = (...m) => console.info('[chaos]', ...m);
// Refusals a customer would answer by trying again (each retry is a new checkout session).
const RETRYABLE = new Set(['approval_budget', 'circuit_budget', 'merchant_circuit_budget', 'circuit_open', 'relayer_pending', 'payment_pending', 'approval_pending', 'preparation_failed', 'approval_failed']);

// ---- the stack
let stack;
/** Settings a scenario needs from its stack: the reorg test runs the ledger at `safe`, the real-money setting. */
const SCENARIO_ENV = { reorg: { PACT_FINALITY: 'safe' } };
let scenarioEnv = {};
async function startStack(reset = !f.reuse) {
  log(`starting stack in ${runtimeDir} (chain ${ports.chain}, proxy ${ports.proxy}, API ${ports.api})`);
  const env = { ...process.env, ...scenarioEnv, LIVE_RUNTIME_DIR: runtimeDir, LIVE_CHAIN_PORT: String(ports.chain), LIVE_API_PORT: String(ports.api), LIVE_WEB_PORT: String(ports.web), LIVE_PROXY_PORT: String(ports.proxy), WHITECHAIN_RPC: process.env.WHITECHAIN_RPC ?? 'https://rpc.ankr.com/whitechain_testnet' };
  stack = spawn(process.execPath, [resolve(root, 'scripts/live.mjs'), '--no-web', '--chaos', '--restart-api', ...(reset ? ['--reset'] : [])], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  stack.stdout.on('data', d => { output += d; });
  stack.stderr.on('data', d => { output += d; });
  const exited = new Promise(ok => stack.once('exit', ok));
  const ready = until(async () => (await fetch(`${urls.api}/health`)).ok && (await fetch(`${urls.proxy}/__chaos/health`)).ok, 600, 'stack');
  await Promise.race([ready, exited.then(code => { throw new Error(`stack exited (${code}):\n${output.slice(-3000)}`); })]);
  pact.net = undefined; // a fresh stack has a fresh deployment
}
async function stopStack() {
  if (!stack || stack.exitCode !== null) return;
  const exited = new Promise(ok => stack.once('exit', ok));
  stack.kill('SIGINT');
  await Promise.race([exited, sleep(15_000)]);
  if (stack.exitCode === null) stack.kill('SIGKILL');
  await sleep(1000);
}
process.on('SIGINT', () => { stack?.kill('SIGINT'); process.exit(130); });
const apiPid = () => Number(readFileSync(resolve(runtime, 'api.pid'), 'utf8'));
const apiHealthy = async () => { try { return (await fetch(`${urls.api}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
let Database;
const db = () => new Database(resolve(runtime, 'api.sqlite'), { readonly: true, fileMustExist: true });
const deployment = () => JSON.parse(readFileSync(resolve(runtime, 'deployment.json'), 'utf8'));
const escrowAbi = () => JSON.parse(readFileSync(resolve(root, 'contracts/out/PaymentEscrow.sol/PaymentEscrow.json'), 'utf8')).abi;

const pact = new Pact(urls);
const resetChaos = () => pact.chaos('/reset?config=1', {});
/** On-chain Charged events for one payment id. */
async function chargedEvents(paymentId) {
  const abi = escrowAbi();
  const event = abi.find(e => e.type === 'event' && e.name === 'Charged');
  const logs = await pact.public.getLogs({ address: deployment().contracts.escrow, event, args: { id: paymentId }, fromBlock: BigInt(deployment().deploymentBlock), toBlock: 'latest' });
  return logs;
}
/** A checkout that retries refusals a real customer would retry (budgets, a busy relayer). */
async function checkoutRetrying(customer, productId, options = {}, attempts = 20) {
  let record;
  for (let i = 0; i < attempts; i++) {
    record = await pact.checkout(customer, productId, options);
    if (record.outcome === 'paid' || !RETRYABLE.has(record.reason)) return { ...record, attempts: i + 1 };
    await sleep(3000 + i * 1000);
  }
  return { ...record, attempts };
}
const relayerNonces = async () => {
  const relayer = deployment().accounts.relayer;
  const [latest, pending] = await Promise.all([rpc(urls.rpc, 'eth_getTransactionCount', [relayer, 'latest']), rpc(urls.rpc, 'eth_getTransactionCount', [relayer, 'pending'])]);
  return { latest: Number(latest), pending: Number(pending) };
};

// ---- scenarios: each returns { pass, evidence }
const scenarios = {
  async 'restart-mid-broadcast'() {
    const merchant = await pact.merchant({ priceMinor: PRICE, permits: false });
    const customer = await pact.customer({ usdt: Number(PRICE) / 1e6 + 2 });
    const prepared = await pact.checkout(customer, merchant.productId, { submit: false });
    if (prepared.outcome !== 'prepared') return { pass: false, evidence: { stage: 'prepare', prepared } };
    await pact.chaos('', { methodLatencyMs: { eth_sendRawTransaction: 5000 } });
    await pact.chaos('/reset', {});
    const killedPid = apiPid();
    const submitting = pact.call(`${prepared.request.base}/intent`, { token: customer.token, body: prepared.request.body }).then(r => ({ ok: r }), e => ({ error: e.message }));
    // The charge broadcast is in flight once the proxy holds its eth_sendRawTransaction.
    await until(async () => ((await pact.chaos('/stats')).byMethod.eth_sendRawTransaction ?? 0) >= 1, 60, 'broadcast in flight');
    process.kill(killedPid, 'SIGKILL');
    const killedAt = new Date().toISOString();
    const response = await submitting;
    await sleep(5500); // the held broadcast reaches the chain
    await pact.chaos('', { methodLatencyMs: {} });
    await until(async () => (await apiHealthy()) && apiPid() !== killedPid, 120, 'API restart');
    const record = await pact.waitPaid(customer, prepared, { timeoutMs: 120_000 });
    // Paid is shown at `confirmed`; the journal and ledger settle a block or more later. Wait for that.
    await until(async () => { const d = db(); try { return d.prepare("SELECT count(*) n FROM relayer_operations WHERE phase IN ('signed','broadcasting','uncertain')").get().n === 0; } finally { d.close(); } }, 60, 'journal settled').catch(() => {});
    const events = await chargedEvents(prepared.paymentId);
    const d = db();
    const intents = d.prepare("SELECT id,status,reason,tx_hash FROM intents WHERE request_json LIKE ?").all(`%${prepared.paymentId.slice(2)}%`);
    const ops = intents.length ? d.prepare(`SELECT operation_id,phase,nonce,tx_hash,reason FROM relayer_operations WHERE operation_id IN (${intents.map(() => '?').join(',')})`).all(...intents.map(i => i.id)) : [];
    const stuck = d.prepare("SELECT count(*) n FROM relayer_operations WHERE phase IN ('signed','broadcasting','uncertain')").get().n;
    d.close();
    const pass = record.outcome === 'paid' && events.length === 1 && intents.filter(i => i.tx_hash).length === 1 && stuck === 0;
    return { pass, evidence: { killedAt, submitResponse: response.error ? `request failed: ${response.error.slice(0, 120)}` : response.ok, outcome: record.outcome, reason: record.reason, chargedEventsOnChain: events.length, intents, operations: ops, opsStillInFlight: stuck } };
  },

  async 'dropped-broadcast'() {
    const merchant = await pact.merchant({ priceMinor: PRICE, permits: false });
    const [a, b] = await Promise.all([pact.customer({ usdt: Number(PRICE) / 1e6 + 2 }), pact.customer({ usdt: Number(PRICE) / 1e6 + 2 })]);
    const prepared = await pact.checkout(a, merchant.productId, { submit: false });
    if (prepared.outcome !== 'prepared') return { pass: false, evidence: { stage: 'prepare', prepared } };
    await pact.chaos('/reset', {});
    await pact.chaos('', { dropSendRate: 1 });
    let submitted;
    try { submitted = await pact.call(`${prepared.request.base}/intent`, { token: a.token, body: prepared.request.body }); }
    finally { await pact.chaos('', { dropSendRate: 0 }); }
    const dropped = (await pact.chaos('/stats')).dropped;
    const before = await relayerNonces();
    const [first, second] = await Promise.all([
      pact.waitPaid(a, { ...prepared, chargeTx: submitted?.txHash }, { timeoutMs: 120_000 }),
      pact.checkout(b, merchant.productId, { timeoutMs: 120_000 }),
    ]);
    const after = await relayerNonces();
    const lostReceipt = submitted?.txHash ? await pact.receipt(submitted.txHash) : null;
    const pass = first.outcome === 'paid' && second.outcome === 'paid';
    // Heal by hand (what an operator would do): send the lost bytes straight to the chain, then see
    // whether everything behind them completes on its own.
    let healed = null;
    if (!pass && dropped.length) {
      for (const d of dropped) await rpc(urls.rpc, 'eth_sendRawTransaction', [d.raw]).catch(() => null);
      const a2 = await pact.waitPaid(a, { ...prepared, chargeTx: submitted?.txHash }, { timeoutMs: 60_000 });
      healed = { paymentA: a2.outcome, relayerNonces: await relayerNonces() };
    }
    return { pass, evidence: { droppedBroadcasts: dropped.map(d => d.hash), apiAnswered: submitted, droppedTxMined: !!lostReceipt, paymentA: `${first.outcome}${first.reason ? ` (${first.reason})` : ''}`, paymentB: `${second.outcome}${second.reason ? ` (${second.reason})` : ''}`, paymentBStage: second.ms, relayerNonceAfterDrop: before, relayerNonceAtEnd: after, afterManualRebroadcast: healed } };
  },

  async reorg() {
    const merchant = await pact.merchant({ priceMinor: PRICE, permits: false });
    const customer = await pact.customer({ usdt: Number(PRICE) / 1e6 + 2 });
    // A reorg must take the state with the blocks. Anvil 1.5.1's anvil_reorg removes the blocks and logs but
    // keeps contract storage (so a re-included transaction runs against state that should be gone), so the
    // reorg is a snapshot taken before the payment and reverted after it, then replacement blocks.
    const snapshot = await rpc(urls.rpc, 'evm_snapshot', []);
    const record = await pact.checkout(customer, merchant.productId);
    if (record.outcome !== 'paid') return { pass: false, evidence: { stage: 'payment', record } };
    const receipt = await pact.receipt(record.chargeTx);
    const raw = await rpc(urls.rpc, 'eth_getRawTransactionByHash', [record.chargeTx]);
    const head = Number(await rpc(urls.rpc, 'eth_blockNumber'));
    const txBlock = Number(BigInt(receipt.blockNumber));
    const snapshotHead = head; // for the evidence: how far the chain is rewound
    await rpc(urls.rpc, 'evm_revert', [snapshot]);
    const depth = snapshotHead - Number(await rpc(urls.rpc, 'eth_blockNumber'));
    await rpc(urls.rpc, 'anvil_mine', ['0x' + Math.max(1, depth).toString(16)]);
    const goneOnChain = !(await pact.receipt(record.chargeTx));
    await sleep(8000);
    const ledger = () => { const d = db(); try { return d.prepare("SELECT event_id,kind,amount_minor,fee_minor,tx_hash,block_number FROM accounting_entries WHERE lower(object_id)=lower(?)").all(record.paymentId); } finally { d.close(); } };
    const view = await pact.call(`/v1/commerce/checkout-sessions/${record.sessionId}`, { token: customer.token });
    const afterReorg = { orderStatus: view.order.status, sessionStatus: view.session.status, ledger: ledger() };
    // The API must not keep money state (paid, ledger entries) for a block that no longer holds the
    // transaction. The watchdog may already have re-included it (then paid at its new block is right).
    const nowOnChain = await pact.receipt(record.chargeTx);
    const nowBlock = nowOnChain ? BigInt(nowOnChain.blockNumber) : null;
    afterReorg.reincludedBeforeCheck = nowBlock === null ? null : Number(nowBlock);
    const staleLedger = afterReorg.ledger.some(e => e.tx_hash.toLowerCase() === record.chargeTx.toLowerCase() && (nowBlock === null || BigInt(e.block_number) !== nowBlock));
    const stalePaid = afterReorg.orderStatus === 'paid' && nowBlock === null;
    // Re-include the same signed transaction; the payment must settle once, at its new block.
    // A sequencer usually re-includes a reorged transaction itself (Anvil does too): that is re-inclusion as well.
    await rpc(urls.rpc, 'eth_sendRawTransaction', [raw]).catch(error => { if (!/nonce too low|already known|known transaction/i.test(String(error))) throw error; });
    await until(async () => !!(await pact.receipt(record.chargeTx)), 30, 're-inclusion');
    const again = await pact.receipt(record.chargeTx);
    await sleep(8000);
    const finalView = await pact.call(`/v1/commerce/checkout-sessions/${record.sessionId}`, { token: customer.token });
    const finalLedger = ledger();
    const reincludedOk = finalView.order.status === 'paid' && finalLedger.filter(e => e.kind === 'Payment').length === 1 && finalLedger.every(e => BigInt(e.block_number) === BigInt(again.blockNumber) || e.kind !== 'Payment');
    const pass = goneOnChain && !staleLedger && !stalePaid && reincludedOk;
    return { pass, evidence: { txHash: record.chargeTx, originalBlock: txBlock, reorgDepth: depth, droppedFromChain: goneOnChain, afterReorg, staleLedgerEntryForDroppedTx: staleLedger, stillShownPaid: stalePaid, reincludedBlock: Number(BigInt(again.blockNumber)), finalOrderStatus: finalView.order.status, finalLedger } };
  },

  async 'rpc-storm'() {
    const seconds = Number(f['storm-seconds'] ?? 60);
    const merchant = await pact.merchant({ priceMinor: PRICE, permits: false });
    const customers = await pool(Array.from({ length: 5 }), 3, () => pact.customer({ usdt: Number(PRICE) / 1e6 + 2 }));
    await pact.chaos('/reset', {});
    await pact.chaos('', { rate429: 0.3, latencyMs: 500 });
    const calm = sleep(seconds * 1000).then(() => pact.chaos('', { rate429: 0, latencyMs: 0 }));
    const records = await Promise.all(customers.map(c => pact.checkout(c, merchant.productId, { timeoutMs: seconds * 1000 + 120_000 })));
    await calm;
    const stats = await pact.chaos('/stats');
    const failed = records.filter(r => r.outcome !== 'paid');
    return { pass: failed.length === 0, evidence: { stormSeconds: seconds, injected429: stats.faults.rate429, paid: records.length - failed.length, failed: failed.map(r => ({ outcome: r.outcome, reason: r.reason, lastStage: Object.keys(r.ms).filter(k => k !== 'total').pop() ?? 'session', failedAfterMs: r.ms.total, duringStorm: (r.ms.total ?? 0) < seconds * 1000 })) } };
  },

  async 'webhook-outage'() {
    const outage = Number(f['outage-seconds'] ?? 300), wait = Number(f['webhook-wait-seconds'] ?? 600);
    const received = [];
    let outageUntil = Date.now() + outage * 1000;
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', c => { body += c; });
      request.on('end', () => {
        const down = Date.now() < outageUntil;
        let event = {};
        try { event = JSON.parse(body); } catch {}
        received.push({ at: new Date().toISOString(), type: event.type, objectId: event.object_id, attempt: event.attempt, answered: down ? 500 : 200 });
        response.writeHead(down ? 500 : 200).end(down ? 'down' : 'ok');
      });
    });
    await new Promise(ok => server.listen(ports.hook, '127.0.0.1', ok));
    try {
      const merchant = await pact.merchant({ priceMinor: PRICE, permits: false });
      await pact.webhook(merchant, `http://127.0.0.1:${ports.hook}/hook`);
      outageUntil = Date.now() + outage * 1000;
      const customer = await pact.customer({ usdt: Number(PRICE) / 1e6 + 2 });
      const record = await pact.checkout(customer, merchant.productId);
      log(`webhook-outage: payment ${record.outcome}; endpoint down until ${new Date(outageUntil).toISOString()}, then waiting up to ${wait}s`);
      const delivered = () => received.some(r => r.type === 'payment.captured' && r.answered === 200 && r.objectId?.toLowerCase() === record.paymentId?.toLowerCase());
      try { await until(async () => Date.now() > outageUntil && delivered(), outage + wait, 'delivery'); } catch {}
      const d = db();
      const rows = d.prepare("SELECT e.type,d.status,d.attempt,d.last_http_status,d.next_at,d.delivered_at FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.merchant_id=? ORDER BY e.created_at").all(merchant.merchantId);
      d.close();
      const captured = received.filter(r => r.type === 'payment.captured');
      return { pass: record.outcome === 'paid' && delivered(), evidence: { outageSeconds: outage, waitedUpToSeconds: wait, payment: record.outcome, capturedAttempts: captured.length, firstAttempt: captured[0]?.at, lastAttempt: captured.at(-1)?.at, deliveredAfterOutage: delivered(), deliveries: rows } };
    } finally { server.close(); }
  },

  async concurrency() {
    const payments = Number(f.payments ?? 200), merchantCount = Number(f.merchants ?? 20), customerCount = Number(f.customers ?? 40);
    log(`concurrency: setting up ${merchantCount} merchants, ${customerCount} customers`);
    const merchants = await pool(Array.from({ length: merchantCount }), 5, () => pact.merchant({ priceMinor: PRICE, permits: false }));
    const perCustomer = Math.ceil(payments / customerCount);
    const customers = await pool(Array.from({ length: customerCount }), 5, () => pact.customer({ usdt: perCustomer * (Number(PRICE) / 1e6) + 2 }));
    // Each customer gets exactly its share (and the USDT for it), and pays one checkout at a time.
    const queues = customers.map(() => []);
    for (let i = 0; i < payments; i++) queues[i % customerCount].push(i);
    const started = Date.now();
    const records = new Array(payments);
    await pool(queues.map((queue, c) => ({ queue, customer: customers[c] })), customerCount, async ({ queue, customer }) => {
      for (const i of queue) records[i] = { ...(await checkoutRetrying(customer, merchants[i % merchantCount].productId)), merchant: merchants[i % merchantCount].address };
    });
    const wallSeconds = Math.round((Date.now() - started) / 1000);
    const paid = records.filter(r => r.outcome === 'paid');
    // Paid is shown at `confirmed`; the ledger is written at the configured finality, a block or more later.
    await until(async () => { const d = db(); try { return paid.every(r => d.prepare("SELECT 1 FROM accounting_entries WHERE lower(object_id)=lower(?) AND kind='Payment'").get(r.paymentId)); } finally { d.close(); } }, 60, 'ledger settled').catch(() => {});
    // Ledger vs chain, per payment.
    const abi = escrowAbi();
    const d = db();
    const mismatches = [];
    for (const r of paid) {
      const receipt = await pact.receipt(r.chargeTx);
      const charged = receipt?.logs.map(l => { try { return viem.decodeEventLog({ abi, data: l.data, topics: l.topics }); } catch { return null; } }).find(e => e?.eventName === 'Charged' && e.args.id.toLowerCase() === r.paymentId.toLowerCase());
      const entry = d.prepare("SELECT amount_minor,fee_minor FROM accounting_entries WHERE lower(object_id)=lower(?) AND kind='Payment'").all(r.paymentId);
      if (!charged || entry.length !== 1 || BigInt(entry[0].amount_minor) !== charged.args.amount || BigInt(entry[0].fee_minor) !== charged.args.fee) mismatches.push({ paymentId: r.paymentId, onChain: charged ? { amount: String(charged.args.amount), fee: String(charged.args.fee) } : null, ledger: entry });
    }
    const duplicateNonces = d.prepare("SELECT nonce,count(*) n FROM relayer_operations WHERE nonce IS NOT NULL AND phase!='not_sent' GROUP BY relayer,nonce HAVING n>1").all();
    const inFlight = d.prepare("SELECT phase,count(*) n FROM relayer_operations WHERE phase IN ('signed','broadcasting','uncertain','submitted') GROUP BY phase").all();
    const unminedWithHash = [];
    for (const op of d.prepare("SELECT operation_id,tx_hash FROM relayer_operations WHERE tx_hash IS NOT NULL AND phase!='not_sent' AND created_at>=?").all(new Date(started).toISOString())) {
      if (!(await pact.receipt(op.tx_hash))) unminedWithHash.push(op.operation_id);
    }
    d.close();
    const nonces = await relayerNonces();
    const reasons = records.filter(r => r.outcome !== 'paid').reduce((m, r) => ({ ...m, [`${r.outcome}:${r.reason}`]: (m[`${r.outcome}:${r.reason}`] ?? 0) + 1 }), {});
    const retried = records.filter(r => r.attempts > 1).length;
    const pass = paid.length === payments && mismatches.length === 0 && duplicateNonces.length === 0 && unminedWithHash.length === 0 && nonces.latest === nonces.pending;
    return { pass, evidence: { payments, paid: paid.length, wallSeconds, throughputPerMinute: +(paid.length / (wallSeconds / 60)).toFixed(1), retriedAfterRefusal: retried, failureReasons: reasons, ledgerMismatches: mismatches.slice(0, 5), ledgerMismatchCount: mismatches.length, duplicateNonces, journalStillInFlight: inFlight, sentButNotMined: unminedWithHash.length, relayerNonces: nonces } };
  },
};

// ---- run
Database = await loadDefault('better-sqlite3');
mkdirSync(runtime, { recursive: true });
if (f.shared) await startStack();
const results = [];
try {
  for (const name of wanted) {
    if (!f.shared) {
      await stopStack();
      scenarioEnv = SCENARIO_ENV[name] ?? {};
      try { await startStack(); }
      catch (error) { results.push({ scenario: name, pass: false, seconds: 0, evidence: { error: `stack did not start: ${String(error.message).slice(0, 400)}` } }); continue; }
    }
    log(`▶ ${name}`);
    await resetChaos();
    const started = Date.now();
    let result;
    try { result = await scenarios[name](); }
    catch (error) { result = { pass: false, evidence: { error: String(error?.stack ?? error).split('\n').slice(0, 4).join(' | ') } }; }
    await resetChaos().catch(() => {});
    result = { scenario: name, seconds: Math.round((Date.now() - started) / 1000), ...result };
    results.push(result);
    console.info(`${result.pass ? 'PASS' : 'FAIL'} ${name} (${result.seconds}s)\n${JSON.stringify(result.evidence, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)}\n`);
  }
} finally {
  // --keep leaves the last stack running, for tracing what a scenario left behind.
  if (!f.keep) await stopStack();
}
console.info('Summary');
for (const r of results) console.info(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.scenario}`);
if (f.json) {
  // Outside the stack's runtime directory: the next fresh stack wipes that.
  const dir = resolve(root, '.runtime/chaos-results');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, `${JSON.stringify(results, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)}\n`);
  console.info(`Results: ${file}`);
}
await sleep(2000);
process.exit(results.every(r => r.pass) ? 0 : 1);
