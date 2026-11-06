#!/usr/bin/env node
// Local live stack: an Anvil fork of Whitechain Sepolia, a fresh contract suite, the API with its
// relayer, keeper and indexer, and a production build of the web app in API mode.
//   pnpm live               → http://localhost:3000
//   pnpm live --reset       → wipe the local chain state, contracts and database first
//   pnpm live --no-build    → reuse the last web build
//   pnpm live --no-web      → chain and API only
// Everything lives in .runtime/live. Only Anvil's public development keys are used.
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
const rpcUrl = `http://127.0.0.1:${CHAIN_PORT}`;
const webOrigin = `http://localhost:${WEB_PORT}`;
const files = {
  fork: resolve(runtime, 'fork.json'),
  state: resolve(runtime, 'anvil-state.json'),
  deployment: resolve(runtime, 'deployment.json'),
  db: resolve(runtime, 'api.sqlite'),
  anvilLog: resolve(runtime, 'anvil.log'),
  apiLog: resolve(runtime, 'api.log'),
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
  setTimeout(() => process.exit(code), 1500).unref();
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
  const latest = BigInt(await rpc(REMOTE_RPC, 'eth_blockNumber'));
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
    '--hardfork', 'prague',
    '--block-time', '1',
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
  RPC_URL: rpcUrl,
  RELAYER_PRIVATE_KEY: deployment.keys.relayer,
  ROUTER_ADDRESS: deployment.contracts.router,
  ESCROW_ADDRESS: deployment.contracts.escrow,
  SUBSCRIPTION_ADDRESS: deployment.contracts.subscription,
  GAS_TANK_ADDRESS: deployment.contracts.gasTank,
  SUBSCRIPTION_VERSION: '1',
  RENEWALS: 'keeper',
  DEPLOYMENT_BLOCK: deployment.deploymentBlock,
  CONFIRMATIONS: '1',
  RELAYER_MIN_AMOUNT_MINOR: '1000000',
  // About 25 sponsored calls a minute in total, and 8 per merchant, at Whitechain's 5 gwei floor.
  RELAYER_MAX_SPEND_PER_MINUTE_WEI: '100000000000000000',
  RELAYER_MAX_SPEND_PER_MERCHANT_PER_MINUTE_WEI: '30000000000000000',
  CHECKOUT_APPROVAL_ENABLED: 'true',
  SPONSORED_APPROVER_RUNTIME_HASH: deployment.sponsoredApproverRuntimeHash,
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
const apiProcess = spawn('pnpm', ['exec', 'tsx', 'src/server.ts'], { cwd: api, env: apiEnv, stdio: ['ignore', apiOut, apiOut] });
children.push(apiProcess);
apiProcess.once('exit', code => {
  if (!stopping) fail(`API exited with code ${code}; see ${files.apiLog}`);
});
await waitFor(async () => (await fetch(`http://127.0.0.1:${API_PORT}/health`)).ok, 'API', 60);

// 4. Web: production build in API mode, then next start.
if (args.has('--no-web')) {
  console.info(`\nPact live: chain ${rpcUrl}, API http://127.0.0.1:${API_PORT}. Press Ctrl+C to stop.\n`);
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
