import type { Metadata } from 'next';
import Link from 'next/link';
import { IconFileInvoice, IconPlus } from '@tabler/icons-react';
import { InvoiceStatusChip, invoiceStatusLabel } from '@/components/merchant/invoices/invoice-status';
import { SearchBox } from '@/components/merchant/search-box';
import { NotConnected } from '@/components/states/not-connected';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { listHref, readSort, SortHeader, sortParams, sortRows } from '@/components/ui/sort-header';
import { Stat, StatGrid } from '@/components/ui/stat';
import { Table, Td, Tr } from '@/components/ui/table';
import { LinkTabs } from '@/components/ui/tabs';
import { date, toMinor, usd, usdDecimal } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Invoices' };

const statuses = [
  ['all', 'All'],
  ['draft', 'Draft'],
  ['sent', 'Awaiting payment'],
  ['acknowledged', 'Acknowledged'],
  ['partially_paid', 'Partly paid'],
  ['overdue', 'Overdue'],
  ['paid', 'Paid'],
] as const;
const columns = ['number', 'customer', 'due', 'amount', 'remaining', 'status'] as const;
const PATH = '/dashboard/invoices';

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; sort?: string; dir?: string }>;
}) {
  const params = await searchParams;
  const { status = 'all', q } = params;
  const sort = readSort(params, columns);
  const data = await getData();
  const [all, viewer, demo] = await Promise.all([
    load(() => data.merchant.invoices({ query: q })),
    getViewer(),
    data.demo?.state(),
  ]);
  if (isNotWired(all)) return <NotConnected feature={all.feature} />;
  const now = demo?.now ?? new Date().toISOString();
  const invoices = sortRows(
    all.filter(i => status === 'all' || i.status === status),
    sort,
    {
      number: i => i.number,
      customer: i => i.customerName ?? i.customerEmail,
      due: i => i.dueAt,
      amount: i => toMinor(i.amount),
      remaining: i => toMinor(i.remaining),
      status: i => invoiceStatusLabel(i.status),
    },
  );
  const keep = { status: status === 'all' ? undefined : status, q };
  const header = { sort, path: PATH, params: keep };
  const open = all.filter(i => !['draft', 'paid'].includes(i.status));
  const outstanding = open.reduce((t, i) => t + toMinor(i.remaining), 0n);
  const overdue = all.filter(i => i.status === 'overdue').reduce((t, i) => t + toMinor(i.remaining), 0n);
  const href = (next: string) =>
    listHref(PATH, { status: next === 'all' ? undefined : next, q, ...sortParams(sort) });
  return (
    <>
      <PageHeader
        title="Invoices"
        description="Bill clients in USDT. They acknowledge with one signature and pay with no fees, crypto steps or wallet."
        actions={
          <>
            <SearchBox
              placeholder="Search invoices"
              value={q}
              keep={{ status: keep.status, ...sortParams(sort) }}
            />
            {viewer?.role === 'merchant' && (
              <Button asChild variant="primary" size="sm">
                <Link href="/dashboard/invoices/new">
                  <IconPlus className="size-4" />
                  New invoice
                </Link>
              </Button>
            )}
          </>
        }
      />
      <StatGrid className="mb-6 lg:grid-cols-3">
        <Stat label="Outstanding" value={usd(outstanding)} hint={`${open.length} open invoices`} />
        <Stat
          label="Overdue"
          value={usd(overdue)}
          tone={overdue > 0n ? 'danger' : 'default'}
          hint="Reminders sent automatically"
        />
        <Stat
          label="Acknowledged"
          value={all.filter(i => i.acknowledgement).length}
          hint="Payer signed “I owe this invoice”"
        />
      </StatGrid>
      <LinkTabs
        label="Invoice status"
        active={status}
        items={statuses.map(([value, label]) => ({
          value,
          label,
          href: href(value),
          count: all.filter(i => value === 'all' || i.status === value).length,
        }))}
      />
      <Card>
        {invoices.length === 0 ? (
          <EmptyState icon={<IconFileInvoice />} title="No invoices here">
            {q ? `Nothing matches “${q}”.` : undefined}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <SortHeader label="Invoice" column="number" {...header} />
                <SortHeader label="Billed to" column="customer" {...header} />
                <SortHeader label="Due" column="due" {...header} />
                <SortHeader label="Amount" column="amount" align="right" first="desc" {...header} />
                <SortHeader label="Remaining" column="remaining" align="right" first="desc" {...header} />
                <SortHeader label="Status" column="status" {...header} />
              </tr>
            </thead>
            <tbody>
              {invoices.map(i => (
                <Tr key={i.id}>
                  <Td>
                    <Link href={`/dashboard/invoices/${i.id}`} className="font-medium hover:underline">
                      {i.number}
                    </Link>
                  </Td>
                  <Td>
                    <p>{i.customerName}</p>
                    <p className="text-[13px] text-muted-foreground">{i.customerEmail}</p>
                  </Td>
                  <Td className="text-muted-foreground">{i.dueAt ? date(i.dueAt) : 'On receipt'}</Td>
                  <Td align="right" className="font-medium">
                    {usdDecimal(i.amount)}
                  </Td>
                  <Td align="right">{usdDecimal(i.remaining)}</Td>
                  <Td>
                    <InvoiceStatusChip
                      status={i.status}
                      dueAt={i.dueAt}
                      now={now}
                      className="whitespace-nowrap"
                    />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
