import { NextResponse, type NextRequest } from 'next/server';
import { SANDBOX_COOKIE, SANDBOX_ID } from '@/lib/sandbox';

/** Mock mode only: gives each browser its own demo store (see server/data/mock/store.ts). */
export function middleware(request: NextRequest) {
  if (process.env.NEXT_PUBLIC_PACT_DATA !== 'mock') return NextResponse.next();
  const existing = request.cookies.get(SANDBOX_COOKIE)?.value;
  if (existing && SANDBOX_ID.test(existing)) return NextResponse.next();

  const id = crypto.randomUUID();
  // Forward the new cookie so this first request already reads the visitor's own sandbox.
  request.cookies.set(SANDBOX_COOKIE, id);
  const response = NextResponse.next({ request: { headers: request.headers } });
  response.cookies.set(SANDBOX_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: request.nextUrl.protocol === 'https:',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
  });
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|brand/|favicon\\.ico|robots\\.txt).*)'],
};
