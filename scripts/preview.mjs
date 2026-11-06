#!/usr/bin/env node
// Mock-data preview of every viewpoint. Builds a production bundle, then serves it.
// No API, chain, credentials or real payments are involved; data resets on restart.
//   pnpm preview            → http://127.0.0.1:3200/demo
//   PORT=4000 pnpm preview
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const web = resolve(root, 'apps/web');
const next = resolve(web, 'node_modules/next/dist/bin/next');
const port = Number(process.env.PORT ?? 3200);
const env = { ...process.env, PACT_DATA: 'mock', PACT_PREVIEW: '1', NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_PRIVY_APP_ID: '' };

if (!existsSync(next)) {
  console.error('Missing apps/web dependencies. Run `pnpm install` at the repository root first.');
  process.exit(1);
}

await new Promise((ok, fail) => {
  const probe = createServer();
  probe.once('error', () => fail(new Error(`Port ${port} is in use. Stop that service or set PORT.`)));
  probe.listen(port, '127.0.0.1', () => probe.close(ok));
}).catch(error => {
  console.error(error.message);
  process.exit(1);
});

const run = (args, options = {}) => spawn(process.execPath, [next, ...args], { cwd: web, env, stdio: 'inherit', ...options });

console.info('Building the mock-data preview (production build)…');
const build = run(['build']);
const code = await new Promise(done => build.once('exit', done));
if (code !== 0) process.exit(code ?? 1);

const server = run(['start', '--hostname', '127.0.0.1', '--port', String(port)]);
const stop = () => server.kill('SIGTERM');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.once('exit', exit => process.exit(exit ?? 0));
console.info(`\nPact Pay preview: http://127.0.0.1:${port}/demo\nPick a viewpoint there. Press Ctrl+C to stop.\n`);
