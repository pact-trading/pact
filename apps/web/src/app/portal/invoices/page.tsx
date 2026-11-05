import type { Metadata } from 'next';
import Link from 'next/link';
import { IconArrowRight, IconFileInvoice } from '@tabler/icons-react';
import { NotConnected } from '@/components/states/not-connected';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { date, toMinor, usd, usdDecimal } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';

export const metadata: Metadata = { title: 'Invoices' };

export default async function PortalInvoicesPage() {
  const invoices = await load(async () => (await getData()).customer.invoices());
  if (isNotWired(invoices)) return <NotConnected feature={invoices.feature} />;
  const open = invoices.filter(i => i.status !== 'paid');
  const paid = invoices.filter(i => i.status === 'paid');
  const due = open.reduce((t, i) => t + toMinor(i.remaining), 0n);
  const row = (i: (typeof invoices)[number]) => (
    <li key={i.id}>
      <Link
        href={`/invoice/${i.id}`}
        className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hover:bg-raised"
      >
        <div>
          <p className="font-medium">
            {i.number} · {i.merchantName}
          </p>
          <p className="text-sm text-muted-foreground">
            {usdDecimal(i.amount)} ·{' '}
            {i.status === 'paid' ? 'paid' : `due ${i.dueAt ? date(i.dueAt) : 'on receipt'}`}
            {i.acknowledgement ? ' · acknowledged' : ''}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {i.status !== 'paid' && <span className="font-semibold">{usdDecimal(i.remaining)}</span>}
          <StatusBadge status={i.status} />
          {i.status !== 'paid' && (
            <span className="hidden items-center gap-1 text-sm font-medium sm:inline-flex">
              Pay <IconArrowRight className="size-3.5" />
            </span>
          )}
        </div>
      </Link>
    </li>
  );
  return (
    <>
      <PageHeader
        title="Invoices"
        description="Acknowledge and pay invoices from businesses you work with."
      />
      {invoices.length === 0 ? (
        <Card>
          <EmptyState icon={<IconFileInvoice />} title="No invoices">
            When a business sends you an invoice, it appears here to acknowledge and pay.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid gap-6">
          <Card>
            <CardHeader
              title="To pay"
              description={open.length ? `${usd(due)} due across ${open.length}` : undefined}
            />
            {open.length === 0 ? (
              <EmptyState title="Nothing due">You are all paid up.</EmptyState>
            ) : (
              <ul className="divide-y divide-border-subtle">{open.map(row)}</ul>
            )}
          </Card>
          {paid.length > 0 && (
            <Card>
              <CardHeader title="Paid" />
              <ul className="divide-y divide-border-subtle">{paid.map(row)}</ul>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
