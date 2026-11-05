import type { Metadata } from 'next';
import Link from 'next/link';
import { IconBuildingBank, IconCircleCheck } from '@tabler/icons-react';
import { FinancingDemoOnly } from '@/components/merchant/financing/demo-only';
import { InvestorApplication, InvestorTestFunds } from '@/components/investor/investor-application';
import { AssumptionsNotice, FundingBar, percent } from '@/components/merchant/financing/financing-parts';
import { Notice } from '@/components/ui/notice';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Stat, StatGrid } from '@/components/ui/stat';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { date, usd } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';

export const metadata: Metadata = { title: 'Invoice marketplace' };

export default async function MarketplacePage() {
  const market = await load(async () => (await getData()).financing.marketplace());
  if (isNotWired(market)) return <FinancingDemoOnly feature={market.feature} path="/investor" />;
  const { listings, investor, assumptions } = market;
  const forSale = listings.reduce((sum, l) => sum + BigInt(l.funding.unsoldMinor), 0n);
  const first = listings[0];
  return (
    <>
      <PageHeader
        title="Invoice marketplace"
        description="Buy all or part of short-term invoices that businesses on Pact have issued, at a discount to what their customers owe. The customer’s payment comes straight to you; a reserve and the business’s buy-back stand behind it."
      />
      {investor.applied !== undefined && <InvestorApplication applied={investor.applied} />}
      {investor.approval.status !== 'approved' && (investor.applied ?? true) && (
        <Notice tone="warning" title="You are not an approved investor" className="mb-4">
          {investor.organization}’s registry entry is {investor.approval.status}. You can browse, but the
          receivables contract refuses purchases and transfers until Pact compliance approves you
          {investor.approval.status === 'pending' ? '' : ' again'}.
        </Notice>
      )}
      {investor.address && <InvestorTestFunds address={investor.address} />}
      <AssumptionsNotice assumptions={assumptions} className="mb-6" />
      <StatGrid className="mb-6 lg:grid-cols-3">
        <Stat label="Available to invest" value={usd(investor.availableMinor)} hint={investor.organization} />
        <Stat label="Listed now" value={listings.length} hint={`${usd(forSale)} face value for sale`} />
        <Stat
          label="Soonest maturity"
          value={first ? date(first.terms.maturityAt) : '—'}
          hint={first ? `${first.number}, ${first.terms.days} days` : 'Nothing listed'}
        />
      </StatGrid>
      <Card>
        {listings.length === 0 ? (
          <EmptyState icon={<IconBuildingBank />} title="Nothing listed right now">
            When a business requests financing for an invoice, it appears here with its terms and risk notes.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Invoice</Th>
                <Th>Owed by</Th>
                <Th>Maturity</Th>
                <Th>Funded</Th>
                <Th align="right">Discount</Th>
                <Th align="right">Return</Th>
                <Th>Risk notes</Th>
              </tr>
            </thead>
            <tbody>
              {listings.map(l => (
                <Tr key={l.invoiceId}>
                  <Td>
                    <Link href={`/investor/invoices/${l.invoiceId}`} className="font-medium hover:underline">
                      {l.number}
                    </Link>
                    <p className="text-[13px] text-muted-foreground">Issued by {l.merchantName}</p>
                  </Td>
                  <Td>{l.debtor.company ?? l.debtor.name}</Td>
                  <Td className="whitespace-nowrap">
                    <p>{date(l.terms.maturityAt)}</p>
                    <p className="text-[13px] text-muted-foreground">{l.terms.days} days</p>
                  </Td>
                  <Td className="min-w-40">
                    <FundingBar invoice={l} />
                  </Td>
                  <Td align="right" className="font-medium">
                    {percent(l.terms.discountBps)}
                  </Td>
                  <Td align="right">
                    <p>{percent(l.terms.returnBps)}</p>
                    <p className="text-[13px] text-muted-foreground">~{percent(l.terms.annualBps)} a year</p>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1.5">
                      {l.acknowledged ? (
                        <Badge tone="success">
                          <IconCircleCheck className="size-3.5" />
                          Acknowledged
                        </Badge>
                      ) : (
                        <Badge tone="outline">Not acknowledged</Badge>
                      )}
                      {l.debtorHistory.invoicesOverdue + l.debtorHistory.invoicesPaidLate > 0 && (
                        <Badge tone="warning">Late history</Badge>
                      )}
                      <Badge tone="outline">{percent(l.terms.reserveBps)} reserve</Badge>
                    </div>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {listings.length > 0 && (
        <p className="mt-3 text-[13px] text-muted-foreground">
          Return is what you receive above the price if the customer pays the face value in full, by maturity.
          You can buy part of a listing; the smallest share is {usd(assumptions.minimumShareMinor)}.
        </p>
      )}
    </>
  );
}
