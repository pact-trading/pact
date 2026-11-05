'use client';

import { IconAlertTriangle, IconCalendarX } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { CancelEffective } from '@/server/data/types';
import {
  cancelMerchantSubscription,
  prepareCancelSubscription,
  simulateRenewalFailure,
  submitCancelSubscription,
} from '@/server/actions/merchant';
import { date, dateTime, humanize } from '@/lib/format';
import { useSignedAction } from '../../auth/use-signed-action';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { Notice } from '../../ui/notice';
import { useToast } from '../../ui/toast';
import { RadioCards } from '../../portal/radio-cards';

/**
 * Demo control: the keeper pulls the next renewal now as if the customer's balance were too
 * low. The engine records the refusal, schedules a retry and sends subscription.past_due.
 */
export function RenewalFailureButton({ id, disabled }: { id: string; disabled?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ tone: 'warning' | 'danger'; title: string; body: string } | null>(
    null,
  );
  return (
    <div className="grid gap-3">
      <Button
        className="justify-self-start"
        disabled={pending || disabled}
        onClick={() =>
          start(async () => {
            const response = await simulateRenewalFailure(id);
            if (!response.ok)
              setResult({ tone: 'danger', title: 'Could not run', body: response.error.message });
            else if (response.data.refusal)
              setResult({
                tone: 'warning',
                title: `Renewal failed: ${humanize(response.data.refusal.reason)}`,
                body:
                  response.data.subscription.status === 'paused'
                    ? 'That was the last retry, so the subscription is paused.'
                    : `Nothing was taken. The keeper retries ${dateTime(response.data.subscription.nextChargeAt)}, with the customer’s real balance.`,
              });
            else setResult({ tone: 'danger', title: 'Renewal went through', body: 'Nothing failed.' });
            router.refresh();
          })
        }
      >
        <IconAlertTriangle className="size-4" />
        {pending ? 'Pulling…' : 'Simulate renewal failure'}
      </Button>
      {result && (
        <Notice tone={result.tone} title={result.title}>
          {result.body}
        </Notice>
      )}
    </div>
  );
}

/**
 * Merchant-side cancellation. The mandate is revoked as soon as it is signed, so no charge is
 * taken after today; the choice is when the subscription ends for the customer.
 */
export function CancelSubscriptionDialog({
  id,
  customer,
  periodEnd,
  now,
}: {
  id: string;
  customer: string;
  /** End of the period already paid for, or null when the customer is behind. */
  periodEnd: string | null;
  now: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const signed = useSignedAction();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<CancelEffective>('period_end');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  // Without a paid period left (past due), the only end date is today.
  const effective: CancelEffective = periodEnd ? choice : 'now';
  const ends = effective === 'period_end' && periodEnd ? periodEnd : now;

  const submit = () => {
    setOpen(false);
    setError('');
    start(async () => {
      const result = await signed(
        () => prepareCancelSubscription(id, effective),
        (token, signature) => submitCancelSubscription(token, signature),
      );
      if (result.ok) {
        toast(`Cancelled. Ends ${date(ends)}; no further charges.`);
        router.refresh();
      } else {
        if (result.error.code !== 'cancelled') setError(result.error.message);
        setOpen(true);
      }
    });
  };

  return (
    <>
      <Button
        size="sm"
        variant="danger"
        disabled={pending}
        onClick={() => {
          setChoice('period_end');
          setError('');
          setOpen(true);
        }}
      >
        <IconCalendarX className="size-4" />
        {pending ? 'Cancelling…' : 'Cancel subscription'}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Cancel subscription"
        description={`${customer} sees the end date in their portal.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Keep subscription
            </Button>
            <Button variant="dark" onClick={submit} disabled={pending}>
              Cancel subscription
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <RadioCards
            legend="When it ends"
            value={effective}
            onChange={setChoice}
            options={[
              ...(periodEnd
                ? [
                    {
                      value: 'period_end' as const,
                      title: `At the period end, ${date(periodEnd)}`,
                      body: 'They keep what they already paid for',
                    },
                  ]
                : []),
              { value: 'now' as const, title: `Immediately, ${date(now)}`, body: 'Ends today' },
            ]}
            columns={periodEnd ? 2 : 1}
          />
          <Notice title={`Effective ${date(ends)}`}>
            The signed mandate is revoked today, so no charge is taken after the cancellation. Any later pull
            is refused by the contract and shows up here.
          </Notice>
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      </Dialog>
    </>
  );
}

export function MerchantCancelSubscriptionDialog({ id }: { id: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  return (
    <>
      <Button
        size="sm"
        variant="danger"
        disabled={pending}
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      >
        Cancel subscription
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Cancel subscription"
        description="Pact will stop all further charges for this subscription."
        footer={
          <>
            <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
              Keep subscription
            </Button>
            <Button
              variant="danger"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const result = await cancelMerchantSubscription(id);
                  if (!result.ok) {
                    setError(result.error.message);
                    return;
                  }
                  setOpen(false);
                  router.refresh();
                })
              }
            >
              {pending ? 'Cancelling…' : 'Cancel subscription'}
            </Button>
          </>
        }
      >
        <Notice>
          Cancellation takes effect immediately. The customer’s onchain mandate remains, but Pact will no
          longer charge it.
        </Notice>
        {error && <Notice tone="danger">{error}</Notice>}
      </Dialog>
    </>
  );
}
