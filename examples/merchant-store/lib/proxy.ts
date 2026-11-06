import { parseUsdt } from '@pactagent/core/amount';
import { STORE_ITEM } from './store.ts';

const PACT_API = 'https://api.pactagent.app';
const MAX_BODY = 64 * 1024;
/** Values Pact acts on when a secret key sends them. The browser must never get to choose these. */
const FORBIDDEN_METADATA = ['invoiceId', 'paymentLinkId', 'store_item'];
const refuse = (status: number, code: string) => Response.json({ error: { code, message: code } }, { status, headers: { 'cache-control': 'no-store' } });

/**
 * Anyone can call this route, and it answers with the merchant's secret key. So it forwards only the one
 * request the checkout makes, at this store's own price. It never passes on the browser's other headers.
 */
export async function forward(request: Request, path: string[], env: Record<string, string | undefined> = process.env, fetcher: typeof fetch = fetch) {
  if (request.method !== 'POST' || path.join('/') !== 'v1/payments') return refuse(404, 'not_found');
  if (!env.PACT_SECRET_KEY) return refuse(503, 'store_not_configured');
  const raw = await request.text();
  if (raw.length > MAX_BODY) return refuse(413, 'too_large');
  let body: Record<string, unknown> | null = null;
  try { body = JSON.parse(raw); } catch { /* refused below */ }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse(400, 'invalid_json');
  let amount: bigint;
  try { amount = parseUsdt(String(body.amount)); } catch { return refuse(400, 'invalid_amount'); }
  if (amount !== BigInt(STORE_ITEM.amountMinor)) return refuse(400, 'invalid_amount');
  const metadata = body.metadata ?? {};
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return refuse(400, 'invalid_metadata');
  if (FORBIDDEN_METADATA.some(key => Object.hasOwn(metadata, key))) return refuse(400, 'invalid_metadata');
  const key = request.headers.get('idempotency-key');
  try {
    const upstream = await fetcher(`${env.PACT_API_URL || PACT_API}/v1/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.PACT_SECRET_KEY}`, ...(key && key.length <= 255 ? { 'idempotency-key': key } : {}) },
      body: JSON.stringify({ amount: STORE_ITEM.amount, currency: 'USDT', description: STORE_ITEM.name, ...(typeof body.email === 'string' ? { email: body.email } : {}), metadata: { ...metadata, store_item: STORE_ITEM.id } }),
      signal: AbortSignal.timeout(15_000),
    });
    return new Response(await upstream.text(), { status: upstream.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  } catch {
    return refuse(502, 'upstream_unavailable');
  }
}
