'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
import { validateCheckoutAnswers, type CheckoutAnswer, type CheckoutField } from '@pactagent/core/checkout-fields';
import { startInvoiceCheckout, startProductCheckout } from '@/server/actions/customer';
import { fromMinor, toMinor, usd } from '@/lib/format';
import { AmountInput, Field, Input } from '../ui/field';
import { CheckoutFieldInputs } from './checkout-field-inputs';
import { CheckoutPanel } from './checkout/panel';
import type { CheckoutBack } from './checkout/frame';

/**
 * The contact step for a product. Continuing only opens the checkout session, where the payer
 * chooses how to pay; it never pays.
 */
export function StartProductCheckout({
  productId,
  amount,
  payer,
  back,
  initialDiscountCode = '',
  checkoutFields = [],
}: {
  productId: string;
  amount: string;
  payer: string;
  back?: CheckoutBack;
  initialDiscountCode?: string;
  checkoutFields?: CheckoutField[];
}) {
  const router = useRouter();
  const [error, setError] = useState('');
  const [discountCode, setDiscountCode] = useState(initialDiscountCode);
  const [answers, setAnswers] = useState<Record<string, CheckoutAnswer>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  return (
    <CheckoutPanel
      step="information"
      email={payer}
      contactLead="Signed in. Your receipt goes to this account."
      before={
        <div className="grid gap-4">
          <CheckoutFieldInputs fields={checkoutFields} answers={answers} errors={fieldErrors} onChange={(key, value) => setAnswers(current => ({ ...current, [key]: value }))} />
          <Field label="Discount code" hint="The final price is calculated before you pay.">{id => <Input id={id} value={discountCode} onChange={event => setDiscountCode(event.target.value)} autoComplete="off" />}</Field>
        </div>
      }
      payToday={amount}
      action={{ label: `Continue · ${amount}`, busy: pending, busyLabel: 'Opening checkout…' }}
      onSubmit={() =>
        start(async () => {
          setError('');
          const checked = validateCheckoutAnswers(checkoutFields, answers);
          setFieldErrors(checked.errors);
          if (!checked.valid) return;
          const result = await startProductCheckout(productId, discountCode, checked.metadata);
          if (!result.ok) return setError(result.error.message);
          router.push(`/checkout/${result.data.sessionId}`);
        })
      }
      error={error}
      note="You choose how to pay on the next step. Nothing is charged until you confirm."
      back={back}
    />
  );
}

/** The contact step for an invoice, with an amount field when partial payments are allowed. */
export function StartInvoiceCheckout({
  invoiceId,
  remainingMinor,
  allowPartial,
  disabled,
  email,
  before,
  back,
}: {
  invoiceId: string;
  remainingMinor: string;
  allowPartial: boolean;
  disabled?: boolean;
  email: string;
  /** Above the amount, e.g. the acknowledgement step. */
  before?: ReactNode;
  back?: CheckoutBack;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState(fromMinor(remainingMinor));
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const minor = (() => {
    try {
      return toMinor(amount || '0');
    } catch {
      return 0n;
    }
  })();
  const tooMuch = minor > BigInt(remainingMinor);
  return (
    <CheckoutPanel
      step="information"
      email={email}
      before={
        <div className="grid gap-4">
          {before}
          {allowPartial && (
            <Field
              label="Amount to pay"
              error={tooMuch ? `At most ${usd(remainingMinor)} is due.` : undefined}
              hint={`Up to ${usd(remainingMinor)}. You can pay the rest later.`}
            >
              {id => (
                <AmountInput
                  id={id}
                  value={amount}
                  aria-invalid={tooMuch || undefined}
                  onChange={e => /^\d*(\.\d{0,6})?$/.test(e.target.value) && setAmount(e.target.value)}
                />
              )}
            </Field>
          )}
        </div>
      }
      payToday={usd(minor)}
      action={{
        label: `Pay ${usd(minor)}`,
        disabled: disabled || minor <= 0n || tooMuch,
        busy: pending,
        busyLabel: 'Opening checkout…',
      }}
      onSubmit={() =>
        start(async () => {
          setError('');
          const result = await startInvoiceCheckout(invoiceId, minor.toString());
          if (!result.ok) return setError(result.error.message);
          router.push(`/checkout/${result.data.sessionId}`);
        })
      }
      error={error}
      note="You choose how to pay on the next step. Nothing is charged until you confirm."
      back={back}
    />
  );
}
