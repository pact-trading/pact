import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { CheckoutLayout, OrderSummary } from '@/components/customer/checkout-layout';
import { CheckoutNotWired } from '@/components/customer/checkout/not-wired';
import { CheckoutView } from '@/components/customer/checkout-view';
import { money } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { isMock } from '@/server/mode';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Pay' };
export const dynamic = 'force-dynamic';

export default async function CheckoutPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const viewer = await getViewer();
  if (viewer?.role !== 'customer')
    redirect(isMock ? `/demo?next=/checkout/${sessionId}` : `/login?returnTo=/checkout/${sessionId}`);
  const state = await load(async () => (await getData()).checkout.session(sessionId));
  if (isNotWired(state)) return <CheckoutNotWired feature={state.feature} />;
  return (
    <CheckoutLayout
      brand={state.brand}
      back={state.returnPath ? { href: state.returnPath } : undefined}
      summary={
        <OrderSummary
          eyebrow={state.kind === 'invoice' ? 'Invoice' : 'One-time payment'}
          title={state.description}
          description={state.detail}
          amount={money(state.total)}
          icon={state.kind === 'invoice' ? 'invoice' : state.kind === 'link' ? 'link' : 'product'}
        />
      }
    >
      <CheckoutView initial={state} payer={viewer.email} />
    </CheckoutLayout>
  );
}
