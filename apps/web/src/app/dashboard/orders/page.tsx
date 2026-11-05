import type { Metadata } from 'next';
import Link from 'next/link';
import { IconPlus, IconShoppingBag } from '@tabler/icons-react';
import { SearchBox } from '@/components/merchant/search-box';
import { NotConnected } from '@/components/states/not-connected';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { listHref, readSort, SortHeader, sortParams, sortRows } from '@/components/ui/sort-header';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { LinkTabs } from '@/components/ui/tabs';
import { dateTime, money, usd } from '@/lib/format';
import { getData } from '@/server/data';
import type { OrderSource } from '@/server/data/parts/commerce';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Orders' };

const statuses = [
  ['all', 'All'],
  ['paid', 'Paid'],
  ['partially_refunded', 'Partly refunded'],
  ['refunded', 'Refunded'],
  ['open', 'Open'],
  ['pending', 'Processing'],
  ['expired', 'Abandoned'],
] as const;
const columns = ['order', 'customer', 'source', 'amount', 'status', 'created'] as const;
const PATH = '/dashboard/orders';

const sourceLabel = (source: OrderSource | undefined) =>
  !source ? 'Checkout' : source.kind === 'link' ? 'Payment link' : 'Manual order';

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; sort?: string; dir?: string }>;
}) {
  const params = await searchParams;
  const { status = 'all', q } = params;
  const sort = readSort(params, columns);
  const data = await getData();
  const [all, viewer, sources] = await Promise.all([
    load(() => data.merchant.orders({ query: q })),
    getViewer(),
    // Where each order came from; the list still works without it.
    data.commerce.orderSources().catch(() => null),
  ]);
  if (isNotWired(all)) return <NotConnected feature={all.feature} />;
  const orders = sortRows(
    all.filter(o => status === 'all' || o.status === status),
    sort,
    {
      order: o => o.productName,
      customer: o => o.customerName ?? o.customerEmail,
      source: o => sourceLabel(sources?.[o.id]),
      amount: o => BigInt(o.total.amountMinor),
      status: o => o.status,
      created: o => o.createdAt,
    },
  );
  const keep = { status: status === 'all' ? undefined : status, q };
  const header = { sort, path: PATH, params: keep };
  const canWrite = viewer?.role === 'merchant';
  return (
    <>
      <PageHeader
        title="Orders"
        description="Every checkout, payment link and manual order, with its payment, refunds and public record."
        actions={
          <>
            <SearchBox
              placeholder="Search orders or customers"
              value={q}
              keep={{ status: keep.status, ...sortParams(sort) }}
            />
            {canWrite && (
              <Button asChild variant="primary" size="sm">
                <Link href="/dashboard/orders/new">
                  <IconPlus className="size-4" />
                  Create order
                </Link>
              </Button>
            )}
          </>
        }
      />
      <LinkTabs
        label="Order status"
        active={status}
        items={statuses.map(([value, label]) => ({
          value,
          label,
          href: listHref(PATH, { status: value === 'all' ? undefined : value, q, ...sortParams(sort) }),
          count: all.filter(o => value === 'all' || o.status === value).length,
        }))}
      />
      <Card>
        {orders.length === 0 ? (
          <EmptyState icon={<IconShoppingBag />} title="No orders here">
            {q ? `Nothing matches “${q}”.` : 'Orders appear when customers check out or pay a link.'}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <SortHeader label="Order" column="order" {...header} />
                <SortHeader label="Customer" column="customer" {...header} />
                {sources && <SortHeader label="Source" column="source" {...header} />}
                <SortHeader label="Amount" column="amount" align="right" first="desc" {...header} />
                <SortHeader label="Status" column="status" {...header} />
                <SortHeader label="Created" column="created" first="desc" {...header} />
              </tr>
            </thead>
            <tbody>
              {orders.map(order => {
                const source = sources?.[order.id];
                return (
                  <Tr key={order.id}>
                    <Td>
                      <Link href={`${PATH}/${order.id}`} className="font-medium hover:underline">
                        {order.productName}
                      </Link>
                      <p className="font-mono text-[12px] text-muted-foreground">{order.id}</p>
                    </Td>
                    <Td>
                      <p>{order.customerName ?? 'Customer'}</p>
                      <p className="text-[13px] text-muted-foreground">{order.customerEmail}</p>
                    </Td>
                    {sources && (
                      <Td>
                        <p>{sourceLabel(source)}</p>
                        {source?.kind === 'link' && (
                          <Link
                            href={`/dashboard/payment-links/${source.linkId}`}
                            className="block max-w-44 truncate text-[13px] text-muted-foreground hover:text-foreground hover:underline"
                          >
                            {source.label}
                          </Link>
                        )}
                      </Td>
                    )}
                    <Td align="right">
                      <p className="font-medium" data-testid="order-amount">
                        {money(order.total)}
                      </p>
                      {order.refundedMinor !== '0' && (
                        <p className="text-[13px] text-muted-foreground">
                          −{usd(order.refundedMinor)} refunded
                        </p>
                      )}
                    </Td>
                    <Td>
                      <StatusBadge status={order.status} />
                    </Td>
                    <Td className="text-muted-foreground">{dateTime(order.createdAt)}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
