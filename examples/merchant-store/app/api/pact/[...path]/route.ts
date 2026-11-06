import { forward } from '../../../../lib/proxy.ts';

export const dynamic = 'force-dynamic';

async function handler(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await params).path);
}

export { handler as GET, handler as POST };
