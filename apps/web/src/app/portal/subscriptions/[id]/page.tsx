import type { Metadata } from 'next';
import { IconShieldCheck } from '@tabler/icons-react';
import { CancelSubscription, ChangePlan } from '@/components/customer/subscription-controls';
import { subscriptionEndsAt } from '@/components/portal/subscription-end';
import { NotConnected } from '@/components/states/not-connected';
import { PublicRecord } from '@/components/states/public-record';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, DetailList } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Timeline } from '@/components/ui/timeline';
import { chargeTime, date, dateTime, humanize, period, usdDecimal } from '@/lib/format';
import { reasonDetail } from '@/lib/reasons';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';

export const metadata: Metadata = { title: 'Subscription' };

const customerReason: Record<string, string> = {
  too_early: 'The business tried to charge before your billing period ended. The contract refused it.',
  cancelled: 'The business tried to charge after you cancelled. The contract refused it.',
  cap_exceeded: 'The business tried to charge more than your cap. The contract refused it.',
  max_periods: 'Your approved number of payments was already used. The contract refused another.',
  insufficient_funds: 'Your balance was too low, so nothing was taken. It will be retried.',
};

export default async function PortalSubscriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getData();
  const [sub, demo] = await Promise.all([load(() => data.customer.subscription(id)), data.demo?.state()]);
  if (isNotWired(sub)) return <NotConnected feature={sub.feature} />;
  const now = demo?.now ?? new Date().toISOString();
  const endsAt = subscriptionEndsAt(sub);
  const catalog = await load(() => data.checkout.plans());
  const plans = isNotWired(catalog) ? [] : catalog;
  const refused = sub.charges.filter(c => c.status === 'refused' && c.reason !== 'insufficient_funds');
  const live = sub.status === 'trialing' || sub.status === 'active' || sub.status === 'past_due';
  return (
    <>
      <PageHeader
        back={{ href: '/portal/subscriptions', label: 'Subscriptions' }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {sub.plan} <StatusBadge status={sub.status} />
            {endsAt && endsAt > now && <Badge tone="warning">Ends {date(endsAt)}</Badge>}
          </span>
        }
        description={`${sub.merchantName} · ${usdDecimal(sub.amount)} each ${period(sub.periodSeconds)}`}
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader
              title="What you approved"
              description="Enforced by the contract, not by trust"
              action={<IconShieldCheck className="size-5 text-success" />}
            />
            <CardBody>
              <DetailList
                items={[
                  ...(sub.status === 'trialing' && sub.trialEndsAt ? [{ label: 'Trial ends', value: dateTime(sub.trialEndsAt) }] : []),
                  { label: 'Most per charge', value: usdDecimal(sub.mandate.amountCap) },
                  { label: 'At most once every', value: period(sub.mandate.periodSeconds) },
                  {
                    label: 'Payments',
                    value: sub.maxPeriods
                      ? `${sub.periodsCharged} of up to ${sub.maxPeriods}`
                      : `${sub.periodsCharged} so far`,
                  },
                  {
                    label: 'Next charge',
                    value: live ? chargeTime(sub.nextChargeAt, sub.periodSeconds) : 'None',
                  },
                  ...(endsAt
                    ? [
                        {
                          label: endsAt > now ? 'Ends' : 'Ended',
                          value: date(endsAt),
                          hint: endsAt > now ? 'End of the period you paid for' : undefined,
                        },
                      ]
                    : []),
                  { label: 'Approved', value: dateTime(sub.mandate.signedAt) },
                ]}
              />
            </CardBody>
          </Card>
          {refused.length > 0 && (
            <Notice
              tone="shield"
              title={`${refused.length} charge${refused.length > 1 ? 's' : ''} refused on your behalf`}
            >
              {customerReason[refused[0].reason ?? ''] ?? reasonDetail(refused[0].reason ?? '')} No money
              moved.
            </Notice>
          )}
          {live && (
            <Card>
              <CardHeader title="Manage" />
              <CardBody className="grid gap-6">
                <ChangePlan id={sub.id} currentPlanId={sub.planId} plans={plans} />
                <CancelSubscription
                  id={sub.id}
                  plan={sub.plan}
                  periodEnd={sub.status === 'active' ? sub.nextChargeAt : null}
                />
              </CardBody>
            </Card>
          )}
          {sub.status === 'cancelled' && (
            <Notice title={`Cancelled ${sub.cancelledAt ? dateTime(sub.cancelledAt) : ''}`}>
              {sub.replacedBy
                ? 'Replaced by your new plan.'
                : `${endsAt && endsAt > now ? `It runs until ${date(endsAt)}, the end of the period you paid for. ` : ''}Nothing more will be charged. Any attempt is refused and would appear below.`}
            </Notice>
          )}
        </div>
        <Card>
          <CardHeader title="History" description="Every charge and every refused attempt" />
          <CardBody>
            <Timeline
              items={sub.charges.map(c => ({
                id: c.id,
                title:
                  c.status === 'charged'
                    ? `Paid ${usdDecimal(c.amount)}`
                    : `Refused: ${humanize(c.reason ?? '')}`,
                detail:
                  c.status === 'charged'
                    ? `Payment ${c.period}`
                    : (customerReason[c.reason ?? ''] ?? reasonDetail(c.reason ?? '')),
                at: dateTime(c.at),
                tone:
                  c.status === 'charged'
                    ? 'success'
                    : c.reason === 'insufficient_funds'
                      ? 'warning'
                      : 'danger',
                extra: <PublicRecord hash={c.txHash} audience="customer" />,
              }))}
            />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
