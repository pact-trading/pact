// Provision an isolated local runtime. Writes credentials only to ignored files with mode 0600.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { join } from 'node:path';
import { openDb, seedMerchant } from '../src/db.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const runtime = join(root, 'apps/api/.runtime/whitechain-v2');
mkdirSync(runtime, { recursive: true, mode: 0o700 }); chmodSync(runtime, 0o700);
const configPath = join(runtime, 'runtime.json');
assert(!existsSync(configPath), 'Runtime already exists; reuse its credentials and database');
const deployment = JSON.parse(readFileSync(join(root, 'contracts/deployment.json'), 'utf8'));
assert.equal(deployment.status, 'verified_deployed_not_activated');
const wallet = parseEnv(readFileSync(join(root, '.env.wallets'), 'utf8'));
assert(wallet.RELAYER_PRIVATE_KEY, 'Missing relayer key');
assert(wallet.DEPLOYER_PRIVATE_KEY, 'Missing merchant key');
const database = join(runtime, 'settle.sqlite');
assert(!existsSync(database), 'Refusing to overwrite a database');
const db = openDb(database);
const credentials = seedMerchant(db, deployment.deployer);
db.close(); chmodSync(database, 0o600);
const currentWebPath = join(root, 'apps/web/.env.local');
const currentWeb = existsSync(currentWebPath) ? parseEnv(readFileSync(currentWebPath, 'utf8')) : {};
const dashboardToken = currentWeb.PACT_DASHBOARD_TOKEN || randomBytes(32).toString('hex');
const api = {
  HOST: '127.0.0.1', PORT: '3002', DATABASE_PATH: database, PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
  CHAIN_ADAPTER: 'viem', RPC_URL: 'https://rpc.testnet.whitechain.io', RELAYER_PRIVATE_KEY: wallet.RELAYER_PRIVATE_KEY,
  ROUTER_ADDRESS: deployment.contracts.Router, ESCROW_ADDRESS: deployment.contracts.PaymentEscrow,
  SUBSCRIPTION_ADDRESS: deployment.contracts.SubscriptionManager, GAS_TANK_ADDRESS: deployment.contracts.GasTank,
  DEPLOYMENT_BLOCK: deployment.deploymentBlock, CONFIRMATIONS: '2', RELAYER_MIN_AMOUNT_MINOR: '1000000',
};
const web = {
  ...currentWeb, PACT_API_URL: 'http://127.0.0.1:3001', PACT_SECRET_KEY: credentials.secretKey,
  PACT_PUBLISHABLE_KEY: credentials.publishableKey, PACT_MERCHANT_PRIVATE_KEY: wallet.DEPLOYER_PRIVATE_KEY,
  // Keep the existing local payer-cookie encryption key. Production hardening is a separate scope.
  PACT_SESSION_SECRET: currentWeb.PACT_SESSION_SECRET || randomBytes(32).toString('hex'),
  PACT_DASHBOARD_TOKEN: dashboardToken, NEXT_PUBLIC_PACT_DEV_DASHBOARD_TOKEN: dashboardToken,
};
const envText = (values: Record<string, string>) => Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
for (const [name, value] of [['api.env', envText(api)], ['web.env', envText(web)], ['runtime.json', JSON.stringify({ database, credentials, deployment: deployment.contracts, deploymentBlock: deployment.deploymentBlock }, null, 2) + '\n']] as const) {
  const path = join(runtime, name); writeFileSync(path, value, { mode: 0o600 }); chmodSync(path, 0o600);
}
console.log(JSON.stringify({ prepared: true, runtime, database, stagingPort: 3002, merchant: deployment.deployer, credentialsPrinted: false }));
