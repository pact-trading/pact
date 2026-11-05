import type { Metadata } from 'next';
import Link from 'next/link';
import { IconArrowUpRight, IconReceiptRefund } from '@tabler/icons-react';
import { SearchBox } from '@/components/merchant/search-box';
import { NotConnected } from '@/components/states/not-connected';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { listHref, readSort, SortHeader, sortParams, sortRows } from '@/components/ui/sort-header';
import { Stat, StatGrid } from '@/components/ui/stat';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { LinkTabs } from '@/components/ui/tabs';
import { explorerIsMock, txUrl } from '@/lib/explorer';
import { dateTime, shortHash, usd } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';

export const metadata: Metadata = { title: 'Refunds' };

const statuses = [
  ['all', 'All'],
  ['succeeded', 'Succeeded'],
  ['pending', 'Pending'],
  ['failed', 'Failed'],
] as const;
const columns = ['amount', 'order', 'customer', 'reason', 'status', 'date'] as const;
const PATH = '/dashboard/refunds';

export default async function RefundsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; sort?: string; dir?: string }>;
}) {
  const params = await searchParams;
  const { status = 'all', q } = params;
  const sort = readSort(params, columns);
  const all = await load(async () => (await getData()).commerce.refunds({ query: q }));
  if (isNotWired(all)) return <NotConnected feature={all.feature} />;
  const refunds = sortRows(
    all.filter(r => status === 'all' || r.status === status),
    sort,
    {
      amount: r => BigInt(r.amountMinor),
      order: r => r.description ?? r.orderId ?? r.paymentId,
      customer: r => r.customerName ?? r.customerEmail,
      reason: r => r.reason,
      status: r => r.status,
      date: r => r.createdAt,
    },
  );
  const sum = (status: string) =>
    all.filter(r => r.status === status).reduce((t, r) => t + BigInt(r.amountMinor), 0n);
  const keep = { status: status === 'all' ? undefined : status, q };
  const header = { sort, path: PATH, params: keep };
  return (
    <>
      <PageHeader
        title="Refunds"
        description="Every refund you sent, with the order it came from and its public record."
        actions={
          <SearchBox
            placeholder="Search refunds"
            value={q}
            keep={{ status: keep.status, ...sortParams(sort) }}
          />
        }
      />
      <StatGrid className="mb-6">
        <Stat
          label="Refunded"
          value={usd(sum('succeeded'))}
          hint={`${all.filter(r => r.status === 'succeeded').length} confirmed`}
        />
        <Stat
          label="Pending"
          value={usd(sum('pending'))}
          tone={sum('pending') > 0n ? 'warning' : 'default'}
          hint="Waiting for confirmation"
        />
        <Stat
          label="Failed"
          value={all.filter(r => r.status === 'failed').length}
          tone={all.some(r => r.status === 'failed') ? 'danger' : 'default'}
          hint="Nothing left your account"
        />
        <Stat label="Refunds" value={all.length} hint={q ? `Matching “${q}”` : 'All time'} />
      </StatGrid>
      <LinkTabs
        label="Refund status"
        active={status}
        items={statuses.map(([value, label]) => ({
          value,
          label,
          href: listHref(PATH, { status: value === 'all' ? undefined : value, q, ...sortParams(sort) }),
          count: all.filter(r => value === 'all' || r.status === value).length,
        }))}
      />
      <Card>
        {refunds.length === 0 ? (
          <EmptyState
            icon={<IconReceiptRefund />}
            title={all.length === 0 && !q ? 'No refunds yet' : 'No refunds here'}
            action={
              all.length === 0 &&
              !q && (
                <Button asChild size="sm">
                  <Link href="/dashboard/orders">View orders</Link>
                </Button>
              )
            }
          >
            {q
              ? `Nothing matches “${q}”.`
              : all.length === 0
                ? 'Open a paid order and choose Refund. Each refund is listed here with its record.'
                : 'No refunds have this status.'}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <SortHeader label="Amount" column="amount" align="right" first="desc" {...header} />
                <SortHeader label="Order" column="order" {...header} />
                <SortHeader label="Customer" column="customer" {...header} />
                <SortHeader label="Reason" column="reason" {...header} />
                <SortHeader label="Status" column="status" {...header} />
                <SortHeader label="Date" column="date" first="desc" {...header} />
                <Th>Record</Th>
              </tr>
            </thead>
            <tbody>
              {refunds.map(r => (
                <Tr key={r.id}>
                  <Td align="right" className="font-medium">
                    {usd(r.amountMinor)}
                  </Td>
                  <Td>
                    {r.orderId ? (
                      <Link href={`/dashboard/orders/${r.orderId}`} className="font-medium hover:underline">
                        {r.description ?? r.orderId}
                      </Link>
                    ) : (
                      <span className="font-medium">{r.description ?? 'Payment'}</span>
                    )}
                    <p className="font-mono text-[12px] text-muted-foreground">
                      {r.orderId ?? (r.paymentId ? shortHash(r.paymentId) : r.id)}
                    </p>
                  </Td>
                  <Td>
                    {r.customerId && r.customerName ? (
                      <Link href={`/dashboard/customers/${r.customerId}`} className="hover:underline">
                        {r.customerName}
                      </Link>
                    ) : r.customerName ? (
                      <p>{r.customerName}</p>
                    ) : (
                      !r.customerEmail && <span className="text-muted-foreground">—</span>
                    )}
                    {r.customerEmail && (
                      <p className="text-[13px] text-muted-foreground">{r.customerEmail}</p>
                    )}
                  </Td>
                  <Td className="max-w-56 text-muted-foreground">
                    <p className="truncate" title={r.reason ?? undefined}>
                      {r.reason ?? '—'}
                    </p>
                  </Td>
                  <Td>
                    <StatusBadge status={r.status} />
                  </Td>
                  <Td className="whitespace-nowrap text-muted-foreground">{dateTime(r.createdAt)}</Td>
                  <Td>
                    {r.txHash ? (
                      <a
                        href={txUrl(r.txHash)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
                        title={explorerIsMock ? 'Opens the demo explorer' : 'Opens the Whitechain explorer'}
                      >
                        <code className="font-mono text-[13px]">{shortHash(r.txHash)}</code>
                        <IconArrowUpRight aria-hidden className="size-3.5" />
                        <span className="sr-only">View refund {r.id} on the explorer</span>
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
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
