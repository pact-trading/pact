'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { createPlan } from '@/server/actions/merchant';
import { period as periodName, toMinor, usd } from '@/lib/format';
import { usePactAuth } from '@/components/auth/auth-context';
import { Button } from '../../ui/button';
import { Card, CardBody, CardHeader } from '../../ui/card';
import { AmountInput, Field, Input, Select, Textarea } from '../../ui/field';
import { Notice } from '../../ui/notice';
import { useToast } from '../../ui/toast';

type FieldKey = 'name' | 'amount' | 'period' | 'max' | 'trial';
const AMOUNT = /^\d*(\.\d{0,6})?$/;
const fieldFor: Record<string, FieldKey> = {
  invalid_name: 'name',
  invalid_amount: 'amount',
  invalid_period: 'period',
  invalid_trial_days: 'trial',
};
const parse = (value: string) => {
  try {
    return toMinor(value || '0');
  } catch {
    return 0n;
  }
};

/** The full-page plan form. Creates the plan through the same action as the subscriptions dialog. */
export function PlanForm({ brandName }: { brandName: string }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [seconds, setSeconds] = useState(String(30 * 86_400));
  // Live mode: short test periods, because chain time cannot be moved forward.
  const live = Boolean(usePactAuth().live);
  const [trialDays, setTrialDays] = useState('0');
  const [max, setMax] = useState('12');
  const [tried, setTried] = useState(false);
  const [serverErrors, setServerErrors] = useState<Partial<Record<FieldKey, string>>>({});
  const [error, setError] = useState('');
  const [pending, start] = useTransition();

  const minor = parse(amount);
  const periods = max ? Number(max) : null;
  const local: Partial<Record<FieldKey, string>> = {
    trial: Number.isInteger(Number(trialDays)) && Number(trialDays) >= 0 && Number(trialDays) <= 365 ? undefined : 'Use 0 to 365 days.',
    name: name.trim() ? undefined : 'Give the plan a name.',
    amount: minor > 0n ? undefined : 'Enter a price above $0.',
    max: periods !== null && periods < 1 ? 'Use at least 1, or leave it blank for no limit.' : undefined,
  };
  const invalid = Object.values(local).some(Boolean);
  const errorFor = (key: FieldKey) => serverErrors[key] ?? (tried ? local[key] : undefined);
  const edit = (key: FieldKey) => setServerErrors(current => ({ ...current, [key]: undefined }));
  const every = periodName(Number(seconds));

  const save = () =>
    start(async () => {
      setTried(true);
      setError('');
      setServerErrors({});
      if (invalid) return;
      const result = await createPlan({
        name: name.trim(),
        description: description.trim(),
        amount: amount || '0',
        periodSeconds: Number(seconds),
        maxPeriods: periods ?? undefined,
        trialDays: Number(trialDays),
      });
      if (!result.ok) {
        const key = fieldFor[result.error.code];
        if (key) return setServerErrors({ [key]: result.error.message });
        return setError(result.error.message);
      }
      toast(`${result.data.name} created`);
      router.push('/dashboard/plans');
    });

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader
          title="Plan"
          description="Subscribers sign one mandate with these terms. The contract refuses any pull above the price or before the period ends."
        />
        <CardBody>
          <form
            noValidate
            className="grid gap-5"
            onSubmit={event => {
              event.preventDefault();
              save();
            }}
          >
            <Field label="Name" error={errorFor('name')}>
              {id => (
                <Input
                  id={id}
                  value={name}
                  onChange={e => {
                    setName(e.target.value);
                    edit('name');
                  }}
                  placeholder="API Growth"
                  aria-invalid={Boolean(errorFor('name')) || undefined}
                />
              )}
            </Field>
            <Field label="What’s included" hint="Optional. Shown on the subscribe page.">
              {id => (
                <Textarea
                  id={id}
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="50,000 API calls a month, email support"
                />
              )}
            </Field>
            <div className="grid gap-5 sm:grid-cols-3 sm:items-start">
              <Field label="Price per period" error={errorFor('amount')}>
                {id => (
                  <AmountInput
                    id={id}
                    value={amount}
                    onChange={e => {
                      if (!AMOUNT.test(e.target.value)) return;
                      setAmount(e.target.value);
                      edit('amount');
                    }}
                    placeholder="49"
                    aria-invalid={Boolean(errorFor('amount')) || undefined}
                  />
                )}
              </Field>
              <Field label="Billing period" error={errorFor('period')}>
                {id => (
                  <Select id={id} value={seconds} onChange={e => setSeconds(e.target.value)}>
                    {live && <option value="120">Every 2 minutes (test)</option>}
                    {live && <option value="600">Every 10 minutes (test)</option>}
                    <option value={String(7 * 86_400)}>Weekly</option>
                    <option value={String(30 * 86_400)}>Monthly</option>
                    <option value={String(365 * 86_400)}>Yearly</option>
                  </Select>
                )}
              </Field>
              <Field label="Max periods" hint="Blank for no limit" error={errorFor('max')}>
                {id => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    value={max}
                    onChange={e => /^\d{0,3}$/.test(e.target.value) && setMax(e.target.value)}
                    aria-invalid={Boolean(errorFor('max')) || undefined}
                  />
                )}
              </Field>
            </div>
            <Field label="Free trial (days)" hint="0 or blank means no trial. First charge is due when the trial ends." error={errorFor('trial')}>
              {id => <Input id={id} type="number" min={0} max={365} step={1} value={trialDays} onChange={e => { setTrialDays(e.target.value); edit('trial'); }} aria-invalid={Boolean(errorFor('trial')) || undefined} />}
            </Field>
            {error && <Notice tone="danger">{error}</Notice>}
            {tried && invalid && !error && <Notice tone="danger">Fix the highlighted details first.</Notice>}
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="dark" disabled={pending}>
                {pending ? 'Creating…' : 'Create plan'}
              </Button>
              <Button asChild variant="ghost">
                <Link href="/dashboard/plans">Cancel</Link>
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card className="self-start">
        <CardHeader title="Preview" description="The subscribe page. Nothing is saved yet." />
        <CardBody className="grid gap-3">
          <p className="text-sm text-muted-foreground">{brandName}</p>
          <p className="text-lg font-semibold [overflow-wrap:anywhere]">{name.trim() || 'Plan name'}</p>
          <p className="text-3xl font-semibold tracking-tight tabular-nums">
            {usd(minor)}
            <span className="text-base font-normal text-muted-foreground"> / {every}</span>
          </p>
          {Number(trialDays) > 0 && <p className="text-sm">Free for {trialDays} days, then {usd(minor)} per {every}.</p>}
          {description.trim() && (
            <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">{description.trim()}</p>
          )}
          <p className="text-[13px] text-muted-foreground">
            {periods
              ? `Up to ${periods} payments, at most ${usd(minor * BigInt(periods))} in total.`
              : 'Renews until cancelled.'}{' '}
            Cancel any time with one signature.
          </p>
          <Button variant="primary" disabled className="mt-1 w-full">
            Subscribe
          </Button>
        </CardBody>
      </Card>
    </div>
  );
}
