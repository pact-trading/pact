import type { Metadata } from 'next';
import Link from 'next/link';
import { IconBriefcase } from '@tabler/icons-react';
import { CancelOrders } from '@/components/investor/cancel-orders';
import { FinancingBadge } from '@/components/merchant/financing/financing-parts';
import { FinancingDemoOnly } from '@/components/merchant/financing/demo-only';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Stat, StatGrid } from '@/components/ui/stat';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { LinkTabs } from '@/components/ui/tabs';
import { date, usd } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';

export const metadata: Metadata = { title: 'Portfolio' };

const tabs = [
  ['all', 'All'],
  ['funded', 'Open'],
  ['overdue', 'Overdue'],
  ['defaulted', 'Defaulted'],
  ['repaid', 'Closed'],
] as const;
type Tab = (typeof tabs)[number][0];

export default async function PortfolioPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: param } = await searchParams;
  const status: Tab = tabs.some(([value]) => value === param) ? (param as Tab) : 'all';
  const portfolio = await load(async () => (await getData()).financing.portfolio());
  if (isNotWired(portfolio))
    return <FinancingDemoOnly feature={portfolio.feature} path="/investor/portfolio" />;
  const { totals, positions, investor } = portfolio;
  const matches = (p: (typeof positions)[number], tab: Tab) =>
    tab === 'all' ||
    (tab === 'funded' && (p.status === 'funded' || p.status === 'requested')) ||
    (tab === 'repaid' && (p.status === 'repaid' || p.status === 'bought_back')) ||
    p.status === tab;
  const rows = positions.filter(p => matches(p, status));
  return (
    <>
      <PageHeader
        title="Portfolio"
        description={`Invoices ${investor.organization} bought: what you paid, what you expect and what customers have repaid.`}
        actions={
          <Button asChild size="sm">
            <Link href="/investor">Browse the marketplace</Link>
          </Button>
        }
      />
      <StatGrid className="mb-6">
        <Stat
          label="Invested"
          value={usd(totals.investedMinor)}
          hint={`${usd(investor.availableMinor)} available`}
        />
        <Stat
          label="Expected"
          value={usd(totals.expectedMinor)}
          hint={`${totals.open} open position${totals.open === 1 ? '' : 's'}`}
        />
        <Stat
          label="Received"
          value={usd(totals.receivedMinor)}
          tone={BigInt(totals.receivedMinor) > 0n ? 'success' : 'default'}
          hint={`${totals.closed} closed in full`}
        />
        <Stat
          label="Overdue or defaulted"
          value={usd(totals.overdueMinor)}
          tone={totals.overdue + totals.defaulted > 0 ? 'danger' : 'default'}
          hint={`${totals.overdue} in grace · ${totals.defaulted} defaulted`}
        />
      </StatGrid>
      <LinkTabs
        label="Position status"
        active={status}
        items={tabs.map(([value, label]) => ({
          value,
          label,
          href: value === 'all' ? '/investor/portfolio' : `/investor/portfolio?status=${value}`,
          count: positions.filter(p => matches(p, value)).length,
        }))}
      />
      <Card>
        {rows.length === 0 ? (
          <EmptyState
            icon={<IconBriefcase />}
            title={positions.length === 0 ? 'No positions yet' : 'Nothing here'}
            action={
              positions.length === 0 ? (
                <Button asChild size="sm" variant="dark">
                  <Link href="/investor">Browse the marketplace</Link>
                </Button>
              ) : undefined
            }
          >
            {positions.length === 0
              ? 'Invoices you buy from the marketplace appear here with their repayments.'
              : 'No positions match this filter.'}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Invoice</Th>
                <Th>Owed by</Th>
                <Th>Maturity</Th>
                <Th align="right">You hold</Th>
                <Th align="right">Paid</Th>
                <Th align="right">Received</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(p => {
                const mine = p.holders.find(h => h.you);
                return (
                  <Tr key={p.invoiceId}>
                    <Td>
                      <Link
                        href={`/investor/invoices/${p.invoiceId}`}
                        className="font-medium hover:underline"
                      >
                        {p.number}
                      </Link>
                      <p className="text-[13px] text-muted-foreground">Issued by {p.merchantName}</p>
                    </Td>
                    <Td>{p.debtor.company ?? p.debtor.name}</Td>
                    <Td className="whitespace-nowrap text-muted-foreground">{date(p.terms.maturityAt)}</Td>
                    <Td align="right">{usd(mine?.faceMinor ?? '0')}</Td>
                    <Td align="right" className="text-muted-foreground">
                      {usd(mine?.paidMinor ?? '0')}
                    </Td>
                    <Td align="right" className="font-medium">
                      {usd(mine?.receivedMinor ?? '0')}
                    </Td>
                    <Td>
                      <FinancingBadge status={p.status} audience="investor" />
                    </Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      <p className="mt-3 text-[13px] text-muted-foreground">
        Repayments arrive when a customer pays, straight from the contract. Past maturity a position has a
        grace period with a late fee; after that, you receive the reserve and the business owes you the rest.
      </p>
      <div className="mt-3">
        <CancelOrders role="investor" />
      </div>
    </>
  );
}
