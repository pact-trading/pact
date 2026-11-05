import type { Metadata } from 'next';
import Link from 'next/link';
import { IconUsers } from '@tabler/icons-react';
import { SearchBox } from '@/components/merchant/search-box';
import { NotConnected } from '@/components/states/not-connected';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { readSort, SortHeader, sortParams, sortRows } from '@/components/ui/sort-header';
import { Table, Td, Tr } from '@/components/ui/table';
import { date, usd } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';

export const metadata: Metadata = { title: 'Customers' };

const columns = ['customer', 'orders', 'spent', 'refunded', 'subscriptions', 'activity'] as const;

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string; dir?: string }>;
}) {
  const params = await searchParams;
  const { q } = params;
  const sort = readSort(params, columns);
  const all = await load(async () => (await getData()).merchant.customers({ query: q }));
  if (isNotWired(all)) return <NotConnected feature={all.feature} />;
  const customers = sortRows(all, sort, {
    customer: c => c.name ?? c.email,
    orders: c => c.orders,
    spent: c => BigInt(c.spentMinor),
    refunded: c => BigInt(c.refundedMinor),
    subscriptions: c => c.activeSubscriptions,
    activity: c => c.lastActivityAt,
  });
  const header = { sort, path: '/dashboard/customers', params: { q } };
  return (
    <>
      <PageHeader
        title="Customers"
        description="People and companies who paid you, with what they spent and what they subscribe to."
        actions={<SearchBox placeholder="Search customers" value={q} keep={sortParams(sort)} />}
      />
      <Card>
        {customers.length === 0 ? (
          <EmptyState icon={<IconUsers />} title="No customers found" />
        ) : (
          <Table>
            <thead>
              <tr>
                <SortHeader label="Customer" column="customer" {...header} />
                <SortHeader label="Orders" column="orders" align="right" first="desc" {...header} />
                <SortHeader label="Spent" column="spent" align="right" first="desc" {...header} />
                <SortHeader label="Refunded" column="refunded" align="right" first="desc" {...header} />
                <SortHeader
                  label="Subscriptions"
                  column="subscriptions"
                  align="right"
                  first="desc"
                  {...header}
                />
                <SortHeader label="Last activity" column="activity" first="desc" {...header} />
              </tr>
            </thead>
            <tbody>
              {customers.map(c => (
                <Tr key={c.id}>
                  <Td>
                    <Link href={`/dashboard/customers/${c.id}`} className="font-medium hover:underline">
                      {c.name ?? c.email}
                    </Link>
                    <p className="text-[13px] text-muted-foreground">
                      {c.company ? `${c.company} · ` : ''}
                      {c.email}
                    </p>
                  </Td>
                  <Td align="right">{c.orders}</Td>
                  <Td align="right" className="font-medium">
                    {usd(c.spentMinor)}
                  </Td>
                  <Td align="right" className="text-muted-foreground">
                    {c.refundedMinor === '0' ? '—' : usd(c.refundedMinor)}
                  </Td>
                  <Td align="right">{c.activeSubscriptions || '—'}</Td>
                  <Td className="text-muted-foreground">{c.lastActivityAt ? date(c.lastActivityAt) : '—'}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
