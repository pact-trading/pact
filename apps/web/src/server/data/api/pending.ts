import 'server-only';
import { randomBytes } from 'node:crypto';
import { DataError } from '../errors';
import type { SignRequest } from '../types';

// A prepared signature's context stays on the server; the browser only ever holds its token. On a
// serverless host the prepare and submit requests can reach different instances, so when Upstash Redis
// is connected the context is kept there (single use, ten minutes); otherwise in this process's memory.

const TTL_SECONDS = 10 * 60;
const url = process.env.KV_REST_API_URL;
const kvToken = process.env.KV_REST_API_TOKEN;
type Held = { kind: string; context: Record<string, unknown>; createdAt: number };
const memory = new Map<string, Held>();
const key = (token: string) => `pact:pending:${token}`;

/** JSON with bigint (typed-data values), tagged so it survives the round trip. */
const encode = (held: Held) =>
  JSON.stringify(held, (_k, v: unknown) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v));
const decode = (raw: string) =>
  JSON.parse(raw, (_k, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 1 && '$bigint' in v
      ? BigInt((v as { $bigint: string }).$bigint)
      : v,
  ) as Held;

async function redis<T>(args: (string | number)[]): Promise<T> {
  const response = await fetch(url!, {
    method: 'POST',
    headers: { authorization: `Bearer ${kvToken}` },
    body: JSON.stringify(args),
    cache: 'no-store',
    signal: AbortSignal.timeout(5000),
  });
  const body = (await response.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!response.ok || body.error)
    throw new Error(`Pending store ${args[0]} failed: ${body.error ?? response.status}`);
  return body.result as T;
}
const shared = Boolean(url && kvToken);
const valid = (token: string) => /^[0-9a-f]{32}$/.test(token);

export async function hold(
  kind: string,
  context: Record<string, unknown>,
  view: Omit<SignRequest, 'token'>,
): Promise<SignRequest> {
  const token = randomBytes(16).toString('hex');
  const held: Held = { kind, context, createdAt: Date.now() };
  if (shared) await redis(['SET', key(token), encode(held), 'EX', TTL_SECONDS]);
  else memory.set(token, held);
  return { token, ...view };
}

async function read(token: string, consume: boolean): Promise<Held | null> {
  if (!valid(token)) return null;
  if (shared) {
    const raw = await redis<string | null>([consume ? 'GETDEL' : 'GET', key(token)]);
    return raw === null ? null : decode(raw);
  }
  const held = memory.get(token) ?? null;
  if (consume) memory.delete(token);
  return held;
}

/** The kind of a held request, without consuming it (for steps shared by several flows). */
export async function peek(token: string) {
  return (await read(token, false))?.kind ?? null;
}

export async function take(kind: string, token: string) {
  const held = await read(token, true);
  if (!held || held.kind !== kind || Date.now() - held.createdAt > TTL_SECONDS * 1000)
    throw new DataError('replay', 'This signed request was already used or has expired.', 409);
  return held.context;
}
