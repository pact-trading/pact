import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckoutLayout, OrderSummary } from '@/components/customer/checkout-layout';
import { CheckoutNotWired } from '@/components/customer/checkout/not-wired';
import { CheckoutPanel } from '@/components/customer/checkout/panel';
import { SignInCard } from '@/components/customer/sign-in-card';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { date, dateTime, usd } from '@/lib/format';
import { getData } from '@/server/data';
import type { PaymentLinkState } from '@/server/data/parts/commerce';
import { MOCK_VIEWERS } from '@/server/data/mock/viewers';
import { isNotWired, load } from '@/server/load';
import { isMock } from '@/server/mode';
import { getViewer } from '@/server/viewer';
import { StartLinkCheckout } from './start-link-checkout';

export const metadata: Metadata = { title: 'Pay' };
export const dynamic = 'force-dynamic';

const closed: Record<
  Exclude<PaymentLinkState, 'active'>,
  { title: string; message: (brand: string) => string }
> = {
  inactive: {
    title: 'This link is no longer taking payments',
    message: brand => `${brand} turned this link off. Nothing was charged. Ask them for a new link.`,
  },
  expired: {
    title: 'This link has expired',
    message: brand => `The link’s last day has passed and nothing was charged. Ask ${brand} for a new link.`,
  },
  used: {
    title: 'This link was already used',
    message: brand =>
      `It was for one payment only, and that payment has been made. Ask ${brand} for a new link.`,
  },
};

export default async function PaymentLinkPayPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ discount?: string }> }) {
  const { id } = await params;
  const { discount = '' } = await searchParams;
  const [link, viewer] = await Promise.all([
    load(async () => (await getData()).commerce.publicPaymentLink(id)),
    getViewer(),
  ]);
  if (isNotWired(link)) return <CheckoutNotWired feature={link.feature} />;
  const brandName = link.brand.brandName;
  const fixed = link.amountMinor !== null ? usd(link.amountMinor) : null;
  const amount = fixed ?? 'You choose';
  const back = { href: '/', history: true };
  const mine = link.yourPayment;
  const receiptLink = mine && (
    <Button asChild variant="dark">
      <Link href={`/portal/purchases/${mine.orderId}`}>View your receipt</Link>
    </Button>
  );

  let panel;
  if (link.state === 'used' && mine) {
    // A single-use link the signed-in payer used: their own payment, never anyone else's.
    panel = (
      <CheckoutPanel
        step="success"
        receipt={
          <Notice tone="success" title="You paid this link">
            {usd(mine.amountMinor)} to {brandName} on {dateTime(mine.paidAt)}. The receipt is in your account.
          </Notice>
        }
        actions={receiptLink}
      />
    );
  } else if (link.state !== 'active') {
    const copy = closed[link.state];
    panel = (
      <CheckoutPanel
        step="expired"
        title={copy.title}
        message={copy.message(brandName)}
        action={receiptLink || undefined}
      />
    );
  } else if (viewer?.role !== 'customer') {
    panel = (
      <SignInCard
        next={`/l/${link.id}${discount ? `?discount=${encodeURIComponent(discount)}` : ''}`}
        payToday={fixed ?? undefined}
        back={back}
        mockEmail={isMock ? MOCK_VIEWERS.find(v => v.role === 'customer')?.email : undefined}
      />
    );
  } else {
    panel = (
      <StartLinkCheckout
        initialDiscountCode={discount}
        checkoutFields={link.checkoutFields}
        linkId={link.id}
        amountMinor={link.amountMinor}
        minimumMinor={link.minimumMinor}
        maximumMinor={link.maximumMinor}
        suggestionsMinor={link.suggestionsMinor}
        payer={viewer.email}
        back={back}
        before={
          mine && (
            <Notice tone="info" title="You paid this link before">
              {usd(mine.amountMinor)} on {date(mine.paidAt)}.{' '}
              <Link
                href={`/portal/purchases/${mine.orderId}`}
                className="font-medium underline underline-offset-4"
              >
                View your receipt
              </Link>
            </Notice>
          )
        }
      />
    );
  }

  const terms = [
    link.singleUse && 'One payment only',
    link.state === 'active' && link.expiresAt && `Open until ${date(link.expiresAt)}`,
  ].filter(Boolean);
  return (
    <CheckoutLayout
      brand={link.brand}
      back={back}
      summary={
        <OrderSummary
          eyebrow={link.kind === 'tip' ? 'Pay what you like' : 'One-time payment'}
          title={link.name}
          amount={amount}
          totalNote={terms.length ? terms.join(' · ') : undefined}
          items={[{ id: link.id, title: link.name, detail: link.description, amount, icon: 'link' as const }]}
        />
      }
    >
      {panel}
    </CheckoutLayout>
  );
}
