'use client';

import { IconPlayerPlay } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { runRenewal } from '@/server/actions/merchant';
import { humanize } from '@/lib/format';
import { Button } from '../../ui/button';
import { Notice } from '../../ui/notice';

/** Asks the keeper to pull a renewal now. Before the period ends, the contract refuses it. */
export function RenewalButton({ id, disabled }: { id: string; disabled?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ tone: 'success' | 'danger'; title: string; body: string } | null>(
    null,
  );
  return (
    <div className="grid gap-3">
      <Button
        className="justify-self-start"
        disabled={pending || disabled}
        onClick={() =>
          start(async () => {
            const response = await runRenewal(id);
            if (!response.ok)
              setResult({ tone: 'danger', title: 'Could not run', body: response.error.message });
            else if (response.data.refusal)
              setResult({
                tone: 'danger',
                title: `Refused by the contract: ${humanize(response.data.refusal.reason)}`,
                body: response.data.refusal.detail,
              });
            else
              setResult({
                tone: 'success',
                title: 'Renewal charged',
                body: 'One period was pulled within the signed cap.',
              });
            router.refresh();
          })
        }
      >
        <IconPlayerPlay className="size-4" />
        {pending ? 'Pulling…' : 'Run renewal now'}
      </Button>
      {result && (
        <Notice tone={result.tone} title={result.title}>
          {result.body}
        </Notice>
      )}
    </div>
  );
}
