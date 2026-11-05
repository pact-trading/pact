import type { Metadata } from 'next';
import { CheckoutLayout, OrderSummary } from '@/components/customer/checkout-layout';
import { CheckoutNotWired } from '@/components/customer/checkout/not-wired';
import { SignInCard } from '@/components/customer/sign-in-card';
import { StartProductCheckout } from '@/components/customer/start-checkout';
import { Notice } from '@/components/ui/notice';
import { money } from '@/lib/format';
import { getData } from '@/server/data';
import { MOCK_VIEWERS } from '@/server/data/mock/viewers';
import { load, isNotWired } from '@/server/load';
import { isMock } from '@/server/mode';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Checkout' };
export const dynamic = 'force-dynamic';

export default async function BuyPage({ params, searchParams }: { params: Promise<{ productId: string }>; searchParams: Promise<{ discount?: string }> }) {
  const { productId } = await params;
  const { discount = '' } = await searchParams;
  const [entry, viewer] = await Promise.all([
    load(async () => (await getData()).checkout.catalog(productId)),
    getViewer(),
  ]);
  if (isNotWired(entry)) return <CheckoutNotWired feature={entry.feature} />;
  const price = entry.product.prices[0];
  const amount = price ? money(price) : '—';
  const back = { href: '/', history: true };
  return (
    <CheckoutLayout
      brand={entry.brand}
      back={back}
      summary={
        <OrderSummary
          eyebrow="One-time payment"
          title={entry.product.name}
          description={entry.product.description}
          amount={amount}
          imageUrl={entry.product.imageUrl}
        />
      }
    >
      {!entry.available || !price ? (
        <Notice tone="warning" title="Not available">
          This product is not on sale right now.
        </Notice>
      ) : viewer?.role === 'customer' ? (
        <StartProductCheckout checkoutFields={entry.product.checkoutFields} productId={entry.product.id} amount={amount} payer={viewer.email} back={back} initialDiscountCode={discount} />
      ) : (
        <SignInCard
          next={`/buy/${productId}${discount ? `?discount=${encodeURIComponent(discount)}` : ''}`}
          payToday={amount}
          back={back}
          mockEmail={isMock ? MOCK_VIEWERS.find(v => v.role === 'customer')?.email : undefined}
        />
      )}
    </CheckoutLayout>
  );
}
