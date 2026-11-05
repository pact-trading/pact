import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { PlanForm } from '@/components/merchant/plans/plan-form';
import { PageHeader } from '@/components/ui/page-header';
import { getData } from '@/server/data';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'New plan' };

export default async function NewPlanPage() {
  const viewer = await getViewer();
  if (viewer?.role !== 'merchant') redirect('/dashboard/plans');
  const settings = await (await getData()).merchant.settings();
  return (
    <>
      <PageHeader
        back={{ href: '/dashboard/plans', label: 'Plans' }}
        title="New plan"
        description="A recurring price with a cap the customer signs once. Share its subscribe link when it is ready."
      />
      <PlanForm brandName={settings.brandName} />
    </>
  );
}
