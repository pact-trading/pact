import { merchantApi, sameOrigin, sessionFailure } from '@/server/api-client';
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    return Response.json(await merchantApi('/v1/auth/merchant', { method: 'POST', body: '{}' }), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return sessionFailure(error);
  }
}
