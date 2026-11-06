// Writes the API environment for a testnet deployment: public values from the deployment record, the
// relayer key from the private keys file and the Privy credentials from the API's local env file.
// The output contains secrets, so it is written with mode 0600 and never printed.
//   tsx scripts/testnet/api-env.ts --deployment <record.json> --keys ../../.env.testnet --privy .env.local \
//     --rpc https://rpc.testnet.whitechain.io --web-origin https://pay.pactagent.app --out <api.env>
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { privateKey, readEnvFile } from './keys.js';

const { values: args } = parseArgs({
  options: {
    deployment: { type: 'string' }, keys: { type: 'string' }, privy: { type: 'string' }, rpc: { type: 'string' },
    'web-origin': { type: 'string' }, out: { type: 'string' }, database: { type: 'string', default: '/var/lib/pact-api/api.sqlite' },
    port: { type: 'string', default: '3001' }, artifacts: { type: 'string' }, force: { type: 'boolean', default: false },
    // Invoice financing deployed beside the suite (scripts/testnet/deploy-financing.ts): its verified record.
    financing: { type: 'string' },
  },
});
const fail = (message: string): never => { console.error(`[api-env] ${message}`); process.exit(1); };
for (const name of ['deployment', 'keys', 'privy', 'rpc', 'web-origin', 'out'] as const) if (!args[name]) fail(`--${name} is required`);
if (existsSync(args.out!) && !args.force) fail(`${args.out} exists; pass --force to replace it`);

const deployment = JSON.parse(readFileSync(args.deployment!, 'utf8'));
if (deployment.status !== 'verified') fail('The deployment record is not verified');
const keys = readEnvFile(args.keys!);
const privy = readEnvFile(args.privy!);
const relayerKey: Hex = (() => { try { return privateKey(keys, 'RELAYER_PRIVATE_KEY'); } catch { return fail('RELAYER_PRIVATE_KEY is missing or malformed'); } })();
if (privateKeyToAccount(relayerKey).address.toLowerCase() !== deployment.accounts.keeper.toLowerCase()) fail('The relayer key is not the keeper this suite was deployed with');
if (!deployment.contracts.fees) fail('The deployment record has no FeeSchedule: it predates fees taken from the payment. Deploy a fresh suite.');
if (!privy.PRIVY_APP_ID || !privy.PRIVY_APP_SECRET) fail('PRIVY_APP_ID and PRIVY_APP_SECRET are required: on the testnet customers sign in with Privy');
const origin = args['web-origin']!.replace(/\/$/, '');
if (!/^https?:\/\/[^/]+$/.test(origin)) fail('--web-origin must be an origin, like https://pay.pactagent.app');

const env: Record<string, string> = {
  NODE_ENV: 'production',
  PORT: args.port!,
  HOST: '127.0.0.1',
  DATABASE_PATH: args.database!,
  PUBLIC_BASE_URL: origin,
  PACT_WEB_ORIGIN: origin,
  CHAIN_ADAPTER: 'viem',
  RPC_URL: args.rpc!,
  RELAYER_PRIVATE_KEY: relayerKey,
  ROUTER_ADDRESS: deployment.contracts.router,
  ESCROW_ADDRESS: deployment.contracts.escrow,
  SUBSCRIPTION_ADDRESS: deployment.contracts.subscription,
  FEE_SCHEDULE_ADDRESS: deployment.contracts.fees,
  DEPLOYMENT_BLOCK: deployment.deploymentBlock,
  CONFIRMATIONS: '1',
  // New heads over WebSocket: index and reconcile as each block lands (Whitechain serves /ws on the RPC host).
  RPC_WS_URL: args.rpc!.replace(/^http/, 'ws').replace(/\/?$/, '/ws'),
  // Where the ledger is written. Testnet demos: latest (the sequencer's block). Real money: safe or finalized.
  PACT_FINALITY: process.env.PACT_FINALITY ?? 'latest',
  // Passkey accounts (P-256, RIP-7212) and the Permit2 they pay through, when the record has them.
  ...(deployment.contracts.passkeyFactory ? { PASSKEY_FACTORY_ADDRESS: deployment.contracts.passkeyFactory } : {}),
  ...(deployment.contracts.permit2 ? { PERMIT2_ADDRESS: deployment.contracts.permit2 } : {}),
  // Optional extra relayer keys for Router intents (comma-separated); each needs WBT for gas.
  ...(process.env.RELAYER_LANE_KEYS ? { RELAYER_LANE_KEYS: process.env.RELAYER_LANE_KEYS } : {}),
  RELAYER_MIN_AMOUNT_MINOR: deployment.routerLimits.minAmount,
  // About 25 sponsored calls a minute in total, and 8 per merchant, at Whitechain's 5 gwei floor.
  RELAYER_MAX_SPEND_PER_MINUTE_WEI: '100000000000000000',
  RELAYER_MAX_SPEND_PER_MERCHANT_PER_MINUTE_WEI: '30000000000000000',
  // Gas Pact absorbs for calls that move no money to a merchant: 0.05 WBT a day, plus 25% of its fees.
  SPONSORSHIP_STARTER_WEI_PER_DAY: '50000000000000000',
  SPONSORSHIP_REVENUE_SHARE_BPS: '2500',
  X402_FACTORY_ADDRESS: deployment.x402.factory,
  X402_RUNTIME_HASHES: JSON.stringify(deployment.x402.runtimeHashes),
  // Per-merchant daily x402 gas, counted at worst case: about 50 paid calls a day, ~0.05 WBT actually spent.
  X402_MERCHANT_DAILY_LIMIT_WEI: '400000000000000000',
  PRIVY_APP_ID: privy.PRIVY_APP_ID,
  PRIVY_APP_SECRET: privy.PRIVY_APP_SECRET,
  ...(args.artifacts ? { CONTRACT_ARTIFACTS_DIR: args.artifacts } : {}),
  ...financingEnv(),
};
function financingEnv(): Record<string, string> {
  if (!args.financing) return {};
  const record = JSON.parse(readFileSync(args.financing, 'utf8'));
  if (record.status !== 'verified' || record.mode !== 'testnet') fail('The financing record is not a verified testnet deployment');
  if (record.contracts.router.toLowerCase() !== deployment.contracts.router.toLowerCase()) fail('The financing record names a different Router');
  return {
    RECEIVABLES_ADDRESS: record.contracts.receivables,
    INVESTOR_REGISTRY_ADDRESS: record.contracts.registry,
    FINANCING_DEPLOYMENT_BLOCK: record.deploymentBlock,
  };
}
// systemd EnvironmentFile and `set -a; . file` both read KEY='value' lines; no value contains a quote.
for (const [k, v] of Object.entries(env)) if (v.includes("'") || v.includes('\n')) fail(`${k} contains a quote or newline`);
writeFileSync(args.out!, `${Object.entries(env).map(([k, v]) => `${k}='${v}'`).join('\n')}\n`, { mode: 0o600 });
console.info(`[api-env] wrote ${Object.keys(env).length} values to ${args.out} (mode 600)`);
