import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { LinkEditor } from '@/components/merchant/payment-links/link-editor';
import { PageHeader } from '@/components/ui/page-header';
import { getData } from '@/server/data';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'New payment link' };

export default async function NewPaymentLinkPage() {
  const viewer = await getViewer();
  if (viewer?.role !== 'merchant') redirect('/dashboard/payment-links');
  const data = await getData();
  const [settings, demo] = await Promise.all([data.merchant.settings(), data.demo?.state()]);
  return (
    <>
      <PageHeader
        back={{ href: '/dashboard/payment-links', label: 'Payment links' }}
        title="New payment link"
        description="A hosted pay page with its own link and QR code. Payments land in Orders like any checkout."
      />
      <LinkEditor
        brandName={settings.brandName}
        today={(demo?.now ?? new Date().toISOString()).slice(0, 10)}
        extras={data.mode === 'mock'}
      />
    </>
  );
}
