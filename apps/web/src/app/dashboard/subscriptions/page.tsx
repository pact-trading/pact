import type { Metadata } from 'next';
import Link from 'next/link';
import { IconRepeat } from '@tabler/icons-react';
import { NewPlanButton } from '@/components/merchant/subscriptions/plan-dialog';
import { NotConnected } from '@/components/states/not-connected';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader, SectionTitle } from '@/components/ui/page-header';
import { listHref, readSort, SortHeader, sortParams, sortRows } from '@/components/ui/sort-header';
import { Stat, StatGrid } from '@/components/ui/stat';
import { Table, Td, Tr } from '@/components/ui/table';
import { LinkTabs } from '@/components/ui/tabs';
import { chargeTime, date, period, usd, usdDecimal } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { publicOrigin } from '@/server/origin';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Subscriptions' };

const statuses = [
  ['all', 'All'],
  ['trialing', 'Trialing'],
  ['active', 'Active'],
  ['past_due', 'Past due'],
  ['paused', 'Paused'],
  ['cancelled', 'Cancelled'],
] as const;
const columns = ['customer', 'plan', 'charged', 'next', 'status'] as const;
const PATH = '/dashboard/subscriptions';

export default async function SubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; sort?: string; dir?: string }>;
}) {
  const params = await searchParams;
  const { status = 'all' } = params;
  const sort = readSort(params, columns);
  const data = await getData();
  const [plans, subs, refusals, viewer, origin, managed] = await Promise.all([
    load(() => data.merchant.plans()),
    load(() => data.merchant.subscriptions()),
    load(() => data.merchant.refusals({ source: 'subscription' })),
    getViewer(),
    publicOrigin(),
    // Archived plans take no new signups; without plan management every plan is shown as open.
    data.commerce.plans().catch(() => null),
  ]);
  if (isNotWired(plans)) return <NotConnected feature={plans.feature} />;
  if (isNotWired(subs)) return <NotConnected feature={subs.feature} />;
  const archived = new Set(managed?.filter(p => p.status === 'archived').map(p => p.id));
  const mrr = plans.reduce((t, p) => t + BigInt(p.monthlyRecurringMinor), 0n);
  const shown = sortRows(
    subs.filter(s => status === 'all' || s.status === status),
    sort,
    {
      customer: s => s.customerName ?? s.customerEmail,
      plan: s => s.plan,
      charged: s => s.periodsCharged,
      next: s => (s.status === 'cancelled' || s.status === 'paused' ? null : s.nextChargeAt),
      status: s => s.status,
    },
  );
  const header = { sort, path: PATH, params: { status: status === 'all' ? undefined : status } };
  return (
    <>
      <PageHeader
        title="Subscriptions"
        description="Recurring billing with a cap the customer signs. Pulls above the cap, too early, or after cancelling are refused onchain."
        actions={viewer?.role === 'merchant' && <NewPlanButton />}
      />
      <StatGrid>
        <Stat label="Monthly recurring" value={usd(mrr)} />
        <Stat label="Active" value={subs.filter(s => s.status === 'active').length} />
        <Stat
          label="Past due"
          value={subs.filter(s => s.status === 'past_due').length}
          tone={subs.some(s => s.status === 'past_due') ? 'warning' : 'default'}
          hint="Retried daily, 3 times"
        />
        <Stat
          label="Refused pulls"
          value={isNotWired(refusals) ? '—' : refusals.length}
          hint="Every refusal is a public event"
        />
      </StatGrid>
      <SectionTitle
        action={
          managed && (
            <Button asChild size="sm" variant="ghost">
              <Link href="/dashboard/plans">Manage plans</Link>
            </Button>
          )
        }
      >
        Plans
      </SectionTitle>
      <div className="grid gap-4 md:grid-cols-3">
        {plans.map(p => (
          <Card key={p.id}>
            <CardBody>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="flex flex-wrap items-center gap-2 font-semibold">
                    {p.name}
                    {archived.has(p.id) && <Badge tone="outline">Archived</Badge>}
                  </h3>
                  <p className="text-sm text-muted-foreground">{p.description}</p>
                </div>
                {!archived.has(p.id) && (
                  <CopyButton value={`${origin}/subscribe/${p.id}`} label="Copy subscribe link" />
                )}
              </div>
              <p className="mt-4 text-2xl font-semibold">
                {usdDecimal(p.amount)}
                <span className="text-base font-normal text-muted-foreground">
                  {' '}
                  / {period(p.periodSeconds)}
                </span>
              </p>
              <p className="mt-1 text-[13px] text-muted-foreground">
                {p.maxPeriods ? `Up to ${p.maxPeriods} periods` : 'Until cancelled'}
              </p>
              <div className="mt-4 flex justify-between border-t border-border-subtle pt-3 text-sm">
                <span className="text-muted-foreground">{p.activeSubscribers} subscribers</span>
                <span className="font-medium">{usd(p.monthlyRecurringMinor)} / mo</span>
              </div>
            </CardBody>
          </Card>
        ))}
      </div>
      <SectionTitle>Subscribers</SectionTitle>
      <LinkTabs
        label="Subscription status"
        active={status}
        items={statuses.map(([value, label]) => ({
          value,
          label,
          href: listHref(PATH, { status: value === 'all' ? undefined : value, ...sortParams(sort) }),
          count: subs.filter(s => value === 'all' || s.status === value).length,
        }))}
      />
      <Card>
        {shown.length === 0 ? (
          <EmptyState icon={<IconRepeat />} title="No subscriptions here" />
        ) : (
          <Table>
            <thead>
              <tr>
                <SortHeader label="Customer" column="customer" {...header} />
                <SortHeader label="Plan" column="plan" {...header} />
                <SortHeader label="Charged" column="charged" align="right" first="desc" {...header} />
                <SortHeader label="Next pull" column="next" {...header} />
                <SortHeader label="Status" column="status" {...header} />
              </tr>
            </thead>
            <tbody>
              {shown.map(s => (
                <Tr key={s.id}>
                  <Td>
                    <Link href={`/dashboard/subscriptions/${s.id}`} className="font-medium hover:underline">
                      {s.customerName ?? s.customerEmail}
                    </Link>
                    <p className="text-[13px] text-muted-foreground">{s.customerEmail}</p>
                  </Td>
                  <Td>
                    {s.plan}
                    <p className="text-[13px] text-muted-foreground">
                      {usdDecimal(s.amount)} / {period(s.periodSeconds)}
                    </p>
                  </Td>
                  <Td align="right">
                    {s.periodsCharged}
                    {s.maxPeriods ? ` of ${s.maxPeriods}` : ''}
                  </Td>
                  <Td className="text-muted-foreground">
                    {s.status === 'cancelled' || s.status === 'paused'
                      ? '—'
                      : `${s.status === 'trialing' ? 'Trial ends ' : ''}${chargeTime(s.nextChargeAt, s.periodSeconds)}`}
                  </Td>
                  <Td>
                    <StatusBadge status={s.status} />
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
