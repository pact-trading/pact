'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { PlanSummary } from '@pactagent/core/platform-types';
import { prepareCancel, prepareChangePlan, submitCancel, submitChangePlan } from '@/server/actions/customer';
import { date, period, usdDecimal } from '@/lib/format';
import { useSignedAction } from '../auth/use-signed-action';
import { Button } from '../ui/button';
import { Select } from '../ui/field';
import { Notice } from '../ui/notice';
import { useToast } from '../ui/toast';

/**
 * Cancel in one signature. The passkey sheet shows the effective date before anything is
 * signed; the mandate is revoked at once, so nothing is charged after today.
 */
export function CancelSubscription({
  id,
  plan,
  periodEnd = null,
}: {
  id: string;
  plan: string;
  /** End of the period already paid for, or null when the subscription is behind. */
  periodEnd?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const signed = useSignedAction();
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  return (
    <div className="grid gap-2">
      <Button
        variant="danger"
        className="justify-self-start"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError('');
            const result = await signed(
              () => prepareCancel(id),
              (token, signature) => submitCancel(token, signature),
            );
            if (result.ok) {
              toast(
                `${plan} cancelled. No further charges.${periodEnd ? ` It ends ${date(periodEnd)}.` : ''}`,
              );
              router.refresh();
            } else if (result.error.code !== 'cancelled') setError(result.error.message);
          })
        }
      >
        {pending ? 'Cancelling…' : 'Cancel subscription'}
      </Button>
      {error && <Notice tone="danger">{error}</Notice>}
      <p className="text-[13px] text-muted-foreground">
        {periodEnd
          ? `Effective ${date(periodEnd)}, the end of the period you already paid for. Nothing is charged after today, and any later attempt is refused.`
          : 'Effective today. Nothing more is charged, and any later attempt is refused.'}{' '}
        Cancelling costs you nothing.
      </p>
    </div>
  );
}

export function ChangePlan({
  id,
  currentPlanId,
  plans,
}: {
  id: string;
  currentPlanId: string;
  plans: PlanSummary[];
}) {
  const router = useRouter();
  const toast = useToast();
  const signed = useSignedAction();
  const options = plans.filter(p => p.id !== currentPlanId);
  const [planId, setPlanId] = useState(options[0]?.id ?? '');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  if (!options.length) return null;
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap gap-2">
        <Select
          aria-label="New plan"
          value={planId}
          onChange={e => setPlanId(e.target.value)}
          className="w-auto min-w-56"
        >
          {options.map(p => (
            <option key={p.id} value={p.id}>
              {p.name} · {usdDecimal(p.amount)} / {period(p.periodSeconds)}
            </option>
          ))}
        </Select>
        <Button
          disabled={pending || !planId}
          onClick={() =>
            start(async () => {
              setError('');
              const result = await signed(
                () => prepareChangePlan(id, planId),
                (token, signature) => submitChangePlan(token, signature),
              );
              if (result.ok) {
                toast(`Switched to ${result.data.plan}`);
                router.push(`/portal/subscriptions/${result.data.id}`);
              } else if (result.error.code !== 'cancelled') setError(result.error.message);
            })
          }
        >
          {pending ? 'Switching…' : 'Switch plan'}
        </Button>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      <p className="text-[13px] text-muted-foreground">
        You sign a new cap; the old one is revoked in the same transaction. The new price starts at your next
        billing date.
      </p>
    </div>
  );
}
