'use client';

import Link from 'next/link';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconClockHour4,
  IconLoader2,
  IconPackage,
  IconPlugConnectedX,
  type Icon,
} from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import type { StoreOrderView, WebhookOutcome } from '@/server/data/parts/lab';
import { simulateWebhook } from '@/server/actions/lab';
import { dateTime, time, usd } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge, StatusBadge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardBody, CardHeader, DetailList } from '../ui/card';
import { Notice } from '../ui/notice';

type Stage =
  | 'awaiting_payment'
  | 'confirming'
  | 'expired'
  | 'failed'
  | 'no_endpoint'
  | 'waiting'
  | 'retrying'
  | 'fulfilled';

function stageOf(order: StoreOrderView): Stage {
  if (order.fulfilment.count > 0) return 'fulfilled';
  if (order.paidAt === null) {
    if (order.checkoutStatus === 'pending' || order.orderStatus === 'pending') return 'confirming';
    if (order.checkoutStatus === 'expired' || order.orderStatus === 'expired') return 'expired';
    if (order.checkoutStatus === 'failed' || order.orderStatus === 'failed') return 'failed';
    return 'awaiting_payment';
  }
  const latest = order.webhook.deliveries[0];
  if (!latest) return 'no_endpoint';
  return latest.status === 'failed' ? 'retrying' : 'waiting';
}

const stages: Record<Stage, { label: string; icon: Icon; tone: string; spin?: boolean }> = {
  awaiting_payment: {
    label: 'Awaiting payment',
    icon: IconClockHour4,
    tone: 'bg-chip text-subtle-foreground',
  },
  confirming: {
    label: 'Confirming payment',
    icon: IconLoader2,
    tone: 'bg-warning-soft text-warning',
    spin: true,
  },
  expired: { label: 'Checkout expired', icon: IconClockHour4, tone: 'bg-chip text-subtle-foreground' },
  failed: { label: 'Payment failed', icon: IconAlertTriangle, tone: 'bg-destructive-soft text-destructive' },
  no_endpoint: {
    label: 'Paid · no webhook endpoint',
    icon: IconPlugConnectedX,
    tone: 'bg-warning-soft text-warning',
  },
  waiting: {
    label: 'Paid · waiting for webhook',
    icon: IconLoader2,
    tone: 'bg-warning-soft text-warning',
    spin: true,
  },
  retrying: {
    label: 'Paid · delivery failed',
    icon: IconAlertTriangle,
    tone: 'bg-destructive-soft text-destructive',
  },
  fulfilled: { label: 'Fulfilled', icon: IconCircleCheck, tone: 'bg-success-soft text-success' },
};

/** Stages the page polls through until the webhook settles them. */
const live: Stage[] = ['confirming', 'waiting', 'retrying'];

/**
 * The store's order confirmation. It shows the order as the store sees it: paid when Pact
 * says so, fulfilled only when the signed `order.paid` webhook arrives, and only once.
 */
export function StoreOrderLive({
  order,
  brandName,
  shopperName,
  canPay,
  canSimulate,
}: {
  order: StoreOrderView;
  brandName: string;
  shopperName: string | null;
  canPay: boolean;
  canSimulate: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  const stage = stageOf(order);
  const meta = stages[stage];
  const Glyph = meta.icon;
  const latest = order.webhook.deliveries[0];

  useEffect(() => {
    if (!live.includes(stage)) return;
    const timer = window.setInterval(() => router.refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [stage, router]);

  const simulate = (outcome: WebhookOutcome) =>
    start(async () => {
      if (!order.webhook.event) return;
      const result = await simulateWebhook(order.webhook.event.id, outcome);
      setMessage(
        result.ok
          ? { tone: 'success', text: result.data.message }
          : { tone: 'danger', text: result.error.message },
      );
      router.refresh();
    });

  const copy: Record<Stage, string> = {
    awaiting_payment: 'Your order is reserved. Pay on the secure checkout to complete it.',
    confirming: 'This takes a second or two.',
    expired: 'The checkout expired before it was paid. Nothing was charged.',
    failed: 'The payment did not go through. Nothing was charged.',
    no_endpoint: `Pact confirmed the payment, but ${brandName} has no webhook endpoint, so the store has not heard about it and cannot fulfil the order yet.`,
    waiting: `Pact confirmed your payment. ${brandName} fulfils the order when the signed order.paid webhook reaches its server.`,
    retrying: latest
      ? `The store’s endpoint answered ${latest.last_http_status ?? 'with an error'}. Pact retries at ${time(latest.next_at)}; nothing is fulfilled until a delivery succeeds.`
      : 'The delivery failed. Pact retries with backoff.',
    fulfilled: `${shopperName ? `Thanks, ${shopperName.split(' ')[0]}. ` : ''}The store fulfilled this order once, when the order.paid webhook arrived.`,
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,380px)]">
      <div className="grid content-start gap-6">
        <Card>
          <CardBody className="grid gap-4">
            <span
              data-testid="store-status"
              className={cn(
                'inline-flex w-fit items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-medium',
                meta.tone,
              )}
            >
              <Glyph className={cn('size-4', meta.spin && 'animate-spin')} />
              {meta.label}
            </span>
            <div>
              <h1 className="text-2xl leading-tight font-semibold sm:text-3xl">{order.productName}</h1>
              <p className="mt-2 max-w-xl text-[15px] text-muted-foreground">{copy[stage]}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {stage === 'awaiting_payment' && canPay && order.sessionId && (
                <Button asChild variant="primary">
                  <Link href={`/checkout/${order.sessionId}`}>Continue to payment</Link>
                </Button>
              )}
              {(stage === 'expired' || stage === 'failed') && (
                <Button asChild variant="dark">
                  <Link href="/demo/store">Shop again</Link>
                </Button>
              )}
              {stage === 'fulfilled' && (
                <Button asChild variant="dark">
                  <Link href="/demo/store">
                    <IconPackage className="size-4.5" />
                    Keep shopping
                  </Link>
                </Button>
              )}
              {stage === 'no_endpoint' && !canPay && (
                <Button asChild variant="dark">
                  <Link href="/dashboard/developers?tab=webhooks">Set up a webhook endpoint</Link>
                </Button>
              )}
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Order" />
          <CardBody>
            <DetailList
              items={[
                { label: 'Order', value: <code className="font-mono text-[13px]">{order.orderId}</code> },
                { label: 'Item', value: order.productName },
                { label: 'Amount', value: usd(order.amountMinor) },
                {
                  label: 'Payment',
                  value: order.paidAt ? dateTime(order.paidAt) : 'Not paid yet',
                  hint:
                    order.orderStatus === 'refunded' || order.orderStatus === 'partially_refunded' ? (
                      <StatusBadge status={order.orderStatus} className="mt-1" />
                    ) : undefined,
                },
                {
                  label: 'Fulfilled',
                  value: (
                    <>
                      <span data-testid="fulfilments">{order.fulfilment.count}</span>{' '}
                      {order.fulfilment.count === 1 ? 'time' : 'times'}
                    </>
                  ),
                  hint: order.fulfilment.fulfilledAt ? dateTime(order.fulfilment.fulfilledAt) : undefined,
                },
                {
                  label: 'Duplicates ignored',
                  value: <span data-testid="duplicates">{order.fulfilment.duplicatesIgnored}</span>,
                },
              ]}
            />
          </CardBody>
        </Card>
      </div>
      <Card className="content-start self-start">
        <CardHeader
          title="Webhook"
          description={
            order.webhook.event ? (
              <>
                <code className="font-mono">order.paid</code> · {order.webhook.event.id}
              </>
            ) : (
              'Sent when the payment confirms'
            )
          }
          action={canSimulate && order.webhook.event ? <Badge tone="outline">Demo</Badge> : undefined}
        />
        <CardBody className="grid gap-4">
          {order.webhook.deliveries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {order.paidAt
                ? order.webhook.configured
                  ? 'No delivery was queued for this payment.'
                  : 'No endpoint was configured when the payment confirmed.'
                : 'Nothing sent yet: the order is not paid.'}
            </p>
          ) : (
            <ol
              aria-label="Delivery attempts"
              className="divide-y divide-border-subtle rounded-xl border border-border"
            >
              {order.webhook.deliveries.map(d => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                  <span className="text-sm font-medium">Attempt {d.attempt}</span>
                  <span className="flex items-center gap-2">
                    <StatusBadge status={d.status} />
                    <span className="text-[13px] text-muted-foreground">
                      {d.last_http_status ?? (d.status === 'pending' ? `due ${time(d.next_at)}` : '')}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
          )}
          {canSimulate && latest && (
            <div className="grid gap-2">
              <p className="text-sm text-subtle-foreground">Answer as the store’s endpoint:</p>
              <div className="flex flex-wrap gap-2">
                {latest.status === 'pending' && (
                  <>
                    <Button size="sm" variant="dark" disabled={pending} onClick={() => simulate('delivered')}>
                      Deliver now
                    </Button>
                    <Button size="sm" disabled={pending} onClick={() => simulate('failed')}>
                      Fail delivery
                    </Button>
                  </>
                )}
                {latest.status === 'failed' && (
                  <Button size="sm" variant="dark" disabled={pending} onClick={() => simulate('retry')}>
                    Retry now
                  </Button>
                )}
                {latest.status === 'delivered' && (
                  <Button size="sm" disabled={pending} onClick={() => simulate('duplicate')}>
                    Send duplicate
                  </Button>
                )}
              </div>
            </div>
          )}
          {message && <Notice tone={message.tone}>{message.text}</Notice>}
        </CardBody>
      </Card>
    </div>
  );
}
