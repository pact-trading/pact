import { getData } from '@/server/data';
import { isMock } from '@/server/mode';

export const dynamic = 'force-dynamic';

/** Mock mode only: restores the seeded demo story. Used by tests and the demo bar. */
export async function POST() {
  const demo = (await getData()).demo;
  if (!isMock || !demo) return Response.json({ error: 'not_found' }, { status: 404 });
  return Response.json(await demo.reset(), { headers: { 'cache-control': 'no-store' } });
}
