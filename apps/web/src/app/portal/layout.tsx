import { redirect } from 'next/navigation';
import { PortalShell } from '@/components/shell/portal-shell';
import { isMock } from '@/server/mode';
import { getViewer } from '@/server/viewer';

export const dynamic = 'force-dynamic';

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();
  if (!viewer || viewer.role !== 'customer') redirect(isMock ? '/demo?next=/portal' : '/login');
  return <PortalShell viewer={viewer}>{children}</PortalShell>;
}
