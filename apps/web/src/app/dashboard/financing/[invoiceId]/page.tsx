import type { Metadata } from 'next';
import Link from 'next/link';
import { IconFileInvoice } from '@tabler/icons-react';
import { CustomerPayment } from '@/components/merchant/financing/customer-payment';
import { FinancingActions } from '@/components/merchant/financing/financing-actions';
import {
  AssumptionsNotice,
  FinancingBadge,
  FinancingSteps,
  FinancingTimeline,
  FundingBar,
  HoldersTable,
  OfferTerms,
  percent,
} from '@/components/merchant/financing/financing-parts';
import { FinancingDemoOnly } from '@/components/merchant/financing/demo-only';
import { PublicRecord } from '@/components/states/public-record';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, DetailList } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { date, dateTime, usd } from '@/lib/format';
import { getData } from '@/server/data';
import type { FinancedInvoice } from '@/server/data/parts/financing';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Invoice financing' };

const holderNames = (invoice: FinancedInvoice) => {
  const all = invoice.holders.map(h => h.organization);
  return all.length <= 1 ? (all[0] ?? 'the investors') : `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`;
};

function StatusNotice({ invoice }: { invoice: FinancedInvoice }) {
  const debtor = invoice.debtor.company ?? invoice.debtor.name;
  const holders = holderNames(invoice);
  const kept = BigInt(invoice.funding.unsoldMinor);
  const sold = BigInt(invoice.funding.soldMinor);
  switch (invoice.status) {
    case null:
      return (
        <Notice tone="warning" title="Not eligible for financing">
          {invoice.ineligibleReason}
        </Notice>
      );
    case 'requested':
      return sold > 0n ? (
        <Notice title={`${usd(sold)} of ${usd(invoice.terms.faceMinor)} funded`}>
          You have received {usd(invoice.funding.upfrontMinor)} so far. The rest stays listed until it sells
          or you close the listing; you keep whatever is not sold.
        </Notice>
      ) : (
        <Notice title={`Listed for investors since ${date(invoice.requestedAt!)}`}>
          You receive {usd(invoice.terms.upfrontMinor)} if investors buy all of it. You can cancel until one
          buys.
        </Notice>
      );
    case 'funded':
      return (
        <Notice tone="success" title={`Funded by ${holders}`}>
          You received {usd(invoice.funding.upfrontMinor)}; {usd(invoice.reserve.heldMinor)} is held as a
          reserve until {debtor} pays. Their payment goes straight to the investors
          {kept > 0n ? `, except the ${usd(kept)} you kept, which comes to you` : ''}.
        </Notice>
      );
    case 'overdue':
      return (
        <Notice
          tone="danger"
          title={`Overdue: grace period until ${date(invoice.terms.graceEndsAt)}`}
          role="alert"
        >
          {debtor} has not paid by {date(invoice.terms.maturityAt)}. If they pay by{' '}
          {date(invoice.terms.graceEndsAt)}, the investors receive a {percent(invoice.terms.lateFeeBps)} late
          fee from your reserve and the rest of it comes back to you. If not, the invoice defaults and you buy
          back what is still owed.
        </Notice>
      );
    case 'defaulted':
      return (
        <Notice tone="danger" title={`Defaulted: ${usd(invoice.buyBackMinor)} buy-back owed`} role="alert">
          The grace period ended on {date(invoice.defaultedAt!)} with the invoice unpaid. The token is frozen
          and your {usd(invoice.reserve.toInvestorsMinor)} reserve went to {holders}. {debtor} can still pay:
          the payment goes to the investors first and lowers what you owe.
        </Notice>
      );
    case 'repaid':
      return (
        <Notice tone="success" title="Repaid">
          {debtor} paid and {holders} received {usd(invoice.receivedMinor)}
          {invoice.late ? ', including the late fee from the reserve' : ''}.{' '}
          {usd(invoice.reserve.releasedMinor)} of the reserve came back to you on {date(invoice.repaidAt!)}.
        </Notice>
      );
    case 'bought_back':
      return (
        <Notice title="Bought back">
          You paid {holders} what they were still owed on {date(invoice.boughtBackAt!)}. The claim is yours
          again: when {debtor} pays, the payment comes to you.
        </Notice>
      );
    default:
      return null;
  }
}

export default async function FinancingInvoicePage({ params }: { params: Promise<{ invoiceId: string }> }) {
  const { invoiceId } = await params;
  const data = await getData();
  const [invoice, viewer] = await Promise.all([load(() => data.financing.invoice(invoiceId)), getViewer()]);
  if (isNotWired(invoice))
    return <FinancingDemoOnly feature={invoice.feature} path={`/dashboard/financing/${invoiceId}`} />;
  const canWrite = viewer?.role === 'merchant';
  const debtor = invoice.debtor.company ?? invoice.debtor.name;
  const net = invoice.ledger.reduce((sum, row) => sum + BigInt(row.netMinor), 0n);
  const issued = invoice.holders.length > 0;
  const { terms } = invoice;
  const payable =
    issued &&
    (invoice.status === 'requested' ||
      invoice.status === 'funded' ||
      invoice.status === 'overdue' ||
      invoice.status === 'defaulted');
  const owedByCustomer = BigInt(invoice.customerOwesMinor);
  return (
    <>
      <PageHeader
        back={{ href: '/dashboard/financing', label: 'Financing' }}
        eyebrow="Invoice financing"
        title={
          <span className="flex flex-wrap items-center gap-3">
            {invoice.number} <FinancingBadge status={invoice.status} />
          </span>
        }
        description={`${debtor} · ${usd(terms.faceMinor)} · due ${invoice.dueAt ? date(invoice.dueAt) : 'on receipt'}`}
        actions={
          <Button asChild size="sm">
            <Link href={`/dashboard/invoices/${invoice.invoiceId}`}>
              <IconFileInvoice className="size-4" />
              View invoice
            </Link>
          </Button>
        }
      />
      <div className="mb-6 grid gap-3">
        <StatusNotice invoice={invoice} />
        <AssumptionsNotice assumptions={invoice.assumptions} />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader
              title="Offer"
              description={
                invoice.requestedAt
                  ? `Priced when it was listed, ${date(invoice.requestedAt)}`
                  : 'As it would be priced if you list it today'
              }
            />
            <CardBody className="grid gap-5">
              <OfferTerms terms={terms} audience="merchant" />
              {invoice.requestedAt && <FundingBar invoice={invoice} />}
            </CardBody>
          </Card>
          {issued && (
            <Card>
              <CardHeader
                title="Who holds the claim"
                description="Approved investors hold receivable tokens, 1 token for each dollar of face value"
              />
              <HoldersTable
                holders={invoice.holders}
                keptMinor={invoice.funding.open ? undefined : invoice.funding.unsoldMinor}
              />
              <CardBody>
                <DetailList
                  items={[
                    {
                      label: 'Reserve held by the contract',
                      value: usd(invoice.reserve.heldMinor),
                      hint: `${percent(terms.reserveBps)} of the face value sold`,
                    },
                    { label: 'Reserve returned to you', value: usd(invoice.reserve.releasedMinor) },
                    {
                      label: 'Reserve paid to investors',
                      value: usd(invoice.reserve.toInvestorsMinor),
                      hint: 'Late fee, or everything on default',
                    },
                    {
                      label: 'Transfers between investors',
                      value: invoice.transfers.open ? 'Open' : 'Closed',
                      hint: invoice.transfers.open
                        ? `Until the record date, ${dateTime(invoice.transfers.recordDateAt)}`
                        : (invoice.transfers.reason ?? undefined),
                    },
                  ]}
                />
              </CardBody>
            </Card>
          )}
          <Card>
            <CardHeader
              title="In your books"
              description="The advance arrives less the reserve. The customer’s payment is booked as income and leaves again to the investors, so the invoice counts once."
            />
            {invoice.ledger.length === 0 ? (
              <CardBody>
                <p className="text-sm text-muted-foreground">
                  Nothing booked yet. The advance is booked when an investor buys.
                </p>
              </CardBody>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Type</Th>
                    <Th align="right">Gross</Th>
                    <Th align="right">Fee</Th>
                    <Th align="right">Net</Th>
                    <Th>Record</Th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.ledger.map((row, index) => (
                    <Tr key={`${row.type}-${row.at}-${index}`}>
                      <Td className="whitespace-nowrap text-muted-foreground">{dateTime(row.at)}</Td>
                      <Td>
                        <Badge tone={BigInt(row.grossMinor) < 0n ? 'warning' : 'success'}>{row.type}</Badge>
                      </Td>
                      <Td align="right">{usd(row.grossMinor)}</Td>
                      <Td align="right" className="text-muted-foreground">
                        {usd(row.feeMinor)}
                      </Td>
                      <Td align="right" className="font-medium">
                        {usd(row.netMinor, { signed: true })}
                      </Td>
                      <Td>
                        <PublicRecord hash={row.txHash} />
                      </Td>
                    </Tr>
                  ))}
                  <Tr className="bg-raised font-semibold hover:bg-raised">
                    <Td colSpan={4}>Net from this invoice</Td>
                    <Td align="right">{usd(net, { signed: true })}</Td>
                    <Td />
                  </Tr>
                </tbody>
              </Table>
            )}
          </Card>
          <Card>
            <CardHeader title="Activity" />
            <CardBody>
              <FinancingTimeline events={invoice.timeline} />
            </CardBody>
          </Card>
        </div>
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader title="Status" />
            <CardBody className="grid gap-5">
              <FinancingSteps invoice={invoice} />
              {canWrite ? (
                <FinancingActions invoice={invoice} />
              ) : (
                invoice.status !== null &&
                invoice.status !== 'repaid' &&
                invoice.status !== 'bought_back' && (
                  <p className="text-sm text-muted-foreground">
                    Read-only. Only the business owner can request, cancel or buy back financing.
                  </p>
                )
              )}
              {canWrite && data.mode === 'mock' && payable && owedByCustomer > 0n && (
                <CustomerPayment
                  invoiceId={invoice.invoiceId}
                  debtor={debtor}
                  amountMinor={owedByCustomer.toString()}
                  holders={holderNames(invoice)}
                />
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="How it works" />
            <CardBody>
              <ol className="grid gap-3 text-sm text-subtle-foreground">
                {[
                  `${debtor} signs “I owe this invoice”. Only then can it be listed, at ${usd(terms.priceMinor)}, for approved investors to buy all or part.`,
                  `Investors buy. You receive ${usd(terms.upfrontMinor)} at once: the price less Pact’s ${usd(terms.feeMinor)} fee and a ${usd(terms.reserveMinor)} reserve.`,
                  `${debtor} pays as usual by ${date(terms.maturityAt)}. The contract sends the payment straight to the investors and returns your reserve.`,
                  `Paid late: the investors get a ${usd(terms.lateFeeMinor)} late fee from the reserve. Still unpaid on ${date(terms.graceEndsAt)}: the reserve goes to them and you buy back the rest.`,
                ].map((step, i) => (
                  <li key={step} className="flex gap-3">
                    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-chip text-[13px] font-semibold text-foreground">
                      {i + 1}
                    </span>
                    {step}
                  </li>
                ))}
              </ol>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
