import 'server-only';
import { headers } from 'next/headers';

/** Absolute origin for shareable links: the configured public origin, else the request host. */
export async function publicOrigin(): Promise<string> {
  if (process.env.PACT_PUBLIC_ORIGIN) return new URL(process.env.PACT_PUBLIC_ORIGIN).origin;
  const h = await headers();
  const host = h.get('host') ?? 'localhost:3000';
  const proto =
    h.get('x-forwarded-proto') ??
    (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https');
  return `${proto}://${host}`;
}
