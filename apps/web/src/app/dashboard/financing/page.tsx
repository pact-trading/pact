import type { Metadata } from 'next';
import Link from 'next/link';
import { IconBuildingBank } from '@tabler/icons-react';
import { FinancingDemoOnly } from '@/components/merchant/financing/demo-only';
import {
  AssumptionsNotice,
  FinancingBadge,
  financingLabel,
} from '@/components/merchant/financing/financing-parts';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Stat, StatGrid } from '@/components/ui/stat';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { LinkTabs } from '@/components/ui/tabs';
import { date, usd } from '@/lib/format';
import { getData } from '@/server/data';
import type { FinancingStatus } from '@/server/data/parts/financing';
import { isNotWired, load } from '@/server/load';

export const metadata: Metadata = { title: 'Invoice financing' };

const tabs: Array<FinancingStatus | 'all'> = [
  'all',
  'eligible',
  'requested',
  'funded',
  'overdue',
  'defaulted',
  'repaid',
  'bought_back',
];

const empty: Record<FinancingStatus | 'all', { title: string; body: string }> = {
  all: {
    title: 'No invoices to finance yet',
    body: 'Invoices that are sent, acknowledged by the customer, unpaid and not yet due can be financed.',
  },
  eligible: {
    title: 'No eligible invoices',
    body: 'An invoice is eligible once the customer has acknowledged it, while nothing is paid and it is not yet due.',
  },
  requested: { title: 'No open requests', body: 'Requested invoices wait here until investors buy them.' },
  funded: {
    title: 'Nothing funded',
    body: 'Invoices investors bought appear here until the customer pays.',
  },
  overdue: {
    title: 'Nothing overdue',
    body: 'A funded invoice that passes maturity unpaid appears here during its grace period.',
  },
  defaulted: {
    title: 'Nothing defaulted',
    body: 'A funded invoice still unpaid when its grace period ends appears here, with the buy-back owed.',
  },
  repaid: { title: 'Nothing repaid yet', body: 'Once a customer pays a funded invoice, it appears here.' },
  bought_back: { title: 'Nothing bought back', body: 'Defaulted invoices you bought back appear here.' },
};

export default async function FinancingPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: param } = await searchParams;
  const status = tabs.includes(param as FinancingStatus) ? (param as FinancingStatus | 'all') : 'all';
  const overview = await load(async () => (await getData()).financing.overview());
  if (isNotWired(overview))
    return <FinancingDemoOnly feature="Invoice financing" path="/dashboard/financing" />;
  const { totals } = overview;
  const rows = overview.invoices.filter(i => status === 'all' || i.status === status);
  const owed = overview.invoices.reduce((sum, i) => sum + BigInt(i.outstandingMinor), 0n);
  const face = rows.reduce((sum, i) => sum + BigInt(i.terms.faceMinor), 0n);
  const sold = rows.reduce((sum, i) => sum + BigInt(i.funding.soldMinor), 0n);
  const late = totals.overdue.count + totals.defaulted.count;
  const count = (tab: FinancingStatus | 'all') =>
    tab === 'all' ? overview.invoices.length : totals[tab].count;
  return (
    <>
      <PageHeader
        title="Invoice financing"
        description="Get paid now for invoices due later. Approved investors buy all or part of an invoice at a discount and you receive the advance; when your customer pays, the contract sends the payment straight to them."
      />
      <AssumptionsNotice assumptions={overview.assumptions} className="mb-6" />
      <StatGrid className="mb-6">
        <Stat
          label="Eligible to finance"
          value={usd(totals.eligible.faceMinor)}
          hint={`${totals.eligible.count} invoice${totals.eligible.count === 1 ? '' : 's'}, face value`}
        />
        <Stat
          label="Advances received"
          value={usd(overview.advancedMinor)}
          hint={`After Pact’s fee · ${usd(overview.reserveHeldMinor)} reserve held`}
        />
        <Stat
          label="Owed to investors"
          value={usd(owed)}
          hint={`${usd(overview.forwardedMinor)} paid to them by customers so far`}
        />
        <Stat
          label="Buy-back owed"
          value={usd(overview.buyBackOwedMinor)}
          tone={late > 0 ? 'danger' : 'default'}
          hint={`${totals.overdue.count} in grace · ${totals.defaulted.count} defaulted`}
        />
      </StatGrid>
      <LinkTabs
        label="Financing status"
        active={status}
        items={tabs.map(tab => ({
          value: tab,
          label: tab === 'all' ? 'All' : financingLabel(tab),
          href: tab === 'all' ? '/dashboard/financing' : `/dashboard/financing?status=${tab}`,
          count: count(tab),
        }))}
      />
      <Card>
        {rows.length === 0 ? (
          <EmptyState
            icon={<IconBuildingBank />}
            title={empty[status].title}
            action={
              <Button asChild size="sm">
                <Link href="/dashboard/invoices">Open invoices</Link>
              </Button>
            }
          >
            {empty[status].body}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Invoice</Th>
                <Th>Customer</Th>
                <Th>Maturity</Th>
                <Th align="right">Face value</Th>
                <Th align="right">Sold</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(i => (
                <Tr key={i.invoiceId}>
                  <Td>
                    <Link
                      href={`/dashboard/financing/${i.invoiceId}`}
                      className="font-medium hover:underline"
                    >
                      {i.number}
                    </Link>
                    {i.holders.length > 0 && (
                      <p className="text-[13px] text-muted-foreground">
                        {i.holders.map(h => h.organization).join(', ')}
                      </p>
                    )}
                  </Td>
                  <Td>
                    <p>{i.debtor.company ?? i.debtor.name}</p>
                    <p className="text-[13px] text-muted-foreground">{i.debtor.email}</p>
                  </Td>
                  <Td className="whitespace-nowrap text-muted-foreground">{date(i.terms.maturityAt)}</Td>
                  <Td align="right" className="font-medium">
                    {usd(i.terms.faceMinor)}
                  </Td>
                  <Td align="right" className="text-muted-foreground">
                    {i.status === 'eligible' ? '—' : usd(i.funding.soldMinor)}
                  </Td>
                  <Td>
                    <FinancingBadge status={i.status} />
                  </Td>
                </Tr>
              ))}
              <Tr className="bg-raised font-semibold hover:bg-raised">
                <Td>Total</Td>
                <Td className="font-normal text-muted-foreground">
                  {rows.length} invoice{rows.length === 1 ? '' : 's'}
                </Td>
                <Td />
                <Td align="right">{usd(face)}</Td>
                <Td align="right">{usd(sold)}</Td>
                <Td />
              </Tr>
            </tbody>
          </Table>
        )}
      </Card>
      {overview.ineligibleCount > 0 && (
        <p className="mt-3 text-[13px] text-muted-foreground">
          {overview.ineligibleCount} other open invoice{overview.ineligibleCount === 1 ? '' : 's'} can’t be
          financed: drafts, not yet acknowledged by the customer, part-paid or past due.{' '}
          <Link
            href="/dashboard/invoices"
            className="font-medium text-foreground underline-offset-4 hover:underline"
          >
            See all invoices
          </Link>
        </p>
      )}
    </>
  );
}
