import type { Metadata } from 'next';
import Link from 'next/link';
import { IconLock } from '@tabler/icons-react';
import { RenewalButton } from '@/components/merchant/subscriptions/renewal-button';
import {
  CancelSubscriptionDialog,
  MerchantCancelSubscriptionDialog,
  RenewalFailureButton,
} from '@/components/merchant/subscriptions/subscription-actions';
import { subscriptionEndsAt } from '@/components/portal/subscription-end';
import { NotConnected } from '@/components/states/not-connected';
import { PublicRecord } from '@/components/states/public-record';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, DetailList } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Timeline } from '@/components/ui/timeline';
import { chargeTime, date, dateTime, humanize, period, usdDecimal } from '@/lib/format';
import { getData } from '@/server/data';
import { reasonDetail } from '@/lib/reasons';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Subscription' };

export default async function SubscriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getData();
  const [sub, viewer, demo] = await Promise.all([
    load(() => data.merchant.subscription(id)),
    getViewer(),
    data.demo?.state(),
  ]);
  if (isNotWired(sub)) return <NotConnected feature={sub.feature} />;
  const live = sub.status === 'trialing' || sub.status === 'active' || sub.status === 'past_due';
  const now = demo?.now ?? new Date().toISOString();
  const endsAt = subscriptionEndsAt(sub);
  const merchant = viewer?.role === 'merchant';
  return (
    <>
      <PageHeader
        back={{ href: '/dashboard/subscriptions', label: 'Subscriptions' }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {sub.plan} <StatusBadge status={sub.status} />
            {endsAt && endsAt > now && <Badge tone="warning">Ends {date(endsAt)}</Badge>}
          </span>
        }
        description={[sub.customerName, sub.customerEmail].filter(Boolean).join(' · ') || 'Customer'}
        actions={
          merchant &&
          sub.status !== 'cancelled' &&
          (data.mode === 'api' ? (
            <MerchantCancelSubscriptionDialog id={sub.id} />
          ) : (
            <CancelSubscriptionDialog
              id={sub.id}
              customer={sub.customerName ?? sub.customerEmail ?? 'The customer'}
              periodEnd={sub.status === 'active' ? sub.nextChargeAt : null}
              now={now}
            />
          ))
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader
              title="Signed mandate"
              description="What the customer approved. The contract enforces it."
              action={<IconLock className="size-5 text-muted-foreground" />}
            />
            <CardBody>
              <DetailList
                items={[
                  ...(sub.status === 'trialing' && sub.trialEndsAt ? [{ label: 'Trial ends', value: dateTime(sub.trialEndsAt) }] : []),
                  { label: 'Cap per period', value: usdDecimal(sub.mandate.amountCap) },
                  { label: 'Period', value: `Every ${period(sub.mandate.periodSeconds)}` },
                  {
                    label: 'Periods',
                    value: sub.maxPeriods
                      ? `${sub.periodsCharged} of ${sub.maxPeriods} charged`
                      : `${sub.periodsCharged} charged`,
                  },
                  { label: 'Signed', value: dateTime(sub.mandate.signedAt) },
                  {
                    label: 'Next pull',
                    value: live ? chargeTime(sub.nextChargeAt, sub.periodSeconds) : '—',
                    hint: sub.status === 'past_due' ? `Retry ${sub.retryCount} of 3` : undefined,
                  },
                  {
                    label: 'Customer',
                    value: (
                      <Link href={`/dashboard/customers/${sub.customerId}`} className="hover:underline">
                        {sub.customerName ?? sub.customerEmail}
                      </Link>
                    ),
                  },
                ]}
              />
            </CardBody>
          </Card>
          {sub.status === 'past_due' && (
            <Notice tone="warning" title="Past due">
              The last pull failed because the customer’s balance was too low. The keeper retries once a day,
              three times, then pauses the subscription and sends a subscription.past_due webhook.
            </Notice>
          )}
          {sub.status === 'paused' && (
            <Notice tone="warning" title="Paused after three failed retries">
              No further pulls until the customer adds funds and resubscribes.
            </Notice>
          )}
          {sub.status === 'cancelled' && (
            <Notice title={`Cancelled ${sub.cancelledAt ? dateTime(sub.cancelledAt) : ''}`}>
              {sub.replacedBy
                ? 'Replaced by a new plan in the same transaction.'
                : `${endsAt && endsAt > now ? `Ends ${date(endsAt)}, the end of the period already paid for.` : `Ended ${date(endsAt ?? sub.cancelledAt ?? now)}.`} Pact stops all further charges after cancellation.`}
            </Notice>
          )}
          {merchant && (
            <Card>
              <CardHeader
                title="Try a renewal"
                description="Demo controls: ask the keeper to pull now, or see what a failed renewal does. Early or cancelled pulls are refused with a reason the customer can see."
              />
              <CardBody className="grid gap-4">
                <RenewalButton id={sub.id} disabled={sub.status === 'paused'} />
                {live && data.mode === 'mock' && <RenewalFailureButton id={sub.id} />}
              </CardBody>
            </Card>
          )}
        </div>
        <Card>
          <CardHeader title="Charges and refusals" description="Every pull attempt is an onchain event" />
          <CardBody>
            <Timeline
              items={sub.charges.map(c => ({
                id: c.id,
                title:
                  c.status === 'charged'
                    ? `Period ${c.period} charged · ${usdDecimal(c.amount)}`
                    : `Refused: ${humanize(c.reason ?? 'refused')}`,
                detail:
                  c.status === 'charged'
                    ? 'Pulled by the keeper within the signed cap'
                    : `${reasonDetail(c.reason ?? '')}${c.status === 'retry_scheduled' ? ' A retry is scheduled.' : ''}`,
                at: dateTime(c.at),
                tone:
                  c.status === 'charged'
                    ? 'success'
                    : c.reason === 'insufficient_funds'
                      ? 'warning'
                      : 'danger',
                extra: <PublicRecord hash={c.txHash} />,
              }))}
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
