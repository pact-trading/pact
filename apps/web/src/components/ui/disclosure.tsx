import { IconChevronDown } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** Native details/summary: keyboard and screen-reader friendly without client JS. */
export function Disclosure({
  summary,
  children,
  className,
  defaultOpen,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  return (
    <details className={cn('group rounded-xl border border-border', className)} open={defaultOpen}>
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium [&::-webkit-details-marker]:hidden">
        {summary}
        <IconChevronDown
          aria-hidden
          className="size-4 text-muted-foreground transition-transform group-open:rotate-180"
        />
      </summary>
      <div className="border-t border-border-subtle px-4 py-3">{children}</div>
    </details>
  );
}
