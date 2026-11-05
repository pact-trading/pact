import { publicApi, sameOrigin, sessionFailure } from '@/server/api-client';

export const dynamic = 'force-dynamic';
/** The one-time challenge a wallet signs to sign in (EIP-4361). */
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    return Response.json(await publicApi('/v1/auth/wallet/nonce', { method: 'POST', body: '{}' }), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return sessionFailure(error);
  }
}
