// Reads the private testnet keys file (.env.testnet). Values stay in memory and are never printed.
import { readFileSync } from 'node:fs';
import type { Hex } from 'viem';

export function readEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/);
    if (m && m[2].trim()) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

/** A 32-byte hex private key from the file, with or without the 0x prefix. */
export function privateKey(env: Record<string, string>, name: string): Hex {
  const raw = env[name] ?? '';
  const value = raw.startsWith('0x') ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`${name} is missing or malformed`);
  return value as Hex;
}
