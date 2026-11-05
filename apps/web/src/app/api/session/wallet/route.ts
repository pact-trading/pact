import { cookies } from 'next/headers';
import {
  cookieOptions,
  publicApi,
  roleCookies,
  sameOrigin,
  sessionApi,
  sessionFailure,
  SessionError,
  type PactIdentity,
  type SessionRole,
} from '@/server/api-client';

export const dynamic = 'force-dynamic';
type Verified = { token: string; address: string; expiresAt: number; email: string | null };
const roles: SessionRole[] = ['merchant', 'customer', 'investor', 'compliance'];

/**
 * Exchanges a signed login message for a session. As a merchant, the wallet also gets its workspace.
 * Investors and compliance officers are wallets too; the API checks the registry for what they may do.
 * As a customer this is only offered on a local fork (a browser-held test wallet).
 */
export async function POST(request: Request) {
  try {
    sameOrigin(request);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const role = body?.role as SessionRole;
    if (!body || !roles.includes(role)) throw new SessionError(400, 'invalid_request');
    if (role === 'customer' && process.env.PACT_LOCAL_FORK !== '1')
      throw new SessionError(403, 'email_sign_in_required');
    const verified = await publicApi<Verified>('/v1/auth/wallet/verify', {
      method: 'POST',
      body: JSON.stringify({
        message: body.message,
        signature: body.signature,
        email: role === 'customer' ? body.email : undefined,
      }),
    });
    if (role === 'merchant')
      await sessionApi('/v1/auth/merchant', { method: 'POST', body: '{}' }, verified.token);
    const identity = await sessionApi<PactIdentity>('/v1/auth/session', {}, verified.token);
    const maxAge = Math.min(12 * 3600, verified.expiresAt - Math.floor(Date.now() / 1000));
    (await cookies()).set(roleCookies[role], verified.token, cookieOptions(request, maxAge));
    return Response.json(identity, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return sessionFailure(error);
  }
}
