import type { Metadata } from 'next';
import Link from 'next/link';
import { IconArrowUpRight, IconCircleCheckFilled, IconReceiptRefund } from '@tabler/icons-react';
import { RefundDialog, RefundPanel } from '@/components/merchant/orders/refund-panel';
import { PrintButton, Printable } from '@/components/portal/printable';
import { NotConnected } from '@/components/states/not-connected';
import { PublicRecord } from '@/components/states/public-record';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, DetailList } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Timeline } from '@/components/ui/timeline';
import { txUrl } from '@/lib/explorer';
import { dateTime, humanize, money, usd, wbt } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Order' };

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getData();
  const [detail, viewer, demo, sources] = await Promise.all([
    load(() => data.merchant.order(id)),
    getViewer(),
    data.demo?.state(),
    // Where the order came from (payment link or manual order); absent where the API has no record.
    data.commerce.orderSources().catch(() => null),
  ]);
  if (isNotWired(detail)) return <NotConnected feature={detail.feature} />;
  const { order, payment, refunds, refusals, customer } = detail;
  const answers = Object.entries(order.metadata ?? {});
  const source = sources?.[order.id];
  const now = demo?.now ?? new Date().toISOString();
  const windowOpen = !detail.refundWindowEndsAt || detail.refundWindowEndsAt > now;
  const total = BigInt(order.total.amountMinor);
  const fee = BigInt(payment?.feeMinor ?? '0');
  const refunded = BigInt(order.refundedMinor);
  const paid = ['paid', 'partially_refunded', 'refunded'].includes(order.status);
  const readOnly = viewer?.role !== 'merchant';
  const paidAt = detail.activity.find(a => a.type === 'payment.captured')?.at ?? order.createdAt;
  const settled = refunds.filter(r => r.status === 'succeeded');
  const method = payment?.method;
  return (
    <>
      <PageHeader
        back={{ href: '/dashboard/orders', label: 'Orders' }}
        eyebrow={<span className="font-mono">{order.id}</span>}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {money(order.total)} <span className="text-muted-foreground">·</span> {order.productName}{' '}
            <StatusBadge status={order.status} />
          </span>
        }
        description={`${customer.name ?? 'Customer'}${customer.company ? ` at ${customer.company}` : ''} · ${dateTime(order.createdAt)}`}
        actions={
          paid &&
          !readOnly && (
            <RefundDialog
              key={detail.refundableMinor}
              orderId={order.id}
              refundableMinor={detail.refundableMinor}
              totalMinor={order.total.amountMinor}
              windowOpen={windowOpen}
            />
          )
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 content-start gap-6">
          <Printable>
            <Card>
              <CardHeader
                title={settled.length ? 'Refund receipt' : 'Payment receipt'}
                description={paid ? `Paid ${dateTime(paidAt)}` : undefined}
                action={
                  paid &&
                  payment && (
                    <>
                      {payment.txHash && (
                        <Button asChild size="sm" variant="ghost" data-print-hide>
                          <a href={txUrl(payment.txHash)} target="_blank" rel="noreferrer">
                            <IconArrowUpRight className="size-4" />
                            View on explorer
                          </a>
                        </Button>
                      )}
                      <PrintButton />
                    </>
                  )
                }
              />
              <CardBody>
                {paid && payment ? (
                  <div className="grid gap-5">
                    <DetailList
                      items={[
                        { label: 'Merchant', value: detail.merchantName },
                        {
                          label: 'Customer',
                          value: [customer.name, customer.email].filter(Boolean).join(' · ') || '—',
                        },
                        { label: 'For', value: order.productName },
                        {
                          label: 'Charged',
                          value: money(order.total),
                          hint: 'USDT, settled in the same block',
                        },
                        ...(method
                          ? [
                              {
                                label: 'Paid with',
                                value: (
                                  <span className="inline-flex flex-wrap items-center justify-end gap-2">
                                    {method.label}
                                    {method.demo && <Badge tone="outline">Demo</Badge>}
                                  </span>
                                ),
                              },
                            ]
                          : []),
                        {
                          label: 'Pact fee',
                          value: usd(fee),
                          hint: `${(Number((fee * 10_000n) / (total || 1n)) / 100).toFixed(2)}% taken in the same transaction`,
                        },
                        { label: 'Refunded', value: usd(refunded) },
                        { label: 'Net to you', value: usd(total - fee - refunded) },
                        {
                          label: 'Gas',
                          value: wbt(payment.gasWei, 6),
                          hint: 'Paid from your gas tank. The customer paid none.',
                        },
                        {
                          label: 'Payment id',
                          value: <code className="text-[13px] break-all">{payment.id}</code>,
                        },
                      ]}
                    />
                    {settled.length > 0 && (
                      <div className="grid gap-2">
                        <h3 className="text-sm font-semibold">Refunds</h3>
                        <ul className="grid gap-2">
                          {settled.map(refund => (
                            <li
                              key={refund.id}
                              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-raised px-4 py-3 text-sm"
                            >
                              <span className="flex items-start gap-2">
                                <IconReceiptRefund className="mt-0.5 size-4 shrink-0 text-success" />
                                <span>
                                  <span className="font-medium">−{usd(refund.amountMinor)}</span>
                                  <span className="block text-muted-foreground">
                                    {refund.reason} · {dateTime(refund.createdAt)}
                                  </span>
                                </span>
                              </span>
                              <PublicRecord hash={refund.txHash} />
                            </li>
                          ))}
                        </ul>
                        <p className="text-[13px] text-muted-foreground">
                          {usd(BigInt(detail.refundableMinor))} of {money(order.total)} can still be refunded.
                        </p>
                      </div>
                    )}
                  </div>
                ) : (
                  <Notice>
                    {order.status === 'expired'
                      ? 'The checkout expired before the customer paid.'
                      : 'Waiting for the customer to confirm.'}
                  </Notice>
                )}
              </CardBody>
            </Card>
          </Printable>
          {answers.length > 0 && (
            <Card>
              <CardHeader title="Checkout answers" description="What the customer entered with this order" />
              <CardBody>
                <DetailList
                  items={answers.map(([key, value]) => ({
                    label: detail.product?.checkoutFields?.find(field => field.key === key)?.label ?? humanize(key),
                    value: <span className="[overflow-wrap:anywhere]">{value === true ? 'Yes' : value === false ? 'No' : String(value)}</span>,
                  }))}
                />
              </CardBody>
            </Card>
          )}
          {paid && (
            <Card>
              <CardHeader
                title="Refund"
                description={
                  detail.refundWindowEndsAt
                    ? `Refund window ${windowOpen ? 'open until' : 'closed on'} ${dateTime(detail.refundWindowEndsAt)}`
                    : undefined
                }
              />
              <CardBody>
                <RefundPanel
                  key={detail.refundableMinor}
                  orderId={order.id}
                  refundableMinor={detail.refundableMinor}
                  fullyRefunded={order.status === 'refunded'}
                  windowOpen={windowOpen}
                  readOnly={readOnly}
                />
              </CardBody>
            </Card>
          )}
          {refusals.length > 0 && (
            <Card>
              <CardHeader
                title="Refused refund attempts"
                description="Stopped by the payment contract and kept on the public record"
              />
              <ul className="divide-y divide-border-subtle">
                {refusals.map(refusal => (
                  <li
                    key={refusal.id}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                  >
                    <div>
                      <p className="font-medium">Refund refused: {humanize(refusal.reason)}</p>
                      <p className="text-sm text-muted-foreground">
                        {refusal.detail} · {dateTime(refusal.createdAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <StatusBadge status="refused" />
                      <PublicRecord hash={refusal.txHash} />
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader
              title="Customer"
              action={
                <Link
                  href={`/dashboard/customers/${customer.id}`}
                  className="text-sm font-medium hover:underline"
                >
                  View
                </Link>
              }
            />
            <CardBody>
              <DetailList
                items={[
                  { label: 'Name', value: customer.name ?? '—' },
                  { label: 'Email', value: customer.email ?? '—' },
                  { label: 'Company', value: customer.company ?? '—' },
                ]}
              />
            </CardBody>
          </Card>
          {source && (
            <Card>
              <CardHeader
                title="Source"
                action={
                  source.kind === 'link' ? (
                    <Link
                      href={`/dashboard/payment-links/${source.linkId}`}
                      className="text-sm font-medium hover:underline"
                    >
                      View link
                    </Link>
                  ) : undefined
                }
              />
              <CardBody>
                <DetailList
                  items={
                    source.kind === 'link'
                      ? [
                          { label: 'Created from', value: 'Payment link' },
                          { label: 'Link', value: source.label },
                        ]
                      : [
                          { label: 'Created from', value: 'Manual order' },
                          { label: 'Pay link', value: source.payUrl },
                          ...(source.note ? [{ label: 'Note', value: source.note }] : []),
                        ]
                  }
                />
              </CardBody>
            </Card>
          )}
          <Card>
            <CardHeader title="Timeline" />
            <CardBody>
              <Timeline
                items={detail.activity.map((item, index) => ({
                  id: `${item.type}-${index}`,
                  title: humanize(item.type.replace('order.', '').replace('payment.', 'payment ')),
                  detail: item.detail,
                  at: dateTime(item.at),
                  tone: item.type.includes('refunded')
                    ? 'default'
                    : item.type.includes('captured')
                      ? 'success'
                      : 'default',
                  extra: item.txHash ? <PublicRecord hash={item.txHash} /> : undefined,
                }))}
              />
            </CardBody>
          </Card>
          {paid && (
            <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
              <IconCircleCheckFilled className="mt-0.5 size-4 shrink-0 text-success" />
              The customer sees the same receipt, with every refund, in their portal.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
