import { fulfill } from '../../../fulfillment.ts';
import { storeDb } from '../../../lib/db.ts';
import { STORE_ITEM } from '../../../lib/store.ts';

export const dynamic = 'force-dynamic';
const MAX_BODY = 64 * 1024;
const noStore = { 'cache-control': 'no-store' };
let refuseOnce = process.env.PACT_DEMO_REFUSE_FIRST_WEBHOOK === 'true';

export async function POST(request: Request) {
  const secret = process.env.PACT_WEBHOOK_SECRET;
  if (!secret) return new Response('Store is not configured', { status: 503, headers: noStore });
  // Read as text: the signature covers the raw body, so it is checked before any JSON parsing.
  const raw = await request.text();
  if (raw.length > MAX_BODY) return new Response(null, { status: 413, headers: noStore });
  if (refuseOnce) {
    refuseOnce = false;
    return new Response('Demo temporary failure; retry the same event.', { status: 503, headers: noStore });
  }
  try {
    const result = await fulfill(storeDb(), raw, request.headers.get('x-settle-signature') ?? '', request.headers.get('x-settle-event-id') ?? '', secret, process.env.PACT_PRODUCT_ID ?? '', { item: STORE_ITEM.id, amountMinor: STORE_ITEM.amountMinor });
    return Response.json({ result: result.result }, { status: result.status, headers: noStore });
  } catch {
    return new Response('Try again later', { status: 503, headers: noStore });
  }
}
