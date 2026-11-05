'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { CheckoutPanel } from '@/components/customer/checkout/panel';
import type { CheckoutBack } from '@/components/customer/checkout-layout';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { startOrderCheckout } from '@/server/actions/commerce';

/** Opens (or resumes) the checkout for an order the business created. Continuing never pays. */
export function StartOrderCheckout({
  orderId,
  amount,
  payer,
  confirming = false,
  back,
}: {
  orderId: string;
  /** The order total, formatted by the server. */
  amount: string;
  payer: string;
  /** A payment is already under way; continuing shows its status instead of starting another. */
  confirming?: boolean;
  back?: CheckoutBack;
}) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const open = () =>
    start(async () => {
      setError('');
      const result = await startOrderCheckout(orderId);
      if (!result.ok) return setError(result.error.message);
      router.push(`/checkout/${result.data.sessionId}`);
    });
  if (confirming)
    return (
      <CheckoutPanel
        step="processing"
        title="Your payment is confirming"
        hint="It usually takes a few seconds. You can follow it on the payment page."
        action={
          <div className="grid w-full gap-3">
            {error && <Notice tone="danger">{error}</Notice>}
            <Button variant="dark" onClick={open} disabled={pending} className="justify-self-center">
              {pending ? 'Opening…' : 'View payment status'}
            </Button>
          </div>
        }
      />
    );
  return (
    <CheckoutPanel
      step="information"
      email={payer}
      contactLead="Signed in. Your receipt goes to this account."
      payToday={amount}
      action={{ label: `Continue · ${amount}`, busy: pending, busyLabel: 'Opening checkout…' }}
      onSubmit={open}
      error={error}
      note="You choose how to pay on the next step. Nothing is charged until you confirm."
      back={back}
    />
  );
}
