import 'server-only';
import { cookies } from 'next/headers';

/** Customer session: a Privy access token, or a wallet session token on a local fork. */
export const sessionCookie = 'pact_session';
/** Merchant session: a wallet session token from a signed login message. */
export const merchantCookie = 'pact_merchant';
/** Investor and compliance officer sessions: wallet session tokens, like the merchant's. */
export const investorCookie = 'pact_investor';
export const complianceCookie = 'pact_compliance';
export type SessionRole = 'merchant' | 'customer' | 'investor' | 'compliance';
export const roleCookies: Record<SessionRole, string> = {
  merchant: merchantCookie,
  customer: sessionCookie,
  investor: investorCookie,
  compliance: complianceCookie,
};
export interface PactIdentity {
  userId: string;
  sessionId: string;
  expiresAt: number;
  wallet: { address: string; id: string | null };
  email: string | null;
  kind?: 'privy' | 'wallet';
}
export interface MerchantSettings {
  brandName: string;
  logoUrl: string | null;
  refundWindowSeconds: number;
  payoutAddress: string;
}
export class SessionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** The API's own explanation, when it gives one (financing refusals do). */
    readonly detail?: string,
  ) {
    super(code);
  }
}
export function sameOrigin(request: Request) {
  // Next's internal URL may use localhost behind the listener. Host is the
  // browser's actual destination; never trust forwarded-host for this check.
  const url = new URL(request.url);
  const destination = process.env.PACT_PUBLIC_ORIGIN
    ? new URL(process.env.PACT_PUBLIC_ORIGIN).origin
    : `${url.protocol}//${request.headers.get('host') ?? url.host}`;
  if (request.headers.get('origin') !== destination) throw new SessionError(403, 'origin_mismatch');
}
/**
 * How long the web waits for the API by default. Chain-bound steps such as a relayed approval wait for
 * confirmations: about a second on a local fork, often more than eight seconds on the testnet.
 */
const API_TIMEOUT_MS = 30_000;
export async function sessionToken(role: SessionRole = 'customer') {
  const token = (await cookies()).get(roleCookies[role])?.value;
  if (!token) throw new SessionError(401, 'login_required');
  return token;
}
/** Same as sessionApi, with the given wallet role's session. */
export async function roleApi<T>(role: SessionRole, path: string, init: RequestInit = {}): Promise<T> {
  return sessionApi<T>(path, init, await sessionToken(role));
}
/** Same as sessionApi, with the merchant's session. */
export async function merchantApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  return sessionApi<T>(path, init, await sessionToken('merchant'));
}
/** Unauthenticated API call, for sign-in challenges and public reads. */
export async function publicApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!path.startsWith('/v1/') || path.includes('://')) throw new Error('Invalid API path');
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  const response = await fetch(`${process.env.PACT_API_URL ?? 'http://localhost:3001'}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
    // Callers of slow, chain-bound actions (agent runs, account setup) pass their own signal.
    signal: init.signal ?? AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const body = await response.json();
  if (!response.ok)
    throw new SessionError(
      response.status,
      body.error?.code ?? 'api_unavailable',
      typeof body.error?.message === 'string' && body.error.message !== body.error.code
        ? body.error.message
        : undefined,
    );
  return body as T;
}
export const cookieOptions = (request: Request, maxAge: number) => ({
  httpOnly: true,
  secure: new URL(process.env.PACT_PUBLIC_ORIGIN ?? request.url).protocol === 'https:',
  sameSite: 'lax' as const,
  path: '/',
  maxAge,
});
export async function sessionApi<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const credential = token ?? (await sessionToken());
  // The caller chooses a fixed API path; no client-selected upstream URL or key fallback.
  if (!path.startsWith('/v1/') || path.includes('://')) throw new Error('Invalid API path');
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${credential}`);
  headers.set('content-type', 'application/json');
  const response = await fetch(`${process.env.PACT_API_URL ?? 'http://localhost:3001'}${path}`, {
    ...init,
    headers,
    cache: 'no-store',
    // Callers of slow, chain-bound actions (agent runs, account setup) pass their own signal.
    signal: init.signal ?? AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const body = await response.json();
  if (!response.ok)
    throw new SessionError(
      response.status,
      body.error?.code ?? 'api_unavailable',
      typeof body.error?.message === 'string' && body.error.message !== body.error.code
        ? body.error.message
        : undefined,
    );
  return body as T;
}
export async function merchantSession() {
  const token = await sessionToken('merchant');
  const [identity, settings] = await Promise.all([
    sessionApi<PactIdentity>('/v1/auth/session', {}, token),
    sessionApi<MerchantSettings>('/v1/settings', {}, token),
  ]);
  return { identity, settings };
}
export function sessionFailure(error: unknown) {
  return Response.json(
    { error: error instanceof SessionError ? error.code : 'service_unavailable' },
    { status: error instanceof SessionError ? error.status : 503, headers: { 'cache-control': 'no-store' } },
  );
}
