'use client';

import { IconFingerprint } from '@tabler/icons-react';
import { useEffect, useRef, useState, useTransition } from 'react';
import { IconFlask } from '@tabler/icons-react';
import { chooseViewer } from '@/server/actions/demo';
import { usePactAuth } from '../auth/auth-context';
import { Button } from '../ui/button';
import { Notice } from '../ui/notice';
import { CheckoutPanel } from './checkout/panel';
import { radius, type CheckoutBack } from './checkout/frame';

/** Email or passkey sign-in, as the checkout's contact step. In mock mode it signs in as the demo customer. */
export function SignInCard({
  next,
  title = 'Pay with email or a passkey',
  mockEmail,
  payToday,
  back,
}: {
  next: string;
  title?: string;
  mockEmail?: string;
  /** The amount, when it is known before sign-in. */
  payToday?: string;
  back?: CheckoutBack;
}) {
  const auth = usePactAuth();
  const [email, setEmail] = useState(mockEmail ?? '');
  const [pending, start] = useTransition();
  const live = auth.live;
  const [error, setError] = useState('');
  const awaitingPrivy = useRef(false);
  // Privy finishes in its own modal; continue once the customer session reaches the server.
  useEffect(() => {
    if (awaitingPrivy.current && live?.customer) {
      awaitingPrivy.current = false;
      start(() => chooseViewer('customer', next));
    }
  }, [live?.customer, next]);
  const testCustomer = () =>
    start(async () => {
      setError('');
      try {
        await live!.signInCustomer('local', email.trim() || 'buyer@example.test');
        await chooseViewer('customer', next);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Sign-in failed.');
      }
    });
  const signIn = () => {
    if (auth.mode === 'mock') return start(() => chooseViewer('customer', next));
    if (live?.customer) return start(() => chooseViewer('customer', next));
    if (live && !live.config.privyConfigured) return testCustomer();
    awaitingPrivy.current = true;
    auth.login();
  };
  if (auth.mode === 'none')
    return (
      <Notice tone="warning" title="Sign-in is not set up">
        The business has not finished configuring checkout. Please try again later.
      </Notice>
    );
  return (
    <CheckoutPanel
      step="information"
      email={email}
      onEmailChange={setEmail}
      contactLead={title}
      payToday={payToday}
      action={{ label: 'Continue with email', busy: pending, busyLabel: 'Signing in…' }}
      onSubmit={signIn}
      secondary={
        <>
          {live?.config.localFork && live.config.privyConfigured ? (
            <Button size="lg" onClick={testCustomer} disabled={pending} className={`w-full ${radius.button}`}>
              <IconFlask aria-hidden className="size-4.5" />
              Use a test customer
            </Button>
          ) : (
            !live && (
              <Button size="lg" onClick={signIn} disabled={pending} className={`w-full ${radius.button}`}>
                <IconFingerprint aria-hidden className="size-4.5" />
                Use a passkey
              </Button>
            )
          )}
          {error && <Notice tone="danger">{error}</Notice>}
        </>
      }
      note="No wallet to install and nothing to pay in fees. Your receipt stays in your account."
      back={back}
    />
  );
}
