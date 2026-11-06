import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { InvoiceEditor } from '@/components/merchant/invoices/invoice-editor';
import { PageHeader } from '@/components/ui/page-header';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'New invoice' };

export default async function NewInvoicePage() {
  const viewer = await getViewer();
  if (viewer?.role !== 'merchant') redirect('/dashboard/invoices');
  const data = await getData();
  const [settings, preferences, demo] = await Promise.all([
    data.merchant.settings(),
    load(() => data.merchant.preferences()),
    data.demo?.state(),
  ]);
  const due = new Date(new Date(demo?.now ?? Date.now()).getTime() + 30 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return (
    <>
      <PageHeader
        back={{ href: '/dashboard/invoices', label: 'Invoices' }}
        title="New invoice"
        description="Due in 30 days by default. Preview it as your customer before you send it."
      />
      <InvoiceEditor
        defaultDue={due}
        merchantName={settings.brandName}
        logoUrl={settings.logoUrl}
        brandColor={isNotWired(preferences) ? undefined : preferences.brandColor}
      />
    </>
  );
}
