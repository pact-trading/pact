import Link from 'next/link';
import { LiveSetupCard } from '@/components/merchant/live/live-setup';
import {
  IconArrowRight,
  IconCircleCheckFilled,
  IconCircleDashed,
  IconDownload,
  IconFileInvoice,
  IconFilePlus,
  IconLink,
  IconReceiptTax,
  IconWallet,
} from '@tabler/icons-react';
import { InvoiceStatusChip } from '@/components/merchant/invoices/invoice-status';
import { NotConnected } from '@/components/states/not-connected';
import { BarChart } from '@/components/ui/bar-chart';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { Stat, StatGrid } from '@/components/ui/stat';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { cn } from '@/lib/cn';
import { date, relative, toMinor, usd, usdDecimal } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export default async function OverviewPage() {
  const data = await getData();
  const [overview, viewer, invoices, settings, demo] = await Promise.all([
    load(() => data.merchant.overview()),
    getViewer(),
    load(() => data.merchant.invoices()),
    load(() => data.merchant.settings()),
    data.demo?.state(),
  ]);
  if (isNotWired(overview)) return <NotConnected feature={overview.feature} />;
  const now = demo?.now ?? overview.summary.generatedAt;
  const brandName = isNotWired(settings) ? null : settings.brandName;
  const unpaid = isNotWired(invoices)
    ? []
    : invoices.filter(i => i.status !== 'draft' && i.status !== 'paid');
  const outstanding = unpaid.reduce((t, i) => t + toMinor(i.remaining), 0n);
  const overdue = unpaid.filter(i => i.status === 'overdue').length;
  const recentInvoices = isNotWired(invoices)
    ? []
    : [...invoices].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  const { summary, onboarding, activity } = overview;
  const readOnly = viewer?.role === 'accountant';
  const remaining = onboarding.filter(step => !step.done);
  const terms = summary.feeTerms;
  return (
    <>
      <PageHeader
        title={`Good to see you, ${viewer?.name.split(' ')[0] ?? 'there'}`}
        description={`${brandName ?? 'Your business'} on Whitechain Sepolia. Updated ${relative(summary.generatedAt, summary.generatedAt)}.`}
        actions={
          !readOnly && (
            <>
              <Button asChild size="sm">
                <Link href="/dashboard/exports">
                  <IconDownload className="size-4" />
                  Export
                </Link>
              </Button>
              <Button asChild size="sm">
                <Link href="/dashboard/products">
                  <IconLink className="size-4" />
                  Share a payment link
                </Link>
              </Button>
              <Button asChild variant="primary" size="sm">
                <Link href="/dashboard/invoices/new">
                  <IconFilePlus className="size-4" />
                  New invoice
                </Link>
              </Button>
            </>
          )
        }
      />
      {!readOnly && (
        <div className="mb-6">
          <LiveSetupCard compact />
        </div>
      )}

      {remaining.length > 0 && (
        <Card className="mb-6">
          <CardHeader
            title="Finish setting up"
            description={`${onboarding.length - remaining.length} of ${onboarding.length} done. A new merchant reaches a working checkout in about three minutes.`}
            action={
              <Button asChild size="sm" variant="dark">
                <Link href="/dashboard/onboarding">Continue setup</Link>
              </Button>
            }
          />
          <CardBody className="grid gap-2 sm:grid-cols-5">
            {onboarding.map(step => (
              <div key={step.id} className="flex items-center gap-2 text-sm">
                {step.done ? (
                  <IconCircleCheckFilled className="size-4.5 text-success" />
                ) : (
                  <IconCircleDashed className="size-4.5 text-muted-foreground" />
                )}
                {step.title}
              </div>
            ))}
          </CardBody>
        </Card>
      )}

      <StatGrid>
        <Stat
          label="Available balance"
          icon={<IconWallet />}
          value={summary.balance?.amountUsdt ? usdDecimal(summary.balance.amountUsdt) : '—'}
          hint="USDT in your payout account"
        />
        <Stat
          label="Today's volume"
          value={summary.today ? usdDecimal(summary.today.capturedUsdt) : '—'}
          hint={
            summary.today
              ? `${summary.today.payments} payments · ${summary.today.subscriptionCharges} renewals`
              : undefined
          }
        />
        <Stat
          label="Refunded today"
          value={summary.today ? usdDecimal(summary.today.refundedUsdt) : '—'}
          hint={summary.today ? `${summary.today.refunds} refunds` : undefined}
        />
        <Stat
          label="Unpaid invoices"
          icon={<IconFileInvoice />}
          value={isNotWired(invoices) ? '—' : usd(outstanding)}
          hint={
            isNotWired(invoices) ? undefined : `${unpaid.length} open${overdue ? `, ${overdue} overdue` : ''}`
          }
          tone={overdue ? 'warning' : 'default'}
        />
      </StatGrid>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title="Payment volume"
            description="Collected per day, last 14 days, UTC"
            action={
              <span className="text-sm font-medium">{usdDecimal(summary.metrics.capturedUsdt)} all time</span>
            }
          />
          <CardBody>
            <BarChart
              points={summary.volume.map(point => ({
                label: date(`${point.date}T00:00:00Z`).replace(/, \d{4}$/, ''),
                value: Number(toMinor(point.amount) / 10_000n) / 100,
                title: `${point.date}: ${usdDecimal(point.amount)}`,
              }))}
            />
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Fees"
            description="Taken from each payment. Customers never pay a fee or gas."
            action={<IconReceiptTax className="size-5 text-muted-foreground" />}
          />
          <CardBody className="grid gap-3 text-sm">
            <div>
              <p className="text-muted-foreground">Fee terms</p>
              <p className="text-lg font-semibold">
                {terms.accepted === null
                  ? 'Unavailable'
                  : terms.accepted
                    ? `Signed, version ${terms.acceptedVersion}`
                    : 'Not signed yet'}
              </p>
              {terms.accepted === false && (
                <p className="text-warning">Payments to you are refused until you sign.</p>
              )}
              {terms.accepted && terms.latestVersion !== null && (terms.acceptedVersion ?? 0) < terms.latestVersion && (
                <p className="text-muted-foreground">Version {terms.latestVersion} is available to sign.</p>
              )}
            </div>
            <div>
              <p className="text-muted-foreground">Pact fees, all time</p>
              <p className="font-medium">{usdDecimal(summary.metrics.feesUsdt)}</p>
            </div>
            <Link
              href="/dashboard/fees"
              className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
            >
              {terms.accepted === false ? 'Sign the fee terms' : 'Open fees'} <IconArrowRight className="size-3.5" />
            </Link>
          </CardBody>
        </Card>
      </div>

      {!isNotWired(invoices) && (
        <Card className="mt-6">
          <CardHeader
            title="Recent invoices"
            description="Newest first, with what is still owed"
            action={
              <Link href="/dashboard/invoices" className="text-sm font-medium hover:underline">
                View all
              </Link>
            }
          />
          {recentInvoices.length === 0 ? (
            <EmptyState
              icon={<IconFileInvoice />}
              title="No invoices yet"
              action={
                !readOnly && (
                  <Button asChild size="sm" variant="dark">
                    <Link href="/dashboard/invoices/new">Create an invoice</Link>
                  </Button>
                )
              }
            >
              Send one to get paid in USDT with a hosted link.
            </EmptyState>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Invoice</Th>
                  <Th>Customer</Th>
                  <Th>Due</Th>
                  <Th align="right">Amount</Th>
                  <Th>Status</Th>
                </tr>
              </thead>
              <tbody>
                {recentInvoices.map(i => (
                  <Tr key={i.id}>
                    <Td>
                      <Link href={`/dashboard/invoices/${i.id}`} className="font-medium hover:underline">
                        {i.number}
                      </Link>
                    </Td>
                    <Td className="max-w-[220px] truncate">{i.customerName ?? i.customerEmail}</Td>
                    <Td className="text-muted-foreground">{i.dueAt ? date(i.dueAt) : 'On receipt'}</Td>
                    <Td align="right">
                      <p className="font-medium">{usdDecimal(i.amount)}</p>
                      {i.status !== 'paid' && i.paid !== i.amount && toMinor(i.paid) > 0n && (
                        <p className="text-[13px] text-muted-foreground">{usdDecimal(i.remaining)} left</p>
                      )}
                    </Td>
                    <Td>
                      <InvoiceStatusChip status={i.status} />
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title="Recent activity"
            description="Payments, renewals, refusals and invoices as they happen"
          />
          <ul className="divide-y divide-border-subtle">
            {activity.map(item => {
              const content = (
                <>
                  <span
                    aria-hidden
                    className={cn(
                      'mt-1.5 size-2 shrink-0 rounded-full',
                      item.tone === 'success'
                        ? 'bg-success'
                        : item.tone === 'warning'
                          ? 'bg-warning'
                          : item.tone === 'danger'
                            ? 'bg-destructive'
                            : 'bg-muted-foreground/50',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-medium">{item.title}</p>
                    <p className="truncate text-sm text-muted-foreground">{item.detail}</p>
                  </div>
                  <time className="shrink-0 text-[13px] text-muted-foreground" dateTime={item.at}>
                    {relative(item.at, summary.generatedAt)}
                  </time>
                </>
              );
              return (
                <li key={item.id}>
                  {item.href ? (
                    <Link href={item.href} className="flex gap-3 px-5 py-3 hover:bg-raised">
                      {content}
                    </Link>
                  ) : (
                    <div className="flex gap-3 px-5 py-3">{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
        <Card>
          <CardHeader title="All time" />
          <CardBody className="grid gap-4 text-sm">
            {[
              ['Collected', usdDecimal(summary.metrics.capturedUsdt)],
              ['Refunded', usdDecimal(summary.metrics.refundedUsdt)],
              ['Pact fees', usdDecimal(summary.metrics.feesUsdt)],
              ['Net to you', usdDecimal(summary.metrics.netUsdt)],
              ['Paid orders', `${summary.metrics.successfulPayments} of ${summary.metrics.totalPayments}`],
              ['Active subscriptions', String(summary.metrics.activeSubscriptions)],
            ].map(([label, value]) => (
              <div key={label} className="flex justify-between gap-3">
                <span className="text-muted-foreground">{label}</span>
                <span className="font-medium">{value}</span>
              </div>
            ))}
            <p className="text-[13px] text-muted-foreground">
              Pact’s fee comes out of each payment, in the same transaction, and Pact pays the gas. See Exports
              for the full ledger.
            </p>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
