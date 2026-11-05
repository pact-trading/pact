import type { Metadata } from 'next';
import Link from 'next/link';
import { InvoiceStatusChip } from '@/components/merchant/invoices/invoice-status';
import { NotConnected } from '@/components/states/not-connected';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Stat, StatGrid } from '@/components/ui/stat';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { date, dateTime, money, period, usd, usdDecimal } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';

export const metadata: Metadata = { title: 'Customer' };

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await load(async () => (await getData()).merchant.customer(id));
  if (isNotWired(detail)) return <NotConnected feature={detail.feature} />;
  const { customer, orders, subscriptions, invoices } = detail;
  return (
    <>
      <PageHeader
        back={{ href: '/dashboard/customers', label: 'Customers' }}
        title={customer.name ?? customer.email ?? 'Customer'}
        description={[customer.company, customer.email].filter(Boolean).join(' · ')}
      />
      <StatGrid>
        <Stat label="Spent" value={usd(customer.spentMinor)} />
        <Stat label="Refunded" value={usd(customer.refundedMinor)} />
        <Stat label="Orders" value={customer.orders} />
        <Stat label="Active subscriptions" value={customer.activeSubscriptions} />
      </StatGrid>
      <div className="mt-6 grid gap-6">
        <Card>
          <CardHeader title="Orders" />
          {orders.length === 0 ? (
            <EmptyState title="No orders" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Product</Th>
                  <Th align="right">Amount</Th>
                  <Th>Status</Th>
                  <Th>Date</Th>
                </tr>
              </thead>
              <tbody>
                {orders.map(o => (
                  <Tr key={o.id}>
                    <Td>
                      <Link href={`/dashboard/orders/${o.id}`} className="font-medium hover:underline">
                        {o.productName}
                      </Link>
                    </Td>
                    <Td align="right">{money(o.total)}</Td>
                    <Td>
                      <StatusBadge status={o.status} />
                    </Td>
                    <Td className="text-muted-foreground">{dateTime(o.createdAt)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader title="Subscriptions" />
            {subscriptions.length === 0 && <EmptyState title="No subscriptions" />}
            <ul className="divide-y divide-border-subtle">
              {subscriptions.map(s => (
                <li key={s.id}>
                  <Link
                    href={`/dashboard/subscriptions/${s.id}`}
                    className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-raised"
                  >
                    <div>
                      <p className="font-medium">{s.plan}</p>
                      <p className="text-sm text-muted-foreground">
                        {usdDecimal(s.amount)} / {period(s.periodSeconds)} · {s.periodsCharged} charged
                      </p>
                    </div>
                    <StatusBadge status={s.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader title="Invoices" />
            {invoices.length === 0 && <EmptyState title="No invoices" />}
            <ul className="divide-y divide-border-subtle">
              {invoices.map(i => (
                <li key={i.id}>
                  <Link
                    href={`/dashboard/invoices/${i.id}`}
                    className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-raised"
                  >
                    <div>
                      <p className="font-medium">{i.number}</p>
                      <p className="text-sm text-muted-foreground">
                        {usdDecimal(i.amount)} · due {i.dueAt ? date(i.dueAt) : 'on receipt'}
                      </p>
                    </div>
                    <InvoiceStatusChip status={i.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}
