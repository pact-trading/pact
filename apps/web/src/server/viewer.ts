import 'server-only';
import { cookies } from 'next/headers';
import type { Viewer, ViewerRole } from '@pactagent/core/platform-types';
import { DataError } from './data/errors';
import { MOCK_VIEWERS } from './data/mock/viewers';
import { isMock } from './mode';
import {
  complianceCookie,
  investorCookie,
  merchantCookie,
  sessionApi,
  sessionCookie,
  type PactIdentity,
} from './api-client';

/** Which side of the product the visitor chose. Not a credential: the API checks permissions. */
export const ROLE_COOKIE = 'pact_role';

const roles: ViewerRole[] = ['merchant', 'accountant', 'customer', 'investor', 'compliance'];
const asRole = (value: string | undefined): ViewerRole | null =>
  roles.includes(value as ViewerRole) ? (value as ViewerRole) : null;

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const viewerFrom = (role: ViewerRole, identity: PactIdentity): Viewer => ({
  role,
  userId: identity.userId,
  name:
    identity.email?.split('@')[0] ??
    (identity.kind === 'wallet' ? short(identity.wallet.address) : 'Your account'),
  email: identity.email ?? '',
  organization: '',
});

/**
 * Every side a live visitor can be signed in as: a merchant wallet, a customer account, and the
 * wallets of an investor and a compliance officer.
 */
export async function liveSessions(): Promise<{
  merchant: PactIdentity | null;
  customer: PactIdentity | null;
  investor: PactIdentity | null;
  compliance: PactIdentity | null;
}> {
  const jar = await cookies();
  const read = async (token: string | undefined) =>
    token ? sessionApi<PactIdentity>('/v1/auth/session', {}, token).catch(() => null) : null;
  const [merchant, customer, investor, compliance] = await Promise.all([
    read(jar.get(merchantCookie)?.value),
    read(jar.get(sessionCookie)?.value),
    read(jar.get(investorCookie)?.value),
    read(jar.get(complianceCookie)?.value),
  ]);
  return { merchant, customer, investor, compliance };
}

export async function getViewer(): Promise<Viewer | null> {
  const role = asRole((await cookies()).get(ROLE_COOKIE)?.value);
  if (isMock) return MOCK_VIEWERS.find(viewer => viewer.role === role) ?? null;
  const sessions = await liveSessions();
  // The merchant and accountant views read the merchant wallet session; the customer view the customer one.
  if (role === 'merchant' || role === 'accountant')
    return sessions.merchant ? viewerFrom(role, sessions.merchant) : null;
  if (role === 'customer') return sessions.customer ? viewerFrom(role, sessions.customer) : null;
  // Investors and compliance officers are wallets; the viewer's id is the address.
  if (role === 'investor' || role === 'compliance') {
    const session = sessions[role];
    return session ? { ...viewerFrom(role, session), userId: session.wallet.address.toLowerCase() } : null;
  }
  if (sessions.customer) return viewerFrom('customer', sessions.customer);
  if (sessions.merchant) return viewerFrom('merchant', sessions.merchant);
  return null;
}

export async function requireViewer(allowed: ViewerRole[]): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) throw new DataError('login_required', 'Sign in to continue.', 401);
  if (!allowed.includes(viewer.role)) {
    throw new DataError(
      viewer.role === 'accountant' ? 'read_only' : 'forbidden',
      viewer.role === 'accountant' ? 'The accountant role is read-only.' : 'This account cannot do that.',
      403,
    );
  }
  return viewer;
}
