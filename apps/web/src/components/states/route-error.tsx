'use client';

import { IconCloudOff, IconRefresh } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useEffect, useTransition } from 'react';
import { cn } from '@/lib/cn';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { EmptyState } from '../ui/empty-state';

/**
 * The error boundary for a route. Retry refetches the server data and re-renders the
 * segment. Nothing in the message depends on the error: production builds redact it.
 */
export function RouteError({
  error,
  reset,
  standalone = false,
}: {
  error: Error & { digest?: string };
  reset: () => void;
  /** Full-page layout for routes without a shell, such as checkout. */
  standalone?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  useEffect(() => console.error(error), [error]);
  const card = (
    <Card className={cn(standalone && 'w-full')}>
      <EmptyState
        icon={<IconCloudOff />}
        title="This page couldn’t load"
        action={
          <Button
            variant="dark"
            disabled={pending}
            onClick={() =>
              start(() => {
                router.refresh();
                reset();
              })
            }
          >
            <IconRefresh className={cn('size-4.5', pending && 'animate-spin')} />
            {pending ? 'Retrying…' : 'Retry'}
          </Button>
        }
      >
        Nothing was changed. The service may be busy for a moment; try again.
      </EmptyState>
      {error.digest && (
        <p className="-mt-6 pb-6 text-center font-mono text-[12px] text-muted-foreground">
          Reference {error.digest}
        </p>
      )}
    </Card>
  );
  if (!standalone) return <div role="alert">{card}</div>;
  return (
    <div
      role="alert"
      className="mx-auto grid min-h-[calc(100dvh-2.5rem)] max-w-lg place-items-center px-5 py-10 [.no-demo_&]:min-h-dvh"
    >
      {card}
    </div>
  );
}
