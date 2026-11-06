// Loads packages the scripts need (viem, ws, better-sqlite3) from the API workspace, so the root
// package needs no dependencies of its own.
import { createRequire } from 'node:module';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const api = createRequire(resolve(root, 'apps/api/package.json'));

/** Imports `specifier` as the API resolves it (e.g. 'viem', 'viem/accounts'); viem's ESM build. */
export async function load(specifier) {
  const path = api.resolve(specifier).replace(`${sep}viem${sep}_cjs${sep}`, `${sep}viem${sep}_esm${sep}`);
  return import(pathToFileURL(path).href);
}
/** The default export of a CommonJS package (e.g. 'better-sqlite3'). */
export async function loadDefault(specifier) {
  return (await import(pathToFileURL(api.resolve(specifier)).href)).default;
}
/** `ws` is a dependency of viem, not of the API. */
export async function loadWs() {
  const fromViem = createRequire(api.resolve('viem'));
  const module = await import(pathToFileURL(fromViem.resolve('ws')).href);
  return module.default ?? module;
}

/** Anvil's public development keys. Never use them on a real network. */
export const ANVIL_KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
  '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
  '0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356',
];
/** Addresses of ANVIL_KEYS #4–#7: the extra relayer lanes. */
export const LANE_ADDRESSES = [
  '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
  '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955',
];
export const LANE_KEYS = ANVIL_KEYS.slice(4, 8);

/** One JSON-RPC call. */
export async function rpc(url, method, params = [], timeoutMs = 15_000) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}
export const sleep = ms => new Promise(r => setTimeout(r, ms));
/** Parses `--name value` and `--flag` arguments. */
export function flags(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const [key, inline] = arg.slice(2).split('=');
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
