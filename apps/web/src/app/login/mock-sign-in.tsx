'use client';

import { IconArrowLeft, IconFingerprint, IconMail } from '@tabler/icons-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { RadioCards } from '@/components/portal/radio-cards';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { chooseViewer } from '@/server/actions/demo';

const EMAIL = /^\S+@\S+\.\S+$/;
/** The demo's one-time code. Privy sends a real one when the API is connected. */
const DEMO_CODE = '123456';
const MAX_ATTEMPTS = 5;

type Role = 'merchant' | 'customer';
const who: Record<Role, string> = {
  merchant: 'Maya Chen at Kite Labs',
  customer: 'Jordan Lee at Acme Robotics',
};

/**
 * Email-code sign-in as it works with Privy, simulated for the demo: any address gets the
 * code 123456, and you continue as the demo person for the side you picked.
 */
export function MockSignIn({ next }: { next?: string }) {
  const [role, setRole] = useState<Role>(next?.startsWith('/dashboard') ? 'merchant' : 'customer');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [pending, start] = useTransition();

  const enter = () =>
    start(async () => {
      await chooseViewer(role, next);
    });

  if (step === 'email')
    return (
      <form
        noValidate
        className="grid gap-4"
        onSubmit={event => {
          event.preventDefault();
          if (!EMAIL.test(email.trim())) return setError('Enter an email address like you@company.com.');
          setError('');
          setCode('');
          setAttempts(0);
          setInfo(`We sent a 6-digit code to ${email.trim()}.`);
          setStep('code');
        }}
      >
        <RadioCards
          legend="I am signing in as"
          value={role}
          onChange={setRole}
          options={[
            { value: 'merchant', title: 'A business', body: 'Run your workspace' },
            { value: 'customer', title: 'A customer', body: 'See what you bought' },
          ]}
        />
        <Field label="Email address" error={error || undefined}>
          {id => (
            <Input
              id={id}
              type="email"
              autoComplete="email"
              value={email}
              placeholder="you@company.com"
              aria-invalid={Boolean(error)}
              onChange={e => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="dark" size="lg" disabled={pending}>
          <IconMail className="size-4.5" />
          Send sign-in code
        </Button>
        <Button size="lg" disabled={pending} onClick={enter}>
          <IconFingerprint className="size-4.5" />
          {pending ? 'Signing in…' : 'Continue with passkey'}
        </Button>
        <p className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          <Badge tone="outline">Demo</Badge>
          You continue as {who[role]}.
        </p>
      </form>
    );

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={event => {
        event.preventDefault();
        setInfo('');
        if (attempts >= MAX_ATTEMPTS) return setError('Too many tries. Send a new code.');
        if (!/^\d{6}$/.test(code)) return setError('Enter the 6 digits from the email.');
        if (code !== DEMO_CODE) {
          setAttempts(n => n + 1);
          return setError('That code is not right. In the demo it is 123456.');
        }
        setError('');
        enter();
      }}
    >
      <div>
        <h2 className="text-lg font-semibold">Check your email</h2>
        {info && <p className="mt-1 text-sm text-muted-foreground">{info}</p>}
      </div>
      <Field label="Sign-in code" hint="In the demo the code is 123456." error={error || undefined}>
        {id => (
          <Input
            id={id}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            autoFocus
            aria-invalid={Boolean(error)}
            className="font-mono tracking-[0.3em]"
            onChange={e => /^\d{0,6}$/.test(e.target.value) && setCode(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" variant="dark" size="lg" disabled={pending}>
        {pending ? 'Signing in…' : 'Verify and continue'}
      </Button>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setStep('email');
            setError('');
            setInfo('');
          }}
        >
          <IconArrowLeft className="size-4" />
          Use a different email
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setAttempts(0);
            setCode('');
            setError('');
            setInfo(`We sent a new code to ${email.trim()}.`);
          }}
        >
          Send a new code
        </Button>
      </div>
      {attempts >= MAX_ATTEMPTS && (
        <Notice tone="warning">This code is locked after {MAX_ATTEMPTS} wrong tries.</Notice>
      )}
    </form>
  );
}

export function DemoViewpointsLink() {
  return (
    <p className="text-sm text-muted-foreground">
      Or{' '}
      <Link href="/demo" className="font-medium text-foreground underline-offset-4 hover:underline">
        pick any demo viewpoint
      </Link>
      , including the accountant and the investor.
    </p>
  );
}
