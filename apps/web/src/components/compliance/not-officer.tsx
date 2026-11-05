'use client';

import { IconFlask, IconShieldLock } from '@tabler/icons-react';
import { useState, useTransition } from 'react';
import { usePactAuth } from '../auth/auth-context';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { EmptyState } from '../ui/empty-state';
import { Notice } from '../ui/notice';

/**
 * Shown to a compliance wallet the investor registry does not list as an officer. The registry owner
 * appoints officers; on a local fork the test faucet can appoint this wallet.
 */
export function NotOfficer() {
  const auth = usePactAuth();
  const [pending, start] = useTransition();
  const [error, setError] = useState('');
  const address = auth.live?.compliance?.address;
  return (
    <Card>
      <EmptyState
        icon={<IconShieldLock />}
        title="This wallet is not a compliance officer"
        action={
          auth.live?.config.localFork ? (
            <Button
              size="sm"
              variant="dark"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  setError('');
                  const response = await fetch('/api/dev/compliance-officer', { method: 'POST' });
                  // A full load: the whole page changes from this notice to the registry.
                  if (response.ok) window.location.assign('/compliance');
                  else setError('The local fork could not appoint this wallet.');
                })
              }
            >
              <IconFlask className="size-4" /> {pending ? 'Appointing…' : 'Appoint it on this local fork'}
            </Button>
          ) : undefined
        }
      >
        {address ? `${address.slice(0, 6)}…${address.slice(-4)} ` : 'This wallet '}
        is not listed as an officer in the investor registry, so it cannot see applications or approve
        investors. The registry owner appoints officers with <code>setOfficer</code>.
        {error && (
          <Notice tone="danger" className="mt-3">
            {error}
          </Notice>
        )}
      </EmptyState>
    </Card>
  );
}
