import {
  sameOrigin,
  sessionApi,
  sessionFailure,
  sessionToken,
  SessionError,
  type SessionRole,
} from '@/server/api-client';

export const dynamic = 'force-dynamic';
/** Local fork only: test WBT or USDT for the signed-in merchant wallet or customer account. */
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    if (process.env.PACT_LOCAL_FORK !== '1') throw new SessionError(404, 'faucet_unavailable');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || !['merchant', 'customer', 'investor', 'compliance'].includes(String(body.as)))
      throw new SessionError(400, 'invalid_request');
    const token = await sessionToken(body.as as SessionRole);
    return Response.json(
      await sessionApi(
        '/v1/dev/faucet',
        { method: 'POST', body: JSON.stringify({ address: body.address, wbt: body.wbt, usdt: body.usdt }) },
        token,
      ),
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    return sessionFailure(error);
  }
}
