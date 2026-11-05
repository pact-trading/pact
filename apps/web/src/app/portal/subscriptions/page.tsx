import type { Metadata } from 'next';
import Link from 'next/link';
import { IconRepeat } from '@tabler/icons-react';
import { AvailablePlans } from '@/components/portal/available-plans';
import { subscriptionEndsAt } from '@/components/portal/subscription-end';
import { NotConnected } from '@/components/states/not-connected';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { chargeTime, date, period, usdDecimal } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';

export const metadata: Metadata = { title: 'Subscriptions' };

export default async function PortalSubscriptionsPage() {
  const data = await getData();
  const [subs, demo, plans] = await Promise.all([
    load(() => data.customer.subscriptions()),
    data.demo?.state(),
    // A side list: if it cannot load, the customer's own subscriptions still show.
    data.customer.availablePlans().catch(() => []),
  ]);
  if (isNotWired(subs)) return <NotConnected feature={subs.feature} />;
  const now = demo?.now ?? new Date().toISOString();
  return (
    <>
      <PageHeader
        title="Subscriptions"
        description="Each one has a cap you signed. Cancel anytime."
        actions={
          plans.length > 0 && (
            <Button asChild size="sm">
              <Link href="#plans">Browse plans</Link>
            </Button>
          )
        }
      />
      <Card>
        {subs.length === 0 ? (
          <EmptyState icon={<IconRepeat />} title="No subscriptions">
            {plans.length > 0
              ? 'Pick a plan below. When you subscribe, you approve a cap per period, and you can cancel anytime here.'
              : 'Open a business’s subscribe link to join a plan. You approve a cap per period and can cancel anytime here.'}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {subs.map(s => {
              const endsAt = subscriptionEndsAt(s);
              return (
                <li key={s.id}>
                  <Link
                    href={`/portal/subscriptions/${s.id}`}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hover:bg-raised"
                  >
                    <div>
                      <p className="font-medium">
                        {s.plan} · {s.merchantName}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Up to {usdDecimal(s.amount)} each {period(s.periodSeconds)}
                        {s.status === 'trialing' && s.trialEndsAt ? ` · Trial ends ${date(s.trialEndsAt)}` : ''}
                        {s.status === 'active'
                          ? ` · next ${chargeTime(s.nextChargeAt, s.periodSeconds)}`
                          : ''}
                        {endsAt ? ` · ${endsAt > now ? 'ends' : 'ended'} ${date(endsAt)}` : ''}
                      </p>
                    </div>
                    <span className="flex items-center gap-2">
                      {endsAt && endsAt > now && <Badge tone="warning">Ends {date(endsAt)}</Badge>}
                      <StatusBadge status={s.status} />
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <AvailablePlans plans={plans} subscriptions={subs} />
    </>
  );
}
