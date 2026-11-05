import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckoutLayout, OrderSummary } from '@/components/customer/checkout-layout';
import { CheckoutNotWired } from '@/components/customer/checkout/not-wired';
import { CheckoutPanel } from '@/components/customer/checkout/panel';
import { SignInCard } from '@/components/customer/sign-in-card';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { date, dateTime, usd } from '@/lib/format';
import { getData } from '@/server/data';
import { MOCK_VIEWERS } from '@/server/data/mock/viewers';
import { isNotWired, load } from '@/server/load';
import { isMock } from '@/server/mode';
import { getViewer } from '@/server/viewer';
import { StartOrderCheckout } from './start-order-checkout';

export const metadata: Metadata = { title: 'Pay your order' };
export const dynamic = 'force-dynamic';

const PAID = ['paid', 'partially_refunded', 'refunded'];

export default async function PayOrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const [payable, viewer] = await Promise.all([
    load(async () => (await getData()).commerce.payableOrder(orderId)),
    getViewer(),
  ]);
  if (isNotWired(payable)) return <CheckoutNotWired feature={payable.feature} />;
  const { brand, order } = payable;
  const mockEmail = isMock ? MOCK_VIEWERS.find(v => v.role === 'customer')?.email : undefined;

  // Before sign-in, or for someone else's account, nothing about the order is shown.
  if (!order || payable.access !== 'payer' || viewer?.role !== 'customer')
    return (
      <CheckoutLayout
        brand={brand}
        summary={
          <div className="grid gap-1">
            <p className="text-[15px] text-muted-foreground">{brand.brandName} sent you an order</p>
            <h1 className="text-3xl leading-tight font-semibold tracking-tight">
              Sign in to view and pay it
            </h1>
          </div>
        }
      >
        {payable.access === 'other' ? (
          <CheckoutPanel
            step="expired"
            title="This order is for another account"
            message={`Sign in with the email address ${brand.brandName} sent the order to. Nothing was charged.`}
          />
        ) : (
          <SignInCard next={`/pay/${orderId}`} title="View your order" mockEmail={mockEmail} />
        )}
      </CheckoutLayout>
    );

  const paid = PAID.includes(order.status);
  const closed = order.status === 'expired' || order.status === 'failed';
  const total = usd(order.totalMinor);
  const back = { href: '/portal', label: 'Back', history: true };
  return (
    <CheckoutLayout
      brand={brand}
      back={back}
      summary={
        <OrderSummary
          eyebrow={`Order ${order.id}`}
          title={`Order from ${brand.brandName}`}
          amount={total}
          totalNote={
            <span className="flex flex-wrap items-center gap-2">
              <StatusBadge status={order.status} />
              {paid && order.paidAt
                ? `Paid ${date(order.paidAt)}. Thank you.`
                : closed
                  ? 'Cancelled. Nothing is due.'
                  : `Created ${date(order.createdAt)}`}
            </span>
          }
          items={order.lines.map((line, index) => ({
            id: `${index}`,
            title: line.description,
            quantity: line.quantity,
            detail: line.quantity > 1 ? `${usd(line.unitMinor)} each` : null,
            amount: usd(line.amountMinor),
            icon: line.productId ? ('product' as const) : ('invoice' as const),
          }))}
          subtotal={total}
          dueToday={paid || closed ? usd(0n) : total}
        >
          {order.note && (
            <p className="max-w-md text-[15px] whitespace-pre-line text-muted-foreground">{order.note}</p>
          )}
        </OrderSummary>
      }
    >
      {paid ? (
        <CheckoutPanel
          step="success"
          receipt={
            <Notice tone="success" title="Paid">
              You paid {total} to {brand.brandName}
              {order.paidAt ? ` on ${dateTime(order.paidAt)}` : ''}. The receipt is in your account.
            </Notice>
          }
          actions={
            <Button asChild variant="dark">
              <Link href="/portal">Open your account</Link>
            </Button>
          }
        />
      ) : closed ? (
        <CheckoutPanel
          step="expired"
          title="This order was cancelled"
          message={`It can no longer be paid and nothing was charged. Ask ${brand.brandName} for a new one if you still need it.`}
        />
      ) : (
        <StartOrderCheckout
          orderId={order.id}
          amount={total}
          payer={viewer.email}
          confirming={order.status === 'pending'}
          back={back}
        />
      )}
    </CheckoutLayout>
  );
}
