import 'server-only';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createRandom, idFactory } from './ids';
import type { MockStore } from './store';

// Serverless hosts (Vercel) run many short-lived instances, so a sandbox cannot live in one
// process's memory there. When Upstash Redis is connected, each sandbox is saved under its
// cookie id and loaded again by whichever instance serves the visitor's next request.

/** JSON with bigint, Map and Set; the PRNG and id counters travel as their state. */
export function encode(s: MockStore): string {
  const { random, ids, ...rest } = s;
  return JSON.stringify({ ...rest, random: random.state(), ids: ids.counters() }, (_key, value: unknown) => {
    if (typeof value === 'bigint') return { $bigint: value.toString() };
    if (value instanceof Map) return { $map: [...value] };
    if (value instanceof Set) return { $set: [...value] };
    return value;
  });
}

export function decode(raw: string): MockStore {
  const data = JSON.parse(raw, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const tagged = value as { $bigint?: string; $map?: [unknown, unknown][]; $set?: unknown[] };
    if (Object.keys(tagged).length !== 1) return value;
    if (tagged.$bigint !== undefined) return BigInt(tagged.$bigint);
    if (tagged.$map !== undefined) return new Map(tagged.$map);
    if (tagged.$set !== undefined) return new Set(tagged.$set);
    return value;
  }) as Omit<MockStore, 'random' | 'ids'> & { random: number; ids: Record<string, number> };
  const random = createRandom(data.random);
  return { ...data, random, ids: idFactory(random, data.ids) };
}

const url = process.env.KV_REST_API_URL;
const token = process.env.KV_REST_API_TOKEN;
/** Idle sandboxes expire; the visitor then starts again from the seeded story. */
const TTL_SECONDS = 12 * 60 * 60;
/** A new deployment starts every visitor fresh, so stored sandboxes never meet a newer store shape. */
const prefix = `pact:sandbox:${process.env.VERCEL_DEPLOYMENT_ID ?? 'local'}:`;

async function command<T>(args: (string | number)[]): Promise<T> {
  const response = await fetch(url!, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(args),
    cache: 'no-store',
  });
  const body = (await response.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!response.ok || body.error)
    throw new Error(`Sandbox store ${args[0]} failed: ${body.error ?? response.status}`);
  return body.result as T;
}

/** Upstash Redis over REST, present when the Vercel integration is connected. */
export const kv =
  url && token
    ? {
        async get(id: string): Promise<string | null> {
          const value = await command<string | null>(['GET', prefix + id]);
          return value === null ? null : gunzipSync(Buffer.from(value, 'base64')).toString('utf8');
        },
        async set(id: string, json: string): Promise<void> {
          await command(['SET', prefix + id, gzipSync(json).toString('base64'), 'EX', TTL_SECONDS]);
        },
      }
    : null;
