'use client';

import { IconSignature } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
import {
  prepareAcknowledge,
  prepareSubscribe,
  submitAcknowledge,
  submitSubscribe,
} from '@/server/actions/customer';
import { usd } from '@/lib/format';
import { useSignedAction } from '../auth/use-signed-action';
import { Button } from '../ui/button';
import { Notice } from '../ui/notice';
import { useToast } from '../ui/toast';
import { AddFunds } from './add-funds';
import type { CheckoutBack } from './checkout/frame';
import { AccountDetail } from './checkout/method-details';
import { CheckoutPanel } from './checkout/panel';

/** The subscription's payment card: the Pact account, the capped consent and one passkey signature. */
export function SubscribeCheckout({
  planId,
  trialDays = 0,
  email,
  label,
  brandName,
  balanceMinor,
  amountMinor,
  consent,
  payNote,
  back,
}: {
  planId: string;
  trialDays?: number;
  email: string;
  label: string;
  brandName: string;
  balanceMinor: string;
  amountMinor: string;
  /** What the payer approves: the cap, the period and how to cancel. */
  consent: ReactNode;
  payNote?: ReactNode;
  back?: CheckoutBack;
}) {
  const router = useRouter();
  const signed = useSignedAction();
  const [error, setError] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  if (done)
    return (
      <CheckoutPanel
        step="success"
        receipt={
          <Notice tone="success" title="You’re subscribed">
            {trialDays > 0 ? `Your ${trialDays}-day free trial has started. Nothing was charged today. ` : 'Your subscription is ready. '}
            Cancel anytime from your account; {brandName} cannot charge more than you approved.
          </Notice>
        }
        actions={
          <Button asChild variant="dark">
            <Link href={`/portal/subscriptions/${done}`}>Manage subscription</Link>
          </Button>
        }
      />
    );
  const short = BigInt(balanceMinor) < BigInt(amountMinor);
  return (
    <CheckoutPanel
      step="payment"
      email={email}
      methods={[
        {
          id: 'account',
          icon: 'account',
          title: 'Your Pact account',
          description: `Balance ${usd(balanceMinor)} · no fees`,
          detail: (
            <AccountDetail
              balance={usd(balanceMinor)}
              brandName={brandName}
              shortfall={
                short ? <AddFunds balanceMinor={balanceMinor} neededMinor={amountMinor} /> : undefined
              }
            />
          ),
        },
      ]}
      selected="account"
      before={consent}
      payToday={usd(amountMinor)}
      payNote={payNote}
      action={{
        label,
        icon: 'passkey',
        disabled: short,
        busy: pending,
        busyLabel: 'Waiting for your passkey…',
        onClick: () =>
          start(async () => {
            setError('');
            const result = await signed(
              () => prepareSubscribe(planId),
              (token, signature) => submitSubscribe(token, signature),
            );
            if (result.ok) {
              setDone(result.data.subscriptionId);
              router.refresh();
            } else if (result.error.code !== 'cancelled') setError(result.error.message);
          }),
      }}
      error={error}
      back={back}
    />
  );
}

export function AcknowledgeButton({ invoiceId, number }: { invoiceId: string; number: string }) {
  const router = useRouter();
  const toast = useToast();
  const signed = useSignedAction();
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  return (
    <div className="grid gap-2">
      <Button
        variant="dark"
        disabled={pending}
        className="justify-self-start"
        onClick={() =>
          start(async () => {
            setError('');
            const result = await signed(
              () => prepareAcknowledge(invoiceId),
              (token, signature) => submitAcknowledge(token, signature),
            );
            if (result.ok) {
              toast(`${number} acknowledged`);
              router.refresh();
            } else if (result.error.code !== 'cancelled') setError(result.error.message);
          })
        }
      >
        <IconSignature className="size-4.5" />
        {pending ? 'Waiting for your passkey…' : 'Acknowledge invoice'}
      </Button>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}
