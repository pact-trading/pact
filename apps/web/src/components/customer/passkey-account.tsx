'use client';

import { IconFingerprint } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { createPasskey, PasskeyCancelled, passkeysSupported } from '@/lib/passkey';
import { usd } from '@/lib/format';
import { fundPasskeyAccount, passkeyRegistration, registerPasskey } from '@/server/actions/customer';
import type { PasskeyAccountView } from '@/server/data/types';
import { Button } from '../ui/button';
import { Card, CardBody, CardHeader } from '../ui/card';
import { CopyButton } from '../ui/copy-button';
import { Notice } from '../ui/notice';

/**
 * A passkey account: a smart account the customer's passkey (Face ID, Touch ID, a security key) controls,
 * holding USDT. Each payment is one passkey confirmation; Pact's relayer pays the gas and deploys the
 * account with the first payment. Whitechain checks the P-256 signature natively.
 */
export function PasskeyAccountCard({
  initial,
  local,
}: {
  initial: PasskeyAccountView | null;
  local: boolean;
}) {
  const router = useRouter();
  const [account, setAccount] = useState(initial);
  const [error, setError] = useState('');
  const [supported, setSupported] = useState(true);
  const [pending, start] = useTransition();
  useEffect(() => setSupported(passkeysSupported()), []);

  const create = () =>
    start(async () => {
      setError('');
      const options = await passkeyRegistration();
      if (!options.ok) return setError(options.error.message);
      try {
        const registration = await createPasskey(options.data);
        const created = await registerPasskey(registration);
        if (!created.ok) return setError(created.error.message);
        setAccount(created.data);
        router.refresh();
      } catch (e) {
        if (!(e instanceof PasskeyCancelled))
          setError(e instanceof Error ? e.message : 'The passkey was not created.');
      }
    });
  const fund = () =>
    start(async () => {
      setError('');
      const funded = await fundPasskeyAccount();
      if (!funded.ok) return setError(funded.error.message);
      setAccount(funded.data);
    });

  return (
    <Card>
      <CardHeader title="Passkey account" />
      <CardBody className="grid gap-4">
        {account ? (
          <>
            <p className="text-4xl font-semibold tracking-tight">
              {account.balanceMinor !== null ? usd(account.balanceMinor) : '—'}
            </p>
            <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
              <IconFingerprint className="mt-0.5 size-4 shrink-0" />
              Pay at checkout with Face ID, Touch ID or your security key.{' '}
              {account.deployed ? '' : 'Pact sets the account up with your first payment, at no cost to you.'}
            </p>
            <div className="flex flex-wrap items-center gap-2 font-mono text-[13px]">
              {account.account}
              <CopyButton value={account.account} label="Copy address" />
            </div>
            {local && (
              <Button variant="dark" className="justify-self-start" disabled={pending} onClick={fund}>
                {pending ? 'Adding…' : 'Give 25 test USDT'}
              </Button>
            )}
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Create an account that only your passkey can spend from. No seed phrase and no wallet app: each
              payment is one Face ID or Touch ID confirmation.
            </p>
            {supported ? (
              <Button variant="dark" className="justify-self-start" disabled={pending} onClick={create}>
                <IconFingerprint aria-hidden className="size-5" />
                {pending ? 'Waiting for your passkey…' : 'Create a passkey account'}
              </Button>
            ) : (
              <Notice tone="warning">
                This browser cannot create passkeys. Try a current Chrome, Safari or Firefox.
              </Notice>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
