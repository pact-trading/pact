import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { IconChevronLeft } from '@tabler/icons-react';
import { StoreFrame } from '@/components/lab/store-frame';
import { StoreOrderLive } from '@/components/lab/store-order-live';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Your order' };
export const dynamic = 'force-dynamic';

/** The store's own confirmation page: it waits for the order.paid webhook. Mock mode only. */
export default async function StoreOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { lab } = await getData();
  if (!lab) redirect('/login');
  const viewer = await getViewer();
  if (!viewer) redirect(`/demo?next=/demo/store/orders/${id}`);
  // One after the other: reading the order may settle its payment, which the frame then sees.
  const order = await load(() => lab.storeOrder(id));
  if (isNotWired(order)) redirect('/demo/store');
  const store = await lab.storefront();
  const owner = viewer.role === 'customer';
  return (
    <StoreFrame brand={store.brand} shopper={store.shopper}>
      <Link
        href="/demo/store"
        className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <IconChevronLeft className="size-4" />
        Back to the store
      </Link>
      <StoreOrderLive
        order={order}
        brandName={store.brand.brandName}
        shopperName={store.shopper?.name ?? null}
        canPay={owner}
        canSimulate={owner || viewer.role === 'merchant'}
      />
    </StoreFrame>
  );
}
