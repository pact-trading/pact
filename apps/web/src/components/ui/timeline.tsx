import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type TimelineTone = 'default' | 'success' | 'warning' | 'danger';

export function Timeline({
  items,
  className,
}: {
  items: Array<{
    id?: string;
    title: ReactNode;
    detail?: ReactNode;
    at?: ReactNode;
    tone?: TimelineTone;
    extra?: ReactNode;
  }>;
  className?: string;
}) {
  return (
    <ol className={cn('relative grid gap-5', className)}>
      {items.map((item, index) => (
        <li key={item.id ?? index} className="relative flex gap-3.5">
          {index < items.length - 1 && (
            <span aria-hidden className="absolute top-4 bottom-[-1.25rem] left-[5px] w-px bg-border" />
          )}
          <span
            aria-hidden
            className={cn(
              'relative mt-1.5 size-[11px] shrink-0 rounded-full border-2 border-card ring-1 ring-border',
              item.tone === 'success'
                ? 'bg-success'
                : item.tone === 'warning'
                  ? 'bg-warning'
                  : item.tone === 'danger'
                    ? 'bg-destructive'
                    : 'bg-muted-foreground/60',
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className="text-[15px] font-medium">{item.title}</p>
              {item.at && <p className="text-[13px] text-muted-foreground">{item.at}</p>}
            </div>
            {item.detail && (
              <p className="mt-0.5 text-sm text-muted-foreground [overflow-wrap:anywhere]">{item.detail}</p>
            )}
            {item.extra && <div className="mt-1.5">{item.extra}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
