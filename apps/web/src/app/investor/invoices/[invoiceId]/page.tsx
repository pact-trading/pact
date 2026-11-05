import type { Metadata } from 'next';
import { BuyInvoice } from '@/components/investor/buy-invoice';
import { RiskNotes } from '@/components/investor/risk-notes';
import { TransferClaim } from '@/components/investor/transfer-claim';
import { FinancingDemoOnly } from '@/components/merchant/financing/demo-only';
import { CustomerPayment } from '@/components/merchant/financing/customer-payment';
import {
  AssumptionsNotice,
  FinancingBadge,
  FinancingSteps,
  FinancingTimeline,
  FundingBar,
  OfferTerms,
  percent,
} from '@/components/merchant/financing/financing-parts';
import { Card, CardBody, CardHeader, DetailList } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { date, usd } from '@/lib/format';
import { getData } from '@/server/data';
import type { FinancedInvoice, FinancingHolder } from '@/server/data/parts/financing';
import { isNotWired, load } from '@/server/load';

export const metadata: Metadata = { title: 'Invoice' };

function PositionNotice({ invoice, mine }: { invoice: FinancedInvoice; mine: FinancingHolder }) {
  const debtor = invoice.debtor.company ?? invoice.debtor.name;
  switch (invoice.status) {
    case 'requested':
    case 'funded':
      return (
        <Notice title="Waiting for the customer">
          {debtor} pays through the usual payment link by {date(invoice.terms.maturityAt)}; the contract sends
          your share straight to you.
        </Notice>
      );
    case 'overdue':
      return (
        <Notice
          tone="danger"
          title={`Overdue: grace period until ${date(invoice.terms.graceEndsAt)}`}
          role="alert"
        >
          {debtor} has not paid. If they pay by {date(invoice.terms.graceEndsAt)}, you also receive a{' '}
          {percent(invoice.terms.lateFeeBps)} late fee from the reserve. If not, the reserve is paid to you
          and {invoice.merchantName} owes you the rest as a buy-back.
        </Notice>
      );
    case 'defaulted':
      return (
        <Notice tone="danger" title="Defaulted: the token is frozen" role="alert">
          You received your share of the reserve. {invoice.merchantName} owes you the remaining{' '}
          {usd(mine.owedMinor)} as a buy-back, recorded onchain. If {debtor} pays first, that payment comes to
          you instead.
        </Notice>
      );
    case 'repaid':
      return (
        <Notice tone="success" title="Repaid in full">
          You received {usd(mine.receivedMinor)}
          {invoice.late ? ', including the late fee' : ''} on {date(invoice.repaidAt!)}.
        </Notice>
      );
    case 'bought_back':
      return (
        <Notice tone="success" title="Bought back">
          {invoice.merchantName} paid you the rest on {date(invoice.boughtBackAt!)}. You received{' '}
          {usd(mine.receivedMinor)} in all.
        </Notice>
      );
    default:
      return null;
  }
}

export default async function InvestorInvoicePage({ params }: { params: Promise<{ invoiceId: string }> }) {
  const { invoiceId } = await params;
  const data = await getData();
  const detail = await load(() => data.financing.listing(invoiceId));
  if (isNotWired(detail))
    return <FinancingDemoOnly feature={detail.feature} path={`/investor/invoices/${invoiceId}`} />;
  const { invoice, investor, owned, counterparties, assumptions } = detail;
  const debtor = invoice.debtor.company ?? invoice.debtor.name;
  const total = invoice.lines.reduce((sum, line) => sum + BigInt(line.amountMinor), 0n);
  const mine = invoice.holders.find(h => h.you) ?? null;
  const approved = investor.approval.status === 'approved';
  const live = invoice.status === 'requested' || invoice.status === 'funded';
  const unpaid =
    invoice.status === 'funded' || invoice.status === 'overdue' || invoice.status === 'defaulted';
  return (
    <>
      <PageHeader
        back={
          owned
            ? { href: '/investor/portfolio', label: 'Portfolio' }
            : { href: '/investor', label: 'Marketplace' }
        }
        eyebrow={`Issued by ${invoice.merchantName}`}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {invoice.number} <FinancingBadge status={invoice.status} audience="investor" />
          </span>
        }
        description={`Owed by ${debtor} · ${usd(invoice.terms.faceMinor)} due ${date(invoice.terms.maturityAt)}`}
      />
      <AssumptionsNotice assumptions={assumptions} className="mb-6" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader title="Terms" description="Priced by Pact’s fixed rule when the invoice was listed" />
            <CardBody className="grid gap-5">
              <OfferTerms terms={invoice.terms} audience="investor" />
              <FundingBar invoice={invoice} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              title="Risk notes"
              description="From the business’s records and the contract’s rules, not underwriting or a credit score"
            />
            <CardBody>
              <RiskNotes invoice={invoice} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="The invoice" description={`Sent ${date(invoice.createdAt)} to ${debtor}`} />
            <Table className="min-w-0">
              <thead>
                <tr>
                  <Th>Item</Th>
                  <Th align="right">Qty</Th>
                  <Th align="right">Amount</Th>
                </tr>
              </thead>
              <tbody>
                {invoice.lines.map(line => (
                  <Tr key={line.description} className="hover:bg-transparent">
                    <Td>{line.description}</Td>
                    <Td align="right">{line.quantity}</Td>
                    <Td align="right">{usd(line.amountMinor)}</Td>
                  </Tr>
                ))}
                <Tr className="font-semibold hover:bg-transparent">
                  <Td colSpan={2}>Total</Td>
                  <Td align="right">{usd(total)}</Td>
                </Tr>
              </tbody>
            </Table>
          </Card>
          {invoice.timeline.length > 0 && (
            <Card>
              <CardHeader title="Activity" />
              <CardBody>
                <FinancingTimeline events={invoice.timeline} />
              </CardBody>
            </Card>
          )}
        </div>
        <div className="grid min-w-0 content-start gap-6">
          {mine && (
            <Card>
              <CardHeader
                title="Your position"
                description={
                  invoice.otherHolders > 0
                    ? `You and ${invoice.otherHolders} other investor${invoice.otherHolders === 1 ? '' : 's'} hold this invoice`
                    : 'You hold this invoice'
                }
              />
              <CardBody className="grid gap-5">
                <DetailList
                  items={[
                    { label: 'Face value you hold', value: usd(mine.faceMinor) },
                    {
                      label: 'You paid',
                      value: usd(mine.paidMinor),
                      hint: invoice.fundedAt ? date(invoice.fundedAt) : undefined,
                    },
                    { label: 'Received', value: usd(mine.receivedMinor) },
                    { label: 'Still owed to you', value: usd(mine.owedMinor) },
                  ]}
                />
                <PositionNotice invoice={invoice} mine={mine} />
                {data.mode === 'mock' && unpaid && BigInt(invoice.customerOwesMinor) > 0n && (
                  <CustomerPayment
                    invoiceId={invoice.invoiceId}
                    debtor={debtor}
                    amountMinor={invoice.customerOwesMinor}
                    holders="the holders, you included"
                  />
                )}
              </CardBody>
            </Card>
          )}
          {invoice.status === 'requested' && BigInt(invoice.funding.unsoldMinor) > 0n && (
            <Card>
              <CardHeader title={mine ? 'Buy more' : 'Buy this invoice'} />
              <CardBody className="grid gap-5">
                <div>
                  <p className="text-sm text-muted-foreground">For sale</p>
                  <p className="text-3xl font-semibold">{usd(invoice.funding.unsoldMinor)}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Face value, owed by {debtor} on {date(invoice.terms.maturityAt)}, at{' '}
                    {percent(invoice.terms.discountBps)} off.
                  </p>
                </div>
                <BuyInvoice
                  invoiceId={invoice.invoiceId}
                  number={invoice.number}
                  discountBps={invoice.terms.discountBps}
                  remainingMinor={invoice.funding.unsoldMinor}
                  minimumShareMinor={assumptions.minimumShareMinor}
                  availableMinor={investor.availableMinor}
                  approved={approved}
                />
                <p className="text-[13px] text-muted-foreground">
                  Available to invest: {usd(investor.availableMinor)}
                </p>
              </CardBody>
            </Card>
          )}
          {mine && (live || invoice.status === 'overdue' || invoice.status === 'defaulted') && (
            <Card>
              <CardHeader title="Transfer to another investor" />
              <CardBody>
                <TransferClaim
                  invoiceId={invoice.invoiceId}
                  number={invoice.number}
                  heldMinor={mine.faceMinor}
                  counterparties={counterparties}
                  rules={invoice.transfers}
                />
              </CardBody>
            </Card>
          )}
          <Card>
            <CardHeader title="Progress" />
            <CardBody>
              <FinancingSteps invoice={invoice} audience="investor" />
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
