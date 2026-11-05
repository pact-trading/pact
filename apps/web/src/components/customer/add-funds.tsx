'use client';

import { IconCoin } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { claimTestFunds } from '@/server/actions/customer';
import { usd } from '@/lib/format';
import { Button } from '../ui/button';
import { Notice } from '../ui/notice';
import { useToast } from '../ui/toast';

/** Testnet stand-in for "top up from an exchange or card": adds $1,000 of test USDT. */
export function AddFunds({
  balanceMinor,
  neededMinor,
  onAdded,
}: {
  balanceMinor: string;
  neededMinor?: string;
  onAdded?: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  return (
    <div className="grid gap-3 rounded-2xl border border-warning/30 bg-warning-soft p-4">
      <div>
        <p className="font-semibold">Add funds to continue</p>
        <p className="text-sm text-subtle-foreground">
          Your balance is {usd(balanceMinor)}
          {neededMinor ? `; this payment needs ${usd(neededMinor)}` : ''}. On mainnet you would top up from an
          exchange or a card.
        </p>
      </div>
      <Button
        variant="dark"
        className="justify-self-start"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError('');
            const result = await claimTestFunds();
            if (!result.ok) return setError(result.error.message);
            toast(`Balance is now ${usd(result.data.balanceMinor)}`);
            onAdded?.();
            router.refresh();
          })
        }
      >
        <IconCoin className="size-4.5" />
        {pending ? 'Adding…' : 'Get $1,000 of test USDT'}
      </Button>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}
