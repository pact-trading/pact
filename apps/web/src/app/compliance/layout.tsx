import { redirect } from 'next/navigation';
import { InvestorShell } from '@/components/shell/investor-shell';
import { isMock } from '@/server/mode';
import { getViewer } from '@/server/viewer';

export const dynamic = 'force-dynamic';

export default async function ComplianceLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();
  if (!viewer || viewer.role !== 'compliance') redirect(isMock ? '/demo?next=/compliance' : '/login');
  return (
    <InvestorShell viewer={viewer} side="compliance">
      {children}
    </InvestorShell>
  );
}
