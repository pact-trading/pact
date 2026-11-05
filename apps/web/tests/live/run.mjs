#!/usr/bin/env node
// Live-mode browser checks against a running `pnpm live` (local fork), or the deployed testnet app
// with PACT_LIVE_URL and PACT_LIVE_API set (see tests/live/testnet.mjs). Each flow uses fresh local
// test wallets, so they can run in any order and repeat. Screenshots go to test-results/live.
//   pnpm live:check                 → every flow
//   pnpm live:check purchase agents → only these
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = process.env.PACT_LIVE_URL ?? 'http://localhost:3000';

const here = dirname(fileURLToPath(import.meta.url));
const shots = resolve(here, '../../test-results/live');
mkdirSync(shots, { recursive: true });
const flows = [
  'purchase',
  'subscriptions',
  'change-plan',
  'invoices',
  'links-orders',
  'agents',
  'financing',
  'security',
  'sweep',
];
const chosen = process.argv.slice(2).length ? process.argv.slice(2) : flows;
const health = await fetch(`${base}/login`)
  .then(r => r.ok)
  .catch(() => false);
if (!health) {
  console.error(
    `The live app is not reachable at ${base}. Start it with \`pnpm live\` first, or set PACT_LIVE_URL.`,
  );
  process.exit(1);
}
const results = [];
for (const flow of chosen) {
  if (!flows.includes(flow)) {
    console.error(`Unknown flow "${flow}". Choose from: ${flows.join(', ')}`);
    process.exit(1);
  }
  console.info(`\n== ${flow}`);
  const run = spawnSync(process.execPath, [resolve(here, `${flow}.mjs`), shots], {
    stdio: 'inherit',
    cwd: resolve(here, '../..'),
  });
  results.push([flow, run.status === 0]);
}
console.info('\nSummary');
for (const [flow, ok] of results) console.info(`  ${ok ? 'pass' : 'FAIL'}  ${flow}`);
console.info(`Screenshots: ${shots}`);
process.exit(results.every(([, ok]) => ok) ? 0 : 1);
