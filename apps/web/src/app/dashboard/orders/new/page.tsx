import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { OrderEditor } from '@/components/merchant/order-editor/order-editor';
import { NotConnected } from '@/components/states/not-connected';
import { PageHeader } from '@/components/ui/page-header';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Create order' };

export default async function NewOrderPage() {
  const viewer = await getViewer();
  if (viewer?.role !== 'merchant') redirect('/dashboard/orders');
  const options = await load(async () => (await getData()).commerce.manualOrderOptions());
  const header = (
    <PageHeader
      back={{ href: '/dashboard/orders', label: 'Orders' }}
      title="Create order"
      description="Bill a customer for something you agreed outside your store. They get a pay link and pay like any checkout."
    />
  );
  if (isNotWired(options))
    return (
      <>
        {header}
        <NotConnected feature={options.feature} />
      </>
    );
  return (
    <>
      {header}
      <OrderEditor options={options} />
    </>
  );
}
