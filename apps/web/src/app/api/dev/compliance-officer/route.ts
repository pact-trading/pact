import { sameOrigin, sessionApi, sessionFailure, sessionToken, SessionError } from '@/server/api-client';

export const dynamic = 'force-dynamic';
/** Local fork only: makes the signed-in compliance wallet an officer of the investor registry. */
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    if (process.env.PACT_LOCAL_FORK !== '1') throw new SessionError(404, 'faucet_unavailable');
    const token = await sessionToken('compliance');
    return Response.json(
      await sessionApi('/v1/dev/compliance-officer', { method: 'POST', body: '{}' }, token),
      {
        headers: { 'cache-control': 'no-store' },
      },
    );
  } catch (error) {
    return sessionFailure(error);
  }
}
