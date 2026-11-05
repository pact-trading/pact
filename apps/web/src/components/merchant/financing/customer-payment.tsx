'use client';

import { IconFlask } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { simulateCustomerPayment } from '@/server/actions/financing';
import { usd } from '@/lib/format';
import { Button } from '../../ui/button';
import { Notice } from '../../ui/notice';
import { useToast } from '../../ui/toast';

/**
 * Demo control (mock data only): the invoice's customer pays the remaining balance through the
 * normal invoice flow, from their own balance. The contract routes it to the claim's holders.
 */
export function CustomerPayment({
  invoiceId,
  debtor,
  amountMinor,
  holders,
}: {
  invoiceId: string;
  debtor: string;
  amountMinor: string;
  /** Who the payment goes to, for the copy: "Lotus Capital and Harbor Street Partners". */
  holders: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  return (
    <div className="grid gap-3 rounded-xl border border-dashed border-border p-4">
      <p className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
        <IconFlask className="size-4" />
        Demo control
      </p>
      <p className="text-sm text-subtle-foreground">
        Make {debtor} pay the invoice from their own balance, as they would from the payment link. The
        contract sends it straight to {holders}.
      </p>
      <Button
        size="sm"
        className="justify-self-start"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError('');
            const result = await simulateCustomerPayment(invoiceId);
            if (!result.ok) {
              setError(result.error.message);
              router.refresh();
              return;
            }
            toast(`${debtor} paid ${usd(amountMinor)}; routed to ${holders}`);
            router.refresh();
          })
        }
      >
        {pending ? 'Paying…' : `Simulate ${debtor} paying ${usd(amountMinor)}`}
      </Button>
      {error && (
        <Notice tone="danger" title="Not paid">
          {error}
        </Notice>
      )}
    </div>
  );
}
