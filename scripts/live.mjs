#!/usr/bin/env node
// Local live stack: an Anvil fork of Whitechain Sepolia, a fresh contract suite, the API with its
// relayer, keeper and indexer, and a production build of the web app in API mode.
//   pnpm live               → http://localhost:3000
//   pnpm live --reset       → wipe the local chain state, contracts and database first
//   pnpm live --no-build    → reuse the last web build
//   pnpm live --no-web      → chain and API only
//   pnpm live --chaos       → put scripts/chaos-proxy.mjs between the API and the chain (fault injection, RPC counts)
//   pnpm live --restart-api → restart the API when it exits (crash tests); also LIVE_RESTART_API=1
// Everything lives in .runtime/live. Only Anvil's public development keys are used.
// Chain fidelity (see docs/benchmarks.md): Osaka EVM so P256VERIFY (0x100) exists as on Whitechain,
// `safe`/`finalized` trail latest by LIVE_EPOCH_SLOTS / twice that, Anvil's 1 gwei minimum tip is off
// (Whitechain suggests 0.001 gwei), and with --chaos the base fee is held at Whitechain's 5 gwei floor
// (LIVE_BASE_FEE_FLOOR_WEI; set it to use the floor without --chaos, 0 to turn it off).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// LIVE_RUNTIME_DIR runs a second, isolated stack (with other ports), e.g. for scripted checks that move
// the fork's clock, without touching the usual one.
const runtime = resolve(root, process.env.LIVE_RUNTIME_DIR ?? '.runtime/live');
const api = resolve(root, 'apps/api');
const web = resolve(root, 'apps/web');
const args = new Set(process.argv.slice(2));
const REMOTE_RPC = process.env.WHITECHAIN_RPC ?? 'https://rpc.testnet.whitechain.io';
const CHAIN_PORT = Number(process.env.LIVE_CHAIN_PORT ?? 8545);
const API_PORT = Number(process.env.LIVE_API_PORT ?? 3001);
const WEB_PORT = Number(process.env.LIVE_WEB_PORT ?? 3000);
const PROXY_PORT = Number(process.env.LIVE_PROXY_PORT ?? CHAIN_PORT + 100);
const HARDFORK = process.env.LIVE_HARDFORK ?? 'osaka';
const EPOCH_SLOTS = Number(process.env.LIVE_EPOCH_SLOTS ?? 4);
const CHAOS = args.has('--chaos');
// Anvil has no base-fee floor: it is emulated by re-setting each next block's base fee. A quote read in
// the moment after a block and before the reset can be below the next base fee, so the chaos proxy also
// clamps eth_gasPrice to the floor. Without the proxy that race remains: the floor is opt-in there.
const BASE_FEE_FLOOR = BigInt(process.env.LIVE_BASE_FEE_FLOOR_WEI ?? (CHAOS ? '5000000000' : '0'));
const RESTART_API = args.has('--restart-api') || process.env.LIVE_RESTART_API === '1';
const rpcUrl = `http://127.0.0.1:${CHAIN_PORT}`;
// The API reaches the chain through the chaos proxy when --chaos is set; everything else goes direct.
const apiRpcUrl = CHAOS ? `http://127.0.0.1:${PROXY_PORT}` : rpcUrl;
const webOrigin = `http://localhost:${WEB_PORT}`;
/** Anvil development keys #4–#7: extra relayer lanes (the API ignores them until lanes exist). */
const LANE_KEYS = [
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
];
const LANE_ADDRESSES = [
  '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
  '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
];
const files = {
  fork: resolve(runtime, 'fork.json'),
  state: resolve(runtime, 'anvil-state.json'),
  deployment: resolve(runtime, 'deployment.json'),
  db: resolve(runtime, 'api.sqlite'),
  anvilLog: resolve(runtime, 'anvil.log'),
  apiLog: resolve(runtime, 'api.log'),
  proxyLog: resolve(runtime, 'chaos-proxy.log'),
  apiPid: resolve(runtime, 'api.pid'),
};
const children = [];
let stopping = false;
const log = message => console.info(`[live] ${message}`);
const fail = message => {
  console.error(`[live] ${message}`);
  stopAll(1);
};
function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children.reverse()) if (child.exitCode === null) child.kill('SIGINT');
  // Not unref'd: --no-web parks on a never-settling await, and Node would otherwise exit 13 first.
  setTimeout(() => process.exit(code), 1500);
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

/** Reads KEY=value lines; ignores comments and blank values. */
function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match && match[2].trim()) out[match[1]] = match[2].trim();
  }
  return out;
}
const portFree = port =>
  new Promise(ok => {
    const probe = createServer();
    probe.once('error', () => ok(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => ok(true)));
  });
async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}
async function waitFor(check, what, seconds = 60) {
  for (let i = 0; i < seconds * 4; i++) {
    try {
      if (await check()) return;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  fail(`${what} did not start in ${seconds}s`);
}
function run(command, commandArgs, options) {
  const child = spawn(command, commandArgs, { stdio: 'inherit', ...options });
  children.push(child);
  child.once('exit', code => {
    if (!stopping) fail(`${command} exited with code ${code}`);
  });
  return child;
}

if (args.has('--reset')) {
  log(`reset: removing ${runtime}`);
  rmSync(runtime, { recursive: true, force: true });
}
mkdirSync(runtime, { recursive: true });
for (const [name, port] of [
  ['chain', CHAIN_PORT],
  ['API', API_PORT],
  ['web', WEB_PORT],
  ...(CHAOS ? [['chaos proxy', PROXY_PORT]] : []),
])
  if (!(await portFree(port))) fail(`Port ${port} (${name}) is in use. Stop that service first.`);

if (!existsSync(resolve(root, 'contracts/out/Router.sol/Router.json'))) {
  log('building contracts');
  if (spawnSync('forge', ['build'], { cwd: resolve(root, 'contracts'), stdio: 'inherit' }).status !== 0)
    fail('forge build failed');
}

// 1. Chain. The fork block is fixed on first run so saved state always matches it.
let fork = existsSync(files.fork) ? JSON.parse(readFileSync(files.fork, 'utf8')) : null;
if (!fork) {
  let latest;
  for (let attempt = 1; latest === undefined; attempt++) {
    try { latest = BigInt(await rpc(REMOTE_RPC, 'eth_blockNumber')); }
    catch (error) {
      if (attempt >= 4) throw error;
      log(`${REMOTE_RPC} did not answer (${error.cause?.code ?? error.message}); retrying`);
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
  fork = { remoteRpc: REMOTE_RPC, block: (latest - 5n).toString() };
  writeFileSync(files.fork, `${JSON.stringify(fork, null, 2)}\n`);
}
log(`starting Anvil fork of ${fork.remoteRpc} at block ${fork.block}`);
const anvilOut = openSync(files.anvilLog, 'a');
const anvil = spawn(
  'anvil',
  [
    '--host', '127.0.0.1',
    '--port', String(CHAIN_PORT),
    '--fork-url', fork.remoteRpc,
    '--fork-block-number', fork.block,
    '--chain-id', '1874',
    '--hardfork', HARDFORK,
    '--block-time', '1',
    '--slots-in-an-epoch', String(EPOCH_SLOTS),
    // Whitechain suggests a 0.001 gwei tip; Anvil would add a 1 gwei minimum (6 gwei instead of 5.001).
    ...(process.env.LIVE_MIN_PRIORITY_FEE === '1' ? [] : ['--disable-min-priority-fee']),
    '--state', files.state,
    '--state-interval', '15',
  ],
  { stdio: ['ignore', anvilOut, anvilOut] },
);
children.push(anvil);
anvil.once('exit', code => {
  if (!stopping) fail(`anvil exited with code ${code}; see ${files.anvilLog}`);
});
await waitFor(async () => String(await rpc(rpcUrl, 'web3_clientVersion')).includes('anvil'), 'Anvil', 120);
const latest = await rpc(rpcUrl, 'eth_getBlockByNumber', ['latest', false]);
const nowSeconds = Math.floor(Date.now() / 1000);
if (Number(BigInt(latest.timestamp)) < nowSeconds) await rpc(rpcUrl, 'evm_setNextBlockTimestamp', [nowSeconds]);
// Whitechain's base fee sits on a 5 gwei floor; Anvil's would decay 12.5% per empty block toward zero,
// which hides gas budgets. Hold every next block at the floor unless load has pushed it higher.
if (BASE_FEE_FLOOR > 0n) {
  const floor = `0x${BASE_FEE_FLOOR.toString(16)}`;
  const hold = async baseFee => {
    if (BigInt(baseFee ?? 0) <= BASE_FEE_FLOOR) await rpc(rpcUrl, 'anvil_setNextBlockBaseFeePerGas', [floor]);
  };
  // Re-set as soon as each block lands (WebSocket heads), with a polling backstop.
  const subscribe = () => {
    const socket = new WebSocket(rpcUrl.replace(/^http/, 'ws'));
    socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
    socket.onmessage = event => {
      const head = JSON.parse(event.data).params?.result;
      if (head) hold(head.baseFeePerGas).catch(() => {});
    };
    socket.onclose = () => { if (!stopping) setTimeout(subscribe, 1000); };
    socket.onerror = () => {};
  };
  subscribe();
  const timer = setInterval(async () => {
    try { await hold((await rpc(rpcUrl, 'eth_getBlockByNumber', ['latest', false])).baseFeePerGas); } catch {}
  }, 300);
  timer.unref();
  await rpc(rpcUrl, 'anvil_setNextBlockBaseFeePerGas', [floor]);
}

// Chaos proxy: between the API and the chain only (deploy, faucet setup and the web go direct).
if (CHAOS) {
  log(`starting chaos proxy on ${PROXY_PORT} (log: ${files.proxyLog})`);
  const proxyOut = openSync(files.proxyLog, 'a');
  const proxy = spawn(process.execPath, [resolve(root, 'scripts/chaos-proxy.mjs'), '--upstream', rpcUrl, '--port', String(PROXY_PORT), '--gas-price-floor', BASE_FEE_FLOOR.toString()], { stdio: ['ignore', proxyOut, proxyOut] });
  children.push(proxy);
  proxy.once('exit', code => {
    if (!stopping) fail(`chaos proxy exited with code ${code}; see ${files.proxyLog}`);
  });
  await waitFor(async () => (await fetch(`${apiRpcUrl}/__chaos/health`)).ok, 'chaos proxy', 30);
}

// 2. Contracts.
if (!existsSync(files.deployment)) {
  log('deploying a fresh contract suite');
  const deployed = spawnSync('pnpm', ['exec', 'tsx', 'scripts/live/deploy.ts', rpcUrl, files.deployment], {
    cwd: api,
    stdio: 'inherit',
  });
  if (deployed.status !== 0) fail('contract deployment failed');
}
// Invoice financing sits beside the suite: added once, also to a suite deployed before it existed.
if (!JSON.parse(readFileSync(files.deployment, 'utf8')).financing) {
  log('adding invoice financing (InvestorRegistry, InvoiceReceivables)');
  const added = spawnSync('pnpm', ['exec', 'tsx', 'scripts/live/deploy-financing.ts', rpcUrl, files.deployment], {
    cwd: api,
    stdio: 'inherit',
  });
  if (added.status !== 0) fail('financing deployment failed');
}
const deployment = JSON.parse(readFileSync(files.deployment, 'utf8'));
// A suite deployed before contracts v3 (no PasskeyAccountFactory) has the old escrow events and getters,
// which this API no longer reads: payments would not settle. Start over instead of running half-wired.
if (!deployment.contracts?.passkeyFactory) fail(`the saved suite in ${runtime} predates contracts v3; run \`pnpm live --reset\` once to deploy the new suite`);
// Extra relayer lanes hold WBT like the relayer does; nobody else does.
for (const address of LANE_ADDRESSES) {
  if (BigInt(await rpc(rpcUrl, 'eth_getBalance', [address, 'latest'])) < 10n ** 20n)
    await rpc(rpcUrl, 'anvil_setBalance', [address, '0x3635C9ADC5DEA00000']); // 1000 WBT
}

// 3. API with relayer, keeper, indexer and webhooks.
const privy = readEnvFile(resolve(api, '.env.local'));
const apiEnv = {
  ...process.env,
  PORT: String(API_PORT),
  HOST: '127.0.0.1',
  DATABASE_PATH: files.db,
  PUBLIC_BASE_URL: webOrigin,
  PACT_WEB_ORIGIN: webOrigin,
  PACT_LOCAL_FORK: '1',
  CHAIN_ADAPTER: 'viem',
  RPC_URL: apiRpcUrl,
  // Anvil serves WebSocket on the same port; so does the chaos proxy.
  RPC_WS_URL: apiRpcUrl.replace(/^http/, 'ws'),
  // Which head counts as settled: latest (sequencer, about 1 s), safe or finalized.
  PACT_FINALITY: process.env.PACT_FINALITY ?? 'latest',
  RELAYER_PRIVATE_KEY: deployment.keys.relayer,
  RELAYER_LANE_KEYS: LANE_KEYS.join(','),
  // Passkey accounts (P-256 via Anvil osaka's precompile, as on Whitechain) and the Permit2 they pay through.
  ...(deployment.contracts.passkeyFactory ? { PASSKEY_FACTORY_ADDRESS: deployment.contracts.passkeyFactory } : {}),
  ...(deployment.contracts.permit2 ? { PERMIT2_ADDRESS: deployment.contracts.permit2 } : {}),
  ROUTER_ADDRESS: deployment.contracts.router,
  ESCROW_ADDRESS: deployment.contracts.escrow,
  SUBSCRIPTION_ADDRESS: deployment.contracts.subscription,
  FEE_SCHEDULE_ADDRESS: deployment.contracts.fees,
  DEPLOYMENT_BLOCK: deployment.deploymentBlock,
  CONFIRMATIONS: '1',
  RELAYER_MIN_AMOUNT_MINOR: '1000000',
  // About 25 sponsored calls a minute in total, and 8 per merchant, at Whitechain's 5 gwei floor.
  RELAYER_MAX_SPEND_PER_MINUTE_WEI: '100000000000000000',
  RELAYER_MAX_SPEND_PER_MERCHANT_PER_MINUTE_WEI: '30000000000000000',
  ...(deployment.x402
    ? { X402_FACTORY_ADDRESS: deployment.x402.factory, X402_RUNTIME_HASHES: JSON.stringify(deployment.x402.runtimeHashes) }
    : {}),
  RECEIVABLES_ADDRESS: deployment.financing.receivables,
  INVESTOR_REGISTRY_ADDRESS: deployment.financing.registry,
  FINANCING_DEPLOYMENT_BLOCK: deployment.financing.deploymentBlock,
  // Local fork only: the faucet appoints test compliance officers by impersonating the registry owner.
  INVESTOR_REGISTRY_OWNER: deployment.financing.registryOwner,
  ...(privy.PRIVY_APP_ID && privy.PRIVY_APP_SECRET
    ? { PRIVY_APP_ID: privy.PRIVY_APP_ID, PRIVY_APP_SECRET: privy.PRIVY_APP_SECRET }
    : {}),
};
log(`starting API on ${API_PORT} (log: ${files.apiLog})`);
const apiOut = openSync(files.apiLog, 'a');
// Node runs the server itself (tsx as a loader, no wrapper process), so api.pid is the process that
// owns the relayer: killing it is a real crash.
function startApi() {
  const apiProcess = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], { cwd: api, env: apiEnv, stdio: ['ignore', apiOut, apiOut] });
  writeFileSync(files.apiPid, `${apiProcess.pid}\n`);
  children.push(apiProcess);
  apiProcess.once('exit', (code, signal) => {
    if (stopping) return;
    if (!RESTART_API) return fail(`API exited with code ${code ?? signal}; see ${files.apiLog}`);
    log(`API exited (${code ?? signal}); restarting`);
    setTimeout(startApi, 500);
  });
}
startApi();
await waitFor(async () => (await fetch(`http://127.0.0.1:${API_PORT}/health`)).ok, 'API', 60);

// 4. Web: production build in API mode, then next start.
if (args.has('--no-web')) {
  console.info(`\nPact live: chain ${rpcUrl}${CHAOS ? ` (API via chaos proxy ${apiRpcUrl})` : ''}, API http://127.0.0.1:${API_PORT}. Press Ctrl+C to stop.\n`);
  await new Promise(() => {});
}
const next = resolve(web, 'node_modules/next/dist/bin/next');
const webEnv = {
  ...process.env,
  PACT_DATA: 'api',
  PACT_LIVE: '1',
  NEXT_TELEMETRY_DISABLED: '1',
  PACT_API_URL: `http://127.0.0.1:${API_PORT}`,
  PACT_PUBLIC_ORIGIN: webOrigin,
  PACT_CHAIN_RPC_URL: rpcUrl,
  PACT_LOCAL_FORK: '1',
  NEXT_PUBLIC_PACT_LOCAL_FORK: '1',
  NEXT_PUBLIC_PRIVY_APP_ID: privy.PRIVY_APP_ID ?? '',
  NEXT_PUBLIC_PRIVY_CLIENT_ID: privy.PRIVY_CLIENT_ID ?? '',
};
if (!args.has('--no-build') || !existsSync(resolve(web, '.next-live'))) {
  log('building the web app (production build, API mode)');
  if (spawnSync(process.execPath, [next, 'build'], { cwd: web, env: webEnv, stdio: 'inherit' }).status !== 0)
    fail('web build failed');
}
run(process.execPath, [next, 'start', '--hostname', 'localhost', '--port', String(WEB_PORT)], { cwd: web, env: webEnv });
await waitFor(async () => (await fetch(`${webOrigin}/`)).status < 500, 'web', 60);
console.info(`
Pact live (local fork of Whitechain Sepolia)
  Web    ${webOrigin}
  API    http://127.0.0.1:${API_PORT}
  Chain  ${rpcUrl} (chain id 1874)
  State  ${runtime}
Press Ctrl+C to stop. State is kept; run with --reset to start over.
`);
