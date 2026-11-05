import type { Metadata } from 'next';
import Link from 'next/link';
import { IconCircleCheckFilled } from '@tabler/icons-react';
import { CheckoutLayout, OrderSummary } from '@/components/customer/checkout-layout';
import { CheckoutNotWired } from '@/components/customer/checkout/not-wired';
import { CheckoutPanel } from '@/components/customer/checkout/panel';
import { SignInCard } from '@/components/customer/sign-in-card';
import { AcknowledgeButton } from '@/components/customer/signed-buttons';
import { StartInvoiceCheckout } from '@/components/customer/start-checkout';
import { PublicRecord } from '@/components/states/public-record';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { date, dateTime, toMinor, usdDecimal } from '@/lib/format';
import { getData } from '@/server/data';
import { MOCK_VIEWERS } from '@/server/data/mock/viewers';
import { isNotWired, load } from '@/server/load';
import { isMock } from '@/server/mode';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Invoice' };
export const dynamic = 'force-dynamic';

export default async function HostedInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await getViewer();
  const data = await getData();
  // Who sent the invoice, shown even before sign-in; a neutral label where the API has no lookup.
  const brand = await data.checkout
    .invoiceBrand(id)
    .catch(() => ({ brandName: 'Invoice', logoUrl: null, brandColor: null }));
  const back = { href: '/portal/invoices', label: 'Back', history: true };
  if (viewer?.role !== 'customer')
    return (
      <CheckoutLayout
        brand={brand}
        summary={
          <div className="grid gap-1">
            <p className="text-[15px] text-muted-foreground">You have an invoice</p>
            <h1 className="text-3xl leading-tight font-semibold tracking-tight">
              Sign in to view and pay it
            </h1>
          </div>
        }
      >
        <SignInCard
          next={`/invoice/${id}`}
          title="View your invoice"
          mockEmail={isMock ? MOCK_VIEWERS.find(v => v.role === 'customer')?.email : undefined}
        />
      </CheckoutLayout>
    );
  const [invoice, demo] = await Promise.all([load(() => data.customer.invoice(id)), data.demo?.state()]);
  if (isNotWired(invoice)) return <CheckoutNotWired feature={invoice.feature} />;
  const paid = invoice.status === 'paid';
  const dueToday = invoice.dueAt && demo ? invoice.dueAt.slice(0, 10) === demo.now.slice(0, 10) : false;
  const ack = invoice.acknowledgement;
  return (
    <CheckoutLayout
      brand={{ ...brand, brandName: invoice.merchantName }}
      back={back}
      summary={
        <OrderSummary
          eyebrow={`Invoice ${invoice.number}`}
          title={`Invoice ${invoice.number} from ${invoice.merchantName}`}
          amount={usdDecimal(invoice.remaining)}
          totalNote={
            <span className="flex flex-wrap items-center gap-2">
              <StatusBadge status={invoice.status} />
              {paid
                ? 'Paid in full. Thank you.'
                : `Due ${invoice.dueAt ? date(invoice.dueAt) : 'on receipt'}${dueToday ? ' (today)' : ''} · billed to ${invoice.customerName}`}
            </span>
          }
          items={invoice.lines.map(line => ({
            id: line.id,
            title: line.description,
            quantity: line.quantity,
            amount: usdDecimal(line.amount),
            icon: 'invoice' as const,
          }))}
          subtotal={usdDecimal(invoice.amount)}
          rows={
            toMinor(invoice.paid) > 0n
              ? [{ label: 'Already paid', value: `−${usdDecimal(invoice.paid)}` }]
              : []
          }
          dueToday={usdDecimal(invoice.remaining)}
        >
          {invoice.memo && <p className="max-w-md text-[15px] text-muted-foreground">{invoice.memo}</p>}
        </OrderSummary>
      }
    >
      {paid ? (
        <CheckoutPanel
          step="success"
          receipt={
            <Notice tone="success" title="Paid in full">
              Every payment is in your account with its public record.
            </Notice>
          }
          actions={
            <Button asChild variant="dark">
              <Link href="/portal/invoices">Your invoices</Link>
            </Button>
          }
        />
      ) : (
        <StartInvoiceCheckout
          invoiceId={invoice.id}
          email={viewer.email}
          remainingMinor={toMinor(invoice.remaining).toString()}
          allowPartial={invoice.allowPartial}
          back={back}
          before={
            <div className="grid gap-3 rounded-[var(--checkout-radius,16px)] border border-border p-4">
              <p className="text-sm font-semibold">Acknowledge the invoice</p>
              {ack ? (
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-subtle-foreground">
                  <IconCircleCheckFilled aria-hidden className="size-4.5 text-success" />
                  You confirmed you owe this invoice on {dateTime(ack.signedAt)}.
                  <PublicRecord hash={ack.txHash} audience="customer" />
                </p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">
                    Optional. One signature saying “I owe this invoice”. It costs you nothing.
                  </p>
                  <AcknowledgeButton invoiceId={invoice.id} number={invoice.number} />
                </>
              )}
            </div>
          }
        />
      )}
    </CheckoutLayout>
  );
}
