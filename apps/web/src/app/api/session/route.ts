import { cookies } from 'next/headers';
import {
  sameOrigin,
  sessionApi,
  sessionCookie,
  merchantCookie,
  investorCookie,
  complianceCookie,
  sessionFailure,
  SessionError,
  type PactIdentity,
} from '@/server/api-client';

export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    return Response.json(await sessionApi<PactIdentity>('/v1/auth/session'), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch (error) {
    return sessionFailure(error);
  }
}
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
    if (!token || token.length > 16384 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token))
      throw new SessionError(401, 'invalid_identity_token');
    const identity = await sessionApi<PactIdentity>('/v1/auth/session', {}, token);
    const maxAge = Math.min(3600, identity.expiresAt - Math.floor(Date.now() / 1000));
    if (!Number.isSafeInteger(maxAge) || maxAge <= 0) throw new SessionError(401, 'invalid_identity_token');
    (await cookies()).set(sessionCookie, token, {
      httpOnly: true,
      secure: new URL(process.env.PACT_PUBLIC_ORIGIN ?? request.url).protocol === 'https:',
      sameSite: 'lax',
      path: '/',
      maxAge,
    });
    return Response.json(identity, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return sessionFailure(error);
  }
}
/**
 * Ends a session. `?role=merchant|customer` ends one side (default both). `only=privy` clears the
 * customer cookie only when it holds a Privy token, so signing out of Privy keeps a test-wallet session.
 */
export async function DELETE(request: Request) {
  try {
    sameOrigin(request);
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const jar = await cookies();
    // Wallet sessions: the merchant's, and the investor's and compliance officer's.
    for (const [side, cookie] of [
      ['merchant', merchantCookie],
      ['investor', investorCookie],
      ['compliance', complianceCookie],
    ] as const) {
      if (role && role !== side) continue;
      const token = jar.get(cookie)?.value;
      if (token)
        await sessionApi('/v1/auth/logout', { method: 'POST', body: '{}' }, token).catch(() => undefined);
      jar.delete(cookie);
    }
    if (!role || role === 'customer') {
      const token = jar.get(sessionCookie)?.value;
      const isPrivy = !!token && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token);
      if (url.searchParams.get('only') !== 'privy' || isPrivy) {
        if (token && !isPrivy)
          await sessionApi('/v1/auth/logout', { method: 'POST', body: '{}' }, token).catch(() => undefined);
        jar.delete(sessionCookie);
      }
    }
    return Response.json({ ok: true }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return sessionFailure(error);
  }
}
