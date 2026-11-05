import { redirect } from 'next/navigation';
import { InvestorShell } from '@/components/shell/investor-shell';
import { isMock } from '@/server/mode';
import { getViewer } from '@/server/viewer';

export const dynamic = 'force-dynamic';

export default async function InvestorLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();
  if (!viewer || viewer.role !== 'investor') redirect(isMock ? '/demo?next=/investor' : '/login');
  return <InvestorShell viewer={viewer}>{children}</InvestorShell>;
}
