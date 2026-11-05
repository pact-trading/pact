import type { Metadata } from 'next';
import { IconCircleCheckFilled, IconCircleDashed, IconSignature } from '@tabler/icons-react';
import { InvoiceActions } from '@/components/merchant/invoices/invoice-actions';
import { InvoicePreview } from '@/components/merchant/invoices/invoice-preview';
import { InvoiceStatusChip } from '@/components/merchant/invoices/invoice-status';
import { ManualReminderList } from '@/components/merchant/invoices/reminder-dialog';
import { QrCode } from '@/components/merchant/qr-code';
import { NotConnected } from '@/components/states/not-connected';
import { PublicRecord } from '@/components/states/public-record';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { Timeline } from '@/components/ui/timeline';
import { date, dateTime, humanize, toMinor, usdDecimal } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { publicOrigin } from '@/server/origin';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Invoice' };

const stage = {
  seven_days: '7 days before due',
  one_day: '1 day before due',
  overdue: 'When overdue',
} as const;

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getData();
  // Written reminders first: scheduled ones whose time has come are sent and join the activity.
  const reminders = await load(() => data.merchant.manualReminders(id));
  const [invoice, viewer, origin, settings, preferences, demo] = await Promise.all([
    load(() => data.merchant.invoice(id)),
    getViewer(),
    publicOrigin(),
    load(() => data.merchant.settings()),
    load(() => data.merchant.preferences()),
    data.demo?.state(),
  ]);
  if (isNotWired(invoice)) return <NotConnected feature={invoice.feature} />;
  const now = demo?.now ?? new Date().toISOString();
  const readOnly = viewer?.role !== 'merchant';
  const hostedUrl = `${origin}${invoice.hostedUrl}`;
  const open = invoice.status !== 'draft' && invoice.status !== 'paid';
  const dueText = invoice.dueAt
    ? `${invoice.status === 'overdue' ? 'was due' : 'is due'} ${date(invoice.dueAt)}`
    : 'is due on receipt';
  const defaultMessage = `Hello ${invoice.customerName ?? 'there'}, a friendly reminder that invoice ${invoice.number} for ${usdDecimal(invoice.remaining)} ${dueText}. You can pay it here: ${hostedUrl}`;
  const preview = (
    <InvoicePreview
      merchantName={isNotWired(settings) ? invoice.merchantName : settings.brandName}
      logoUrl={isNotWired(settings) ? null : settings.logoUrl}
      brandColor={isNotWired(preferences) ? '#c6ff34' : preferences.brandColor}
      number={invoice.number}
      customerName={invoice.customerName}
      customerEmail={invoice.customerEmail}
      lines={invoice.lines.map(line => ({
        key: line.id,
        description: line.description,
        quantity: line.quantity,
        amountMinor: toMinor(line.amount),
      }))}
      totalMinor={toMinor(invoice.amount)}
      paidMinor={toMinor(invoice.paid)}
      dueAt={invoice.dueAt}
      memo={invoice.memo}
      allowPartial={invoice.allowPartial}
    />
  );
  return (
    <>
      <PageHeader
        back={{ href: '/dashboard/invoices', label: 'Invoices' }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {invoice.number} <InvoiceStatusChip status={invoice.status} dueAt={invoice.dueAt} now={now} />
          </span>
        }
        description={`${invoice.customerName ?? invoice.customerEmail} · ${usdDecimal(invoice.amount)} · due ${invoice.dueAt ? date(invoice.dueAt) : 'on receipt'}`}
        actions={
          <InvoiceActions
            id={invoice.id}
            number={invoice.number}
            status={invoice.status}
            hostedUrl={hostedUrl}
            readOnly={readOnly}
            qr={<QrCode value={hostedUrl} />}
            preview={preview}
            reminder={open ? { to: invoice.customerEmail, defaultMessage, now } : null}
            financeHref={!readOnly && open ? `/dashboard/financing/${invoice.id}` : null}
          />
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardBody className="grid gap-6 sm:p-7">
              <div className="flex flex-wrap justify-between gap-4">
                <div>
                  <p className="text-sm text-muted-foreground">From</p>
                  <p className="font-semibold">{invoice.merchantName}</p>
                </div>
                <div className="sm:text-right">
                  <p className="text-sm text-muted-foreground">Billed to</p>
                  <p className="font-semibold">{invoice.customerName}</p>
                  <p className="text-sm text-muted-foreground">{invoice.customerEmail}</p>
                </div>
              </div>
              <Table className="min-w-0">
                <thead>
                  <tr>
                    <Th className="px-0">Item</Th>
                    <Th align="right">Qty</Th>
                    <Th align="right" className="pr-0">
                      Amount
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {invoice.lines.map(line => (
                    <Tr key={line.id} className="hover:bg-transparent">
                      <Td className="px-0">{line.description}</Td>
                      <Td align="right">{line.quantity}</Td>
                      <Td align="right" className="pr-0">
                        {usdDecimal(line.amount)}
                      </Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
              <div className="ml-auto grid w-full max-w-xs gap-1.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total</span>
                  <span className="font-semibold">{usdDecimal(invoice.amount)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Paid</span>
                  <span>{usdDecimal(invoice.paid)}</span>
                </div>
                <div className="flex justify-between border-t border-border-subtle pt-1.5 text-base">
                  <span>Remaining</span>
                  <span className="font-semibold">{usdDecimal(invoice.remaining)}</span>
                </div>
              </div>
              {invoice.memo && (
                <p className="rounded-xl bg-raised p-4 text-sm text-subtle-foreground">{invoice.memo}</p>
              )}
              <p className="text-[13px] text-muted-foreground">
                {invoice.allowPartial ? 'Partial payments allowed.' : 'Must be paid in full.'} Settles in USDT
                on Whitechain; the payer pays no fees.
              </p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Activity" />
            <CardBody>
              <Timeline
                items={invoice.activity.map((a, i) => ({
                  id: `${a.type}-${i}`,
                  title: humanize(a.type),
                  detail: a.detail,
                  at: dateTime(a.at),
                  tone:
                    a.type === 'paid' || a.type === 'payment'
                      ? 'success'
                      : a.type === 'overdue'
                        ? 'danger'
                        : a.type === 'acknowledged'
                          ? 'success'
                          : 'default',
                  extra: a.txHash ? <PublicRecord hash={a.txHash} /> : undefined,
                }))}
              />
            </CardBody>
          </Card>
        </div>
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader
              title="Payer acknowledgement"
              action={<IconSignature className="size-5 text-muted-foreground" />}
            />
            <CardBody>
              {invoice.acknowledgement ? (
                <Notice tone="success" title={`Acknowledged ${dateTime(invoice.acknowledgement.signedAt)}`}>
                  The payer signed “I owe this invoice”.{' '}
                  {invoice.acknowledgement.txHash
                    ? 'The signature is stored onchain by the relayer at no cost to them.'
                    : `The signature is kept with the invoice; anyone can check it against the payer's address (${invoice.acknowledgement.signer.slice(0, 6)}…${invoice.acknowledgement.signer.slice(-4)}).`}{' '}
                  <PublicRecord hash={invoice.acknowledgement.txHash} />
                </Notice>
              ) : (
                <Notice>
                  Not yet acknowledged. The payer is asked to confirm the invoice with one signature when they
                  open it.
                </Notice>
              )}
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              title="Reminders"
              description="Email when a mail key is set, otherwise the dashboard and a webhook"
            />
            <CardBody className="grid gap-3">
              {invoice.status === 'draft' ? (
                <p className="text-sm text-muted-foreground">Reminders start once the invoice is sent.</p>
              ) : (
                invoice.reminders.map(r => (
                  <div key={r.stage} className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2">
                      {r.sentAt ? (
                        <IconCircleCheckFilled className="size-4 text-success" />
                      ) : (
                        <IconCircleDashed className="size-4 text-muted-foreground" />
                      )}
                      {stage[r.stage]}
                    </span>
                    <span className="text-muted-foreground">
                      {r.sentAt ? `Sent ${date(r.sentAt)}` : date(r.dueAt)}
                    </span>
                  </div>
                ))
              )}
              {invoice.status === 'paid' && (
                <p className="text-sm text-muted-foreground">Paid, so no further reminders.</p>
              )}
              {isNotWired(reminders) ? null : (
                <ManualReminderList invoiceId={invoice.id} reminders={reminders} readOnly={readOnly} />
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
