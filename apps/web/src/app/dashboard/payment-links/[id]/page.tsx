import type { Metadata } from 'next';
import Link from 'next/link';
import { IconExternalLink, IconShoppingBag } from '@tabler/icons-react';
import { LinkStateBadge, linkAmount, linkKindLabel } from '@/components/merchant/payment-links/link-state';
import { LinkStatusButton } from '@/components/merchant/payment-links/link-status-button';
import { QrCode } from '@/components/merchant/qr-code';
import { NotConnected } from '@/components/states/not-connected';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, DetailList } from '@/components/ui/card';
import { CodeBlock } from '@/components/ui/code-block';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { date, dateTime, money, usd } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Payment link' };

const stateNote = {
  active: 'Taking payments.',
  inactive: 'Turned off. The pay page says the link is no longer taking payments.',
  expired: 'Past its expiry date. The pay page says it has expired.',
  used: 'Paid once already. A single-use link takes no further payments.',
};

export default async function PaymentLinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ created?: string }>;
}) {
  const [{ id }, { created }] = await Promise.all([params, searchParams]);
  const data = await getData();
  const [detail, viewer] = await Promise.all([load(() => data.commerce.paymentLink(id)), getViewer()]);
  if (isNotWired(detail)) return <NotConnected feature={detail.feature} />;
  const { link, payments } = detail;
  const canWrite = viewer?.role === 'merchant';
  const canToggle = canWrite && (link.status === 'active' || data.mode === 'mock');
  return (
    <>
      <PageHeader
        back={{ href: '/dashboard/payment-links', label: 'Payment links' }}
        eyebrow={<span className="font-mono">{link.id}</span>}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {link.name} <LinkStateBadge state={link.state} />
          </span>
        }
        description={link.description ?? undefined}
        actions={
          <>
            {canToggle && (
              <LinkStatusButton
                id={link.id}
                name={link.name}
                status={link.status}
                size="md"
                variant="secondary"
              />
            )}
            <Button asChild variant="dark">
              <a href={link.url} target="_blank" rel="noreferrer">
                <IconExternalLink className="size-4" />
                Open pay page
              </a>
            </Button>
          </>
        }
      />
      {created && (
        <Notice tone="success" title="Your link is ready" className="mb-6">
          Copy the link or let customers scan the QR code. Payments made through it show up here and in
          Orders.
        </Notice>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader
              title="Share"
              description="Anyone with the link can pay with an email or a passkey. No wallet needed."
            />
            <CardBody className="grid gap-5 sm:grid-cols-[auto_1fr] sm:items-start">
              <div className="justify-self-center">
                <QrCode value={link.url} />
              </div>
              <div className="grid min-w-0 gap-3">
                <div className="flex min-w-0 items-center gap-1 rounded-[14px] border border-input bg-raised py-1 pr-1 pl-3.5">
                  <code className="min-w-0 flex-1 truncate text-sm" title={link.url} data-testid="link-url">
                    {link.url}
                  </code>
                  <CopyButton value={link.url} label="Copy link" showLabel />
                </div>
                {link.state !== 'active' && (
                  <Notice tone="warning">The link still opens, but payers cannot pay it right now.</Notice>
                )}
                <CodeBlock title="Or link from your site" code={`<a href="${link.url}">Pay with Pact</a>`} />
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              title="Payments"
              description="Every checkout started through this link, newest first."
              action={
                <Button asChild size="sm" variant="ghost">
                  <Link href="/dashboard/orders">All orders</Link>
                </Button>
              }
            />
            {payments === null ? (
              <CardBody>
                <Notice>
                  The API does not list payments by link yet. They appear in Orders with the rest of your
                  checkouts.
                </Notice>
              </CardBody>
            ) : payments.length === 0 ? (
              <EmptyState icon={<IconShoppingBag />} title="No payments yet">
                Share the link. Each payment shows up here as soon as it is confirmed.
              </EmptyState>
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Order</Th>
                    <Th>Customer</Th>
                    <Th align="right">Amount</Th>
                    <Th>Status</Th>
                    <Th>Date</Th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map(order => (
                    <Tr key={order.id}>
                      <Td>
                        <Link
                          href={`/dashboard/orders/${order.id}`}
                          className="font-mono text-[13px] font-medium hover:underline"
                        >
                          {order.id}
                        </Link>
                      </Td>
                      <Td>
                        <p>{order.customerName ?? 'Customer'}</p>
                        <p className="text-[13px] text-muted-foreground">{order.customerEmail}</p>
                      </Td>
                      <Td align="right">
                        <p className="font-medium">{money(order.total)}</p>
                        {order.refundedMinor !== '0' && (
                          <p className="text-[13px] text-muted-foreground">
                            −{usd(order.refundedMinor)} refunded
                          </p>
                        )}
                      </Td>
                      <Td>
                        <StatusBadge status={order.status} />
                      </Td>
                      <Td className="text-muted-foreground">{dateTime(order.createdAt)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>

        <Card className="self-start">
          <CardHeader title="Details" />
          <CardBody>
            <DetailList
              items={[
                {
                  label: 'Status',
                  value: <LinkStateBadge state={link.state} />,
                  hint: stateNote[link.state],
                },
                { label: 'Amount', value: linkAmount(link), hint: linkKindLabel[link.kind] },
                {
                  label: 'Visits',
                  value: link.visits.toLocaleString('en-US'),
                  hint: 'Times the pay page was opened',
                },
                ...(link.payments !== null
                  ? [{ label: 'Payments', value: `${link.payments}${link.singleUse ? ' of 1' : ''}` }]
                  : []),
                ...(link.collectedMinor !== null
                  ? [{ label: 'Collected', value: usd(link.collectedMinor), hint: 'After refunds' }]
                  : []),
                { label: 'Single use', value: link.singleUse ? 'Yes' : 'No' },
                { label: 'Expires', value: link.expiresAt ? dateTime(link.expiresAt) : 'Never' },
                { label: 'Created', value: date(link.createdAt) },
              ]}
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
