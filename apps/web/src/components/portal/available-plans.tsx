import Link from 'next/link';
import type { SubscriptionDetail } from '@pactagent/core/platform-types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { period, usdDecimal } from '@/lib/format';
import type { AvailablePlan } from '@/server/data/types';

/** Subscriptions that still hold their plan: the plan shows as joined, not as an offer. */
const HOLDING = new Set(['trialing', 'active', 'past_due', 'pending']);

/**
 * Plans the customer can join, from businesses they already buy from or subscribe to. Each one
 * opens the hosted subscribe page; a plan they already hold links to that subscription instead.
 */
export function AvailablePlans({ plans, subscriptions }: { plans: AvailablePlan[]; subscriptions: SubscriptionDetail[] }) {
  if (plans.length === 0) return null;
  return (
    <Card id="plans" className="mt-6 scroll-mt-6">
      <CardHeader
        title="Plans from businesses you use"
        description="Active plans from businesses you have bought from or subscribed to."
      />
      <ul className="divide-y divide-border-subtle">
        {plans.map(({ plan, merchant }) => {
          const held = subscriptions.find(s => s.planId === plan.id && HOLDING.has(s.status));
          const trialDays = plan.trialDays ?? 0;
          return (
            <li key={plan.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <div className="min-w-0">
                <p className="font-medium">
                  {plan.name} · {merchant.name}
                </p>
                {plan.description && <p className="text-sm text-muted-foreground">{plan.description}</p>}
                <p className="text-sm text-muted-foreground">
                  {usdDecimal(plan.amount)} / {period(plan.periodSeconds)}
                  {plan.maxPeriods ? ` · ${plan.maxPeriods} periods max` : ''}
                  {trialDays > 0 && !held ? ` · ${trialDays}-day free trial` : ''}
                </p>
              </div>
              {held ? (
                <span className="flex items-center gap-2">
                  <Badge tone="success">Subscribed</Badge>
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/portal/subscriptions/${held.id}`}>Manage</Link>
                  </Button>
                </span>
              ) : (
                <Button asChild size="sm" variant="dark">
                  <Link href={`/subscribe/${encodeURIComponent(plan.id)}`}>
                    {trialDays > 0 ? 'Start free trial' : 'Subscribe'}
                  </Link>
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
