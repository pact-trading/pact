'use client';

import { IconLoader2, IconShoppingBag } from '@tabler/icons-react';
import { useState, useTransition } from 'react';
import { buyFromStore } from '@/server/actions/lab';
import { Button } from '../ui/button';

/** The store's server creates the order and sends the shopper to Pact's checkout. */
export function BuyButton({ productId, name }: { productId: string; name: string }) {
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  return (
    <div className="grid gap-2">
      <Button
        variant="primary"
        className="w-full"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError('');
            const result = await buyFromStore(productId);
            if (result && !result.ok) setError(result.error.message);
          })
        }
      >
        {pending ? (
          <IconLoader2 className="size-4.5 animate-spin" />
        ) : (
          <IconShoppingBag className="size-4.5" />
        )}
        Buy {name}
      </Button>
      {error && (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
