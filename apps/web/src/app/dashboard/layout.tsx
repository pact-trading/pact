import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { MerchantShell } from '@/components/shell/merchant-shell';
import { SIDEBAR_COOKIE } from '@/lib/sidebar';
import { getData } from '@/server/data';
import { isMock } from '@/server/mode';
import { getViewer } from '@/server/viewer';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const viewer = await getViewer();
  if (!viewer || (viewer.role !== 'merchant' && viewer.role !== 'accountant'))
    redirect(isMock ? '/demo' : '/login?role=merchant');
  const settings = await (await getData()).merchant.settings().catch(() => null);
  if (!settings) redirect(isMock ? '/demo' : '/login?role=merchant');
  const collapsed = (await cookies()).get(SIDEBAR_COOKIE)?.value === 'collapsed';
  return (
    <MerchantShell viewer={viewer} business={settings.brandName} initialCollapsed={collapsed}>
      {children}
    </MerchantShell>
  );
}
