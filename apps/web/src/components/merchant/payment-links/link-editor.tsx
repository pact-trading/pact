'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { createPaymentLink } from '@/server/actions/commerce';
import { toMinor, usd } from '@/lib/format';
import { CheckoutFieldsEditor, toCheckoutFields, type CheckoutFieldRow } from '../checkout-fields-editor';
import { RadioCards } from '../../portal/radio-cards';
import { Button } from '../../ui/button';
import { Card, CardBody, CardHeader } from '../../ui/card';
import { AmountInput, Field, Input, Textarea } from '../../ui/field';
import { Notice } from '../../ui/notice';
import { useToast } from '../../ui/toast';

type Kind = 'product' | 'tip';
type FieldKey = 'name' | 'amount' | 'description' | 'expiry';

const AMOUNT = /^\d*(\.\d{0,6})?$/;
/** Server error codes that belong to one field, so the message shows under it. */
const fieldFor: Record<string, FieldKey> = {
  invalid_name: 'name',
  invalid_amount: 'amount',
  invalid_description: 'description',
  invalid_expiry: 'expiry',
};

const parse = (value: string) => {
  try {
    return toMinor(value || '0');
  } catch {
    return 0n;
  }
};

/**
 * The payment link form. Description, single use and expiry are kept by the demo store only, so
 * `extras` is false in API mode and those fields are not offered.
 */
export function LinkEditor({
  brandName,
  today,
  extras,
}: {
  brandName: string;
  /** The first day an expiry can be, `YYYY-MM-DD` on the demo clock. */
  today: string;
  extras: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [kind, setKind] = useState<Kind>('product');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [singleUse, setSingleUse] = useState(false);
  const [expiresOn, setExpiresOn] = useState('');
  const [checkoutFields, setCheckoutFields] = useState<CheckoutFieldRow[]>([]);
  const [tried, setTried] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [error, setError] = useState('');
  const [pending, start] = useTransition();

  const minor = parse(amount);
  const local: Partial<Record<FieldKey, string>> = {
    name: !name.trim()
      ? 'Give the link a name your customer will recognise.'
      : name.trim().length > 200
        ? 'Keep the name under 200 characters.'
        : undefined,
    amount: kind === 'product' && minor <= 0n ? 'Enter an amount above $0.' : undefined,
    description: description.length > 500 ? 'Keep the description under 500 characters.' : undefined,
    expiry: expiresOn && expiresOn < today ? 'Choose a date from today on.' : undefined,
  };
  const errorFor = (key: FieldKey) => serverErrors[key] ?? (tried ? local[key] : undefined);
  const invalid = Object.values(local).some(Boolean);
  const edit = (key: FieldKey) => setServerErrors(current => ({ ...current, [key]: undefined }));

  const save = () =>
    start(async () => {
      setTried(true);
      setError('');
      setServerErrors({});
      if (invalid) return;
      const result = await createPaymentLink({
        kind,
        name: name.trim(),
        ...(kind === 'product' ? { amountMinor: minor.toString() } : {}),
        checkoutFields: toCheckoutFields(checkoutFields),
        ...(extras ? { description: description.trim(), singleUse, expiresOn: expiresOn || null } : {}),
      });
      if (!result.ok) {
        const key = fieldFor[result.error.code];
        if (key) return setServerErrors({ [key]: result.error.message });
        return setError(result.error.message);
      }
      toast(`${result.data.name} is ready to share`);
      router.push(`/dashboard/payment-links/${result.data.id}?created=1`);
    });

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader
          title="Link details"
          description="Payers open the link, sign in with email or a passkey, and pay."
        />
        <CardBody>
          <form
            className="grid gap-5"
            noValidate
            onSubmit={event => {
              event.preventDefault();
              save();
            }}
          >
            <RadioCards
              legend="Pricing"
              value={kind}
              onChange={value => {
                setKind(value);
                edit('amount');
              }}
              options={[
                { value: 'product', title: 'Fixed amount', body: 'Everyone pays the same price.' },
                {
                  value: 'tip',
                  title: 'Customer chooses',
                  body: 'For tips and donations. The payer types the amount.',
                },
              ]}
            />
            <Field label="Name" hint="Shown to the payer and on their receipt." error={errorFor('name')}>
              {id => (
                <Input
                  id={id}
                  value={name}
                  maxLength={240}
                  onChange={e => {
                    setName(e.target.value);
                    edit('name');
                  }}
                  placeholder="Workshop deposit"
                  aria-invalid={Boolean(errorFor('name')) || undefined}
                />
              )}
            </Field>
            {kind === 'product' && (
              <Field label="Price" hint="In US dollars, settled as USDT." error={errorFor('amount')}>
                {id => (
                  <AmountInput
                    id={id}
                    value={amount}
                    onChange={e => {
                      if (!AMOUNT.test(e.target.value)) return;
                      setAmount(e.target.value);
                      edit('amount');
                    }}
                    placeholder="250"
                    aria-invalid={Boolean(errorFor('amount')) || undefined}
                  />
                )}
              </Field>
            )}
            {extras && (
              <>
                <Field
                  label="Description"
                  hint="Optional. Shown under the name on the pay page."
                  error={errorFor('description')}
                >
                  {id => (
                    <Textarea
                      id={id}
                      value={description}
                      onChange={e => {
                        setDescription(e.target.value);
                        edit('description');
                      }}
                      placeholder="Reserves your slot. The deposit comes off the final invoice."
                      aria-invalid={Boolean(errorFor('description')) || undefined}
                    />
                  )}
                </Field>
                <div className="grid gap-5 sm:grid-cols-2 sm:items-start">
                  <Field
                    label="Expires on"
                    hint="Optional. The link stops at the end of this day (UTC)."
                    error={errorFor('expiry')}
                  >
                    {id => (
                      <Input
                        id={id}
                        type="date"
                        min={today}
                        value={expiresOn}
                        onChange={e => {
                          setExpiresOn(e.target.value);
                          edit('expiry');
                        }}
                        aria-invalid={Boolean(errorFor('expiry')) || undefined}
                      />
                    )}
                  </Field>
                  <label className="flex items-start gap-3 pt-1 text-sm sm:pt-7">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 accent-[var(--pact-ink)]"
                      checked={singleUse}
                      onChange={e => setSingleUse(e.target.checked)}
                    />
                    <span>
                      <span className="font-medium">Single use</span>
                      <span className="block text-muted-foreground">
                        Stops taking payments after the first one.
                      </span>
                    </span>
                  </label>
                </div>
              </>
            )}
            <CheckoutFieldsEditor rows={checkoutFields} onChange={setCheckoutFields} />
            {error && <Notice tone="danger">{error}</Notice>}
            {tried && invalid && !error && <Notice tone="danger">Fix the highlighted details first.</Notice>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="dark" disabled={pending}>
                {pending ? 'Creating…' : 'Create link'}
              </Button>
              <Button asChild variant="ghost">
                <Link href="/dashboard/payment-links">Cancel</Link>
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card className="content-start self-start">
        <CardHeader title="Preview" description="What the payer sees. Nothing is saved yet." />
        <CardBody className="grid gap-3">
          <p className="text-sm text-muted-foreground">{brandName}</p>
          <p className="text-lg font-semibold [overflow-wrap:anywhere]">{name.trim() || 'Link name'}</p>
          <p className="text-3xl font-semibold tracking-tight tabular-nums">
            {kind === 'tip' ? 'You choose' : usd(minor)}
          </p>
          {extras && description.trim() && (
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{description.trim()}</p>
          )}
          {extras && (singleUse || expiresOn) && (
            <p className="text-[13px] text-muted-foreground">
              {[singleUse && 'One payment only', expiresOn && `Open until ${expiresOn}`]
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
          <Button variant="primary" disabled className="mt-1 w-full">
            Pay
          </Button>
          {!extras && (
            <p className="text-[13px] text-muted-foreground">
              Descriptions, single-use links and expiry dates are not stored by the API yet.
            </p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
