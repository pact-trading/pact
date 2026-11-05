import { NextResponse } from 'next/server';
import { isMock } from '@/server/mode';
import { ROLE_COOKIE } from '@/server/viewer';

const landing: Record<string, string> = {
  merchant: '/dashboard',
  accountant: '/dashboard/exports',
  customer: '/portal',
  investor: '/investor',
  compliance: '/compliance',
};

/** Mock mode only: a shareable link that picks the viewpoint, e.g. /demo/as/customer?next=/buy/prod_audit */
export async function GET(request: Request, { params }: { params: Promise<{ role: string }> }) {
  const { role } = await params;
  if (!isMock || !landing[role]) return new Response('Not found', { status: 404 });
  const next = new URL(request.url).searchParams.get('next');
  const target = next && next.startsWith('/') && !next.startsWith('//') ? next : landing[role];
  // A relative Location keeps the browser on the host it used (localhost or 127.0.0.1), where the cookie lives.
  const response = new NextResponse(null, {
    status: 307,
    headers: { Location: target, 'Cache-Control': 'no-store' },
  });
  response.cookies.set(ROLE_COOKIE, role, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 8,
  });
  return response;
}
