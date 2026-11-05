import type { Metadata } from 'next';
import Link from 'next/link';
import { IconPlus, IconStack2 } from '@tabler/icons-react';
import { PlanStatusButton } from '@/components/merchant/plans/plan-status-button';
import { NotConnected } from '@/components/states/not-connected';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { listHref, readSort, SortHeader, sortParams, sortRows } from '@/components/ui/sort-header';
import { Stat, StatGrid } from '@/components/ui/stat';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { LinkTabs } from '@/components/ui/tabs';
import { period, toMinor, usd, usdDecimal } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { publicOrigin } from '@/server/origin';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Plans' };

const statuses = [
  ['all', 'All'],
  ['active', 'Active'],
  ['archived', 'Archived'],
] as const;
const columns = ['name', 'price', 'interval', 'cap', 'subscribers', 'mrr'] as const;
const PATH = '/dashboard/plans';

function NewPlanLink() {
  return (
    <Button asChild variant="primary" size="sm">
      <Link href="/dashboard/plans/new">
        <IconPlus className="size-4" />
        New plan
      </Link>
    </Button>
  );
}

export default async function PlansPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; sort?: string; dir?: string }>;
}) {
  const params = await searchParams;
  const { status = 'all' } = params;
  const sort = readSort(params, columns);
  const [all, viewer, origin] = await Promise.all([
    load(async () => (await getData()).commerce.plans()),
    getViewer(),
    publicOrigin(),
  ]);
  if (isNotWired(all)) return <NotConnected feature={all.feature} />;
  const canWrite = viewer?.role === 'merchant';
  const plans = sortRows(
    all.filter(p => status === 'all' || p.status === status),
    sort,
    {
      name: p => p.name,
      price: p => toMinor(p.amount),
      interval: p => p.periodSeconds,
      cap: p => p.maxPeriods,
      subscribers: p => p.activeSubscribers,
      mrr: p => BigInt(p.monthlyRecurringMinor),
    },
  );
  const header = { sort, path: PATH, params: { status: status === 'all' ? undefined : status } };
  const mrr = all.reduce((t, p) => t + BigInt(p.monthlyRecurringMinor), 0n);
  return (
    <>
      <PageHeader
        title="Plans"
        description="Recurring prices customers subscribe to with one signature. Archive a plan to stop new signups; current subscribers keep theirs."
        actions={canWrite && <NewPlanLink />}
      />
      <StatGrid className="mb-6">
        <Stat
          label="Taking signups"
          value={all.filter(p => p.status === 'active').length}
          hint={`of ${all.length} plans`}
        />
        <Stat
          label="Subscribers"
          value={all.reduce((t, p) => t + p.activeSubscribers, 0)}
          hint="Active or retrying"
        />
        <Stat label="Monthly recurring" value={usd(mrr)} />
        <Stat
          label="Archived"
          value={all.filter(p => p.status === 'archived').length}
          hint={
            <Link href="/dashboard/subscriptions" className="underline-offset-4 hover:underline">
              See subscribers
            </Link>
          }
        />
      </StatGrid>
      <LinkTabs
        label="Plan status"
        active={status}
        items={statuses.map(([value, label]) => ({
          value,
          label,
          href: listHref(PATH, { status: value === 'all' ? undefined : value, ...sortParams(sort) }),
          count: all.filter(p => value === 'all' || p.status === value).length,
        }))}
      />
      <Card>
        {plans.length === 0 ? (
          <EmptyState
            icon={<IconStack2 />}
            title={all.length === 0 ? 'No plans yet' : 'No plans here'}
            action={canWrite && all.length === 0 && <NewPlanLink />}
          >
            {all.length === 0
              ? 'Create a plan to share a subscribe link. Customers sign once; every renewal is capped.'
              : 'No plans have this status.'}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <SortHeader label="Plan" column="name" {...header} />
                <SortHeader label="Price" column="price" align="right" first="desc" {...header} />
                <SortHeader label="Interval" column="interval" {...header} />
                <SortHeader label="Cap" column="cap" align="right" first="desc" {...header} />
                <SortHeader label="Subscribers" column="subscribers" align="right" first="desc" {...header} />
                <SortHeader label="Monthly recurring" column="mrr" align="right" first="desc" {...header} />
                <Th>Status</Th>
                <Th align="right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {plans.map(p => (
                <Tr key={p.id}>
                  <Td>
                    <p className="font-medium">{p.name}</p>
                    <p className="max-w-xs truncate text-[13px] text-muted-foreground">
                      {p.description || p.id}
                    </p>
                  </Td>
                  <Td align="right" className="font-medium">
                    {usdDecimal(p.amount)}
                  </Td>
                  <Td className="text-muted-foreground">Every {period(p.periodSeconds)}</Td>
                  <Td align="right">
                    {p.maxPeriods ? (
                      <>
                        <p>{p.maxPeriods} periods</p>
                        <p className="text-[13px] text-muted-foreground">
                          {usd(toMinor(p.amount) * BigInt(p.maxPeriods))} max
                        </p>
                      </>
                    ) : (
                      <span className="text-muted-foreground">Until cancelled</span>
                    )}
                  </Td>
                  <Td align="right">{p.activeSubscribers}</Td>
                  <Td align="right">{usd(p.monthlyRecurringMinor)}</Td>
                  <Td>
                    <StatusBadge status={p.status} />
                  </Td>
                  <Td align="right">
                    <div className="flex items-center justify-end gap-1.5">
                      {p.status === 'active' && (
                        <CopyButton
                          value={`${origin}/subscribe/${p.id}`}
                          label={`Copy subscribe link for ${p.name}`}
                        />
                      )}
                      {canWrite && <PlanStatusButton id={p.id} name={p.name} status={p.status} />}
                    </div>
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
