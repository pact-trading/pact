'use client';

import { IconArchive, IconRestore } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useTransition } from 'react';
import { archivePlan, restorePlan } from '@/server/actions/commerce';
import { Button } from '../../ui/button';
import { useToast } from '../../ui/toast';

/** Archive (no new signups; current subscribers keep their mandate) or restore a plan. */
export function PlanStatusButton({
  id,
  name,
  status,
}: {
  id: string;
  name: string;
  status: 'active' | 'archived';
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const active = status === 'active';
  return (
    <Button
      size="sm"
      variant={active ? 'ghost' : 'secondary'}
      disabled={pending}
      aria-label={`${active ? 'Archive' : 'Restore'} ${name}`}
      onClick={() =>
        start(async () => {
          const result = active ? await archivePlan(id) : await restorePlan(id);
          if (!result.ok) return toast(result.error.message, 'danger');
          toast(
            active
              ? `${name} archived. Current subscribers keep their plan.`
              : `${name} is taking new signups again.`,
          );
          router.refresh();
        })
      }
    >
      {active ? <IconArchive className="size-4" /> : <IconRestore className="size-4" />}
      {pending ? (active ? 'Archiving…' : 'Restoring…') : active ? 'Archive' : 'Restore'}
    </Button>
  );
}
