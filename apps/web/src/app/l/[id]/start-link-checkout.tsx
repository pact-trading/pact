'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
import { validateCheckoutAnswers, type CheckoutAnswer, type CheckoutField } from '@pactagent/core/checkout-fields';
import { CheckoutFieldInputs } from '@/components/customer/checkout-field-inputs';
import { CheckoutPanel } from '@/components/customer/checkout/panel';
import type { CheckoutBack } from '@/components/customer/checkout-layout';
import { AmountInput, Field, Input } from '@/components/ui/field';
import { cn } from '@/lib/cn';
import { fromMinor, toMinor, usd } from '@/lib/format';
import { startLinkCheckout } from '@/server/actions/commerce';

const AMOUNT = /^\d*(\.\d{0,6})?$/;
const parse = (value: string) => {
  try {
    return value ? toMinor(value) : 0n;
  } catch {
    return 0n;
  }
};

/**
 * The contact step for a payment link. A fixed link continues straight to checkout; a link where
 * the payer chooses asks for the amount first. Either way the server sets the charge, and
 * continuing only opens the checkout: it never pays.
 */
export function StartLinkCheckout({
  linkId,
  amountMinor,
  minimumMinor,
  maximumMinor,
  suggestionsMinor,
  payer,
  before,
  back,
  initialDiscountCode = '',
  checkoutFields = [],
}: {
  linkId: string;
  /** The fixed price, or null when the payer chooses. */
  amountMinor: string | null;
  minimumMinor: string;
  maximumMinor: string;
  suggestionsMinor: string[];
  payer: string;
  before?: ReactNode;
  back?: CheckoutBack;
  initialDiscountCode?: string;
  checkoutFields?: CheckoutField[];
}) {
  const router = useRouter();
  const [amount, setAmount] = useState('');
  const [tried, setTried] = useState(false);
  const [amountError, setAmountError] = useState('');
  const [error, setError] = useState('');
  const [discountCode, setDiscountCode] = useState(initialDiscountCode);
  const [answers, setAnswers] = useState<Record<string, CheckoutAnswer>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const fixed = amountMinor !== null;
  const minor = fixed ? BigInt(amountMinor) : parse(amount);
  const local = fixed
    ? ''
    : !amount || minor <= 0n
      ? 'Enter the amount you want to pay.'
      : minor < BigInt(minimumMinor)
        ? `The smallest amount is ${usd(minimumMinor)}.`
        : minor > BigInt(maximumMinor)
          ? `The most you can pay here is ${usd(maximumMinor)}.`
          : '';
  const shownError = amountError || (tried || amount ? local : '');
  const total = minor > 0n ? usd(minor) : undefined;

  const amountField = !fixed && (
    <div className="grid gap-3">
      <Field
        label="Amount"
        hint={`From ${usd(minimumMinor)} to ${usd(maximumMinor)}. No fees are added.`}
        error={shownError || undefined}
      >
        {id => (
          <AmountInput
            id={id}
            value={amount}
            placeholder="20"
            aria-invalid={Boolean(shownError) || undefined}
            onChange={e => {
              if (!AMOUNT.test(e.target.value)) return;
              setAmount(e.target.value);
              setAmountError('');
            }}
          />
        )}
      </Field>
      {suggestionsMinor.length > 0 && (
        <div role="group" aria-label="Suggested amounts" className="flex flex-wrap gap-2">
          {suggestionsMinor.map(value => {
            const on = minor === BigInt(value);
            return (
              <button
                key={value}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  setAmount(fromMinor(value));
                  setAmountError('');
                }}
                className={cn(
                  'h-9 rounded-full border px-3.5 text-sm font-medium tabular-nums transition-colors',
                  on
                    ? 'border-foreground bg-foreground text-background'
                    : 'border-border bg-card hover:bg-raised',
                )}
              >
                {usd(value)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <CheckoutPanel
      step="information"
      email={payer}
      contactLead="Signed in. Your receipt goes to this account."
      before={<div className="grid gap-4">{before}{amountField}<CheckoutFieldInputs fields={checkoutFields} answers={answers} errors={fieldErrors} onChange={(key, value) => setAnswers(current => ({ ...current, [key]: value }))} /><Field label="Discount code" hint="The price is calculated before you pay.">{id => <Input id={id} value={discountCode} onChange={event => setDiscountCode(event.target.value)} autoComplete="off" />}</Field></div>}
      payToday={total}
      action={{
        label: total ? `Continue · ${total}` : 'Continue',
        busy: pending,
        busyLabel: 'Opening checkout…',
      }}
      onSubmit={() =>
        start(async () => {
          setTried(true);
          setError('');
          const checked = validateCheckoutAnswers(checkoutFields, answers);
          setFieldErrors(checked.errors);
          if (local || !checked.valid) return;
          const result = await startLinkCheckout(linkId, fixed ? undefined : amount, discountCode, checked.metadata);
          if (!result.ok) {
            if (result.error.code === 'invalid_amount') return setAmountError(result.error.message);
            return setError(result.error.message);
          }
          router.push(`/checkout/${result.data.sessionId}`);
        })
      }
      error={error}
      note="You choose how to pay on the next step. Nothing is charged until you confirm."
      back={back}
    />
  );
}
