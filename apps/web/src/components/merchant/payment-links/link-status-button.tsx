'use client';

import { IconPlayerPause, IconPlayerPlay } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { deactivatePaymentLink, reactivatePaymentLink } from '@/server/actions/commerce';
import { Button } from '../../ui/button';
import { useToast } from '../../ui/toast';

/** Turns a link off (no new payments) or back on. Paid orders are never touched. */
export function LinkStatusButton({
  id,
  name,
  status,
  size = 'sm',
  variant,
}: {
  id: string;
  name: string;
  status: 'active' | 'inactive';
  size?: 'sm' | 'md';
  variant?: 'secondary' | 'ghost';
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const on = status === 'active';
  return (
    <Button
      size={size}
      variant={variant ?? (on ? 'ghost' : 'secondary')}
      disabled={pending}
      aria-label={`${on ? 'Turn off' : 'Turn on'} ${name}`}
      onClick={() =>
        start(async () => {
          const result = on ? await deactivatePaymentLink(id) : await reactivatePaymentLink(id);
          if (!result.ok) return toast(result.error.message, 'danger');
          toast(on ? `${name} is off. It takes no new payments.` : `${name} is taking payments again.`);
          router.refresh();
        })
      }
    >
      {on ? <IconPlayerPause className="size-4" /> : <IconPlayerPlay className="size-4" />}
      {pending ? (on ? 'Turning off…' : 'Turning on…') : on ? 'Turn off' : 'Turn on'}
    </Button>
  );
}
