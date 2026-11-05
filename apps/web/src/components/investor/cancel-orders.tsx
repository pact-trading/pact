'use client';

import { IconCircleX } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { prepareCancelOrders, submitCancelOrders } from '@/server/actions/financing';
import { useSignedAction } from '../auth/use-signed-action';
import { Button } from '../ui/button';
import { useToast } from '../ui/toast';

/**
 * Cancels the orders this wallet signed that did not go through (a purchase or transfer, or a
 * registry decision), so none can run later. One signature; Pact submits it.
 */
export function CancelOrders({ role }: { role: 'investor' | 'compliance' }) {
  const router = useRouter();
  const toast = useToast();
  const signed = useSignedAction();
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const what = role === 'investor' ? 'purchase or transfer' : 'decision';
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground">
      <span>Signed a {what} that did not go through? Cancel it so it can never run later.</span>
      <Button
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError('');
            const result = await signed(
              () => prepareCancelOrders(role),
              (token, signature) => submitCancelOrders(token, signature),
            );
            if (result.ok) {
              toast('Unsent signed orders cancelled');
              router.refresh();
            } else if (result.error.code !== 'cancelled') setError(result.error.message);
          })
        }
      >
        <IconCircleX className="size-4" />
        {pending ? 'Confirming…' : 'Cancel unsent orders'}
      </Button>
      {error && <p className="w-full text-destructive">{error}</p>}
    </div>
  );
}
