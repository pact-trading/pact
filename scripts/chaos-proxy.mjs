#!/usr/bin/env node
// JSON-RPC fault injector between the API and a local chain node, over HTTP (single and batch
// requests) and WebSocket. It also counts every call by method, which is how the bench measures
// "RPC calls per payment".
//   node scripts/chaos-proxy.mjs --upstream http://127.0.0.1:8545 --port 8645
// Control (same port):
//   GET  /__chaos          current config
//   POST /__chaos          merge config, e.g. {"latencyMs":500,"rate429":0.3}
//   GET  /__chaos/stats    calls by method, injected faults, dropped broadcasts since the last reset
//   POST /__chaos/reset    reset stats (add ?config=1 to reset the config too)
// Config: latencyMs, jitterMs, methodLatencyMs {method: ms}, rate429 (HTTP 429 with Retry-After: 1),
// timeoutRate (no answer, then the socket closes after timeoutMs), dropSendRate (eth_sendRawTransaction
// is answered with keccak256(raw) and never forwarded: a lost broadcast), blocklist [methods],
// gasPriceFloorWei (eth_gasPrice answers are raised to it; live.mjs passes the emulated base-fee floor).
import { createServer } from 'node:http';
import { flags, load, loadWs } from './lib/workspace.mjs';

const args = flags();
const upstream = String(args.upstream ?? process.env.CHAOS_UPSTREAM ?? 'http://127.0.0.1:8545');
const port = Number(args.port ?? process.env.CHAOS_PORT ?? 8645);
const host = String(args.host ?? '127.0.0.1');
const upstreamWs = upstream.replace(/^http/, 'ws');
const { keccak256 } = await load('viem');
const { WebSocketServer, WebSocket } = await loadWs();

const DEFAULTS = { latencyMs: 0, jitterMs: 0, methodLatencyMs: {}, rate429: 0, timeoutRate: 0, timeoutMs: 30_000, dropSendRate: 0, blocklist: [], gasPriceFloorWei: String(args['gas-price-floor'] ?? process.env.CHAOS_GAS_PRICE_FLOOR ?? '0') };
let config = structuredClone(DEFAULTS);
let stats;
const resetStats = () => {
  stats = { since: new Date().toISOString(), httpRequests: 0, calls: 0, byMethod: {}, faults: { rate429: 0, timeout: 0, dropped: 0, blocked: 0 }, dropped: [], ws: { connections: 0, calls: 0 } };
};
resetStats();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chance = rate => rate > 0 && Math.random() < rate;
const count = method => { stats.calls++; stats.byMethod[method] = (stats.byMethod[method] ?? 0) + 1; };
const delayFor = methods => (config.latencyMs || 0) + Math.random() * (config.jitterMs || 0) + Math.max(0, ...methods.map(m => Number(config.methodLatencyMs?.[m] ?? 0)));
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
/** Raises an eth_gasPrice answer to the configured floor. */
const clamp = (method, answer) => {
  const floor = BigInt(config.gasPriceFloorWei || 0);
  if (method !== 'eth_gasPrice' || floor === 0n || typeof answer?.result !== 'string') return answer;
  return BigInt(answer.result) < floor ? { ...answer, result: `0x${floor.toString(16)}` } : answer;
};

/** Applies per-call faults. Returns [answered items by index, items to forward]. */
function perCall(items) {
  const answered = new Map(), forward = [];
  items.forEach((item, index) => {
    if (config.blocklist?.includes(item.method)) { stats.faults.blocked++; answered.set(index, rpcError(item.id, -32601, `method ${item.method} blocked by chaos proxy`)); return; }
    if (item.method === 'eth_sendRawTransaction' && chance(config.dropSendRate)) {
      const hash = keccak256(item.params[0]);
      stats.faults.dropped++; stats.dropped.push({ hash, raw: item.params[0], at: new Date().toISOString() });
      answered.set(index, { jsonrpc: '2.0', id: item.id, result: hash });
      return;
    }
    forward.push({ index, item });
  });
  return { answered, forward };
}
async function forwardHttp(items) {
  if (!items.length) return [];
  const body = items.length === 1 ? items[0] : items;
  const response = await fetch(upstream, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const json = await response.json();
  const list = Array.isArray(json) ? json : [json];
  // Match by id; a node may reorder batch answers.
  return items.map((item, i) => list.find(r => r && r.id === item.id && item.id !== undefined) ?? list[i] ?? rpcError(item.id, -32603, 'no upstream answer'));
}
const readBody = request => new Promise((ok, fail) => {
  const chunks = [];
  request.on('data', c => chunks.push(c));
  request.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
  request.on('error', fail);
});
const send = (response, status, value, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(value));
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}`);
  try {
    if (url.pathname.startsWith('/__chaos')) {
      if (url.pathname === '/__chaos/health') return send(response, 200, { ok: true, upstream });
      if (url.pathname === '/__chaos/stats') return send(response, 200, stats);
      if (url.pathname === '/__chaos/reset' && request.method === 'POST') {
        if (url.searchParams.get('config') === '1') config = structuredClone(DEFAULTS);
        resetStats();
        return send(response, 200, { ok: true, config });
      }
      if (url.pathname === '/__chaos' && request.method === 'POST') {
        const patch = JSON.parse((await readBody(request)) || '{}');
        config = { ...config, ...patch };
        return send(response, 200, config);
      }
      if (url.pathname === '/__chaos') return send(response, 200, config);
      return send(response, 404, { error: 'unknown control path' });
    }
    if (request.method !== 'POST') return send(response, 405, { error: 'JSON-RPC over POST only' });
    const raw = await readBody(request);
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return send(response, 400, rpcError(null, -32700, 'parse error')); }
    const batch = Array.isArray(parsed);
    const items = batch ? parsed : [parsed];
    stats.httpRequests++;
    for (const item of items) count(item?.method ?? 'invalid');
    if (chance(config.rate429)) {
      stats.faults.rate429++;
      return send(response, 429, batch ? items.map(i => rpcError(i.id, -32005, 'rate limited (chaos)')) : rpcError(items[0].id, -32005, 'rate limited (chaos)'), { 'retry-after': '1' });
    }
    if (chance(config.timeoutRate)) {
      stats.faults.timeout++;
      await sleep(config.timeoutMs ?? 30_000);
      request.socket.destroy();
      return;
    }
    const delay = delayFor(items.map(i => i.method));
    if (delay > 0) await sleep(delay);
    const { answered, forward } = perCall(items);
    let forwarded = [];
    try { forwarded = await forwardHttp(forward.map(f => f.item)); }
    catch (error) { return send(response, 502, rpcError(items[0]?.id, -32603, `upstream unavailable: ${error.message}`)); }
    forward.forEach((f, i) => answered.set(f.index, clamp(f.item.method, forwarded[i])));
    const out = items.map((_, index) => answered.get(index));
    return send(response, 200, batch ? out : out[0]);
  } catch (error) {
    return send(response, 500, rpcError(null, -32603, `chaos proxy error: ${error.message}`));
  }
});

// WebSocket: each client gets its own upstream socket. Requests take the configured latency;
// subscription notifications take half of it (one way).
const wss = new WebSocketServer({ server });
wss.on('connection', client => {
  stats.ws.connections++;
  const up = new WebSocket(upstreamWs);
  const queue = [];
  const gasPriceIds = new Set();
  const toUpstream = data => (up.readyState === WebSocket.OPEN ? up.send(data) : queue.push(data));
  up.on('open', () => { while (queue.length) up.send(queue.shift()); });
  up.on('message', async data => {
    const half = (config.latencyMs || 0) / 2;
    if (half > 0) await sleep(half);
    let text = data.toString();
    if (gasPriceIds.size) {
      try {
        const parsed = JSON.parse(text);
        const fix = m => (m && gasPriceIds.delete(m.id) ? clamp('eth_gasPrice', m) : m);
        text = JSON.stringify(Array.isArray(parsed) ? parsed.map(fix) : fix(parsed));
      } catch {}
    }
    if (client.readyState === WebSocket.OPEN) client.send(text);
  });
  up.on('close', () => client.close());
  up.on('error', () => client.close());
  client.on('close', () => up.close());
  client.on('message', async data => {
    let parsed;
    try { parsed = JSON.parse(data.toString()); } catch { return; }
    const batch = Array.isArray(parsed);
    const items = batch ? parsed : [parsed];
    for (const item of items) { count(item?.method ?? 'invalid'); stats.ws.calls++; }
    const reply = value => client.readyState === WebSocket.OPEN && client.send(JSON.stringify(value));
    if (chance(config.rate429)) { stats.faults.rate429++; return reply(batch ? items.map(i => rpcError(i.id, -32005, 'rate limited (chaos)')) : rpcError(items[0].id, -32005, 'rate limited (chaos)')); }
    if (chance(config.timeoutRate)) { stats.faults.timeout++; return; }
    const delay = Math.max(0, delayFor(items.map(i => i.method)) - (config.latencyMs || 0) / 2);
    if (delay > 0) await sleep(delay);
    const { answered, forward } = perCall(items);
    for (const f of forward) if (f.item.method === 'eth_gasPrice') gasPriceIds.add(f.item.id);
    if (!batch) {
      if (answered.size) return reply(answered.get(0));
      return toUpstream(JSON.stringify(items[0]));
    }
    // Batches over WebSocket: answer the faulted items here, forward the rest as one batch.
    if (answered.size) reply([...answered.values()]);
    if (forward.length) toUpstream(JSON.stringify(forward.map(f => f.item)));
  });
});

server.listen(port, host, () => console.info(`[chaos] http://${host}:${port} → ${upstream} (ws ${upstreamWs})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); process.exit(0); });
