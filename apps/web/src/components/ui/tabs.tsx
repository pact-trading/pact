import Link from 'next/link';
import { cn } from '@/lib/cn';

/** URL-driven tabs, e.g. ?status=paid, so filters survive reloads and work without JS. */
export function LinkTabs({
  items,
  active,
  className,
  label,
}: {
  items: Array<{ href: string; label: string; count?: number; value: string }>;
  active: string;
  className?: string;
  label: string;
}) {
  return (
    <nav aria-label={label} className={cn('-mx-1 mb-4 flex gap-1 overflow-x-auto px-1 pb-1', className)}>
      {items.map(item => {
        const selected = item.value === active;
        return (
          <Link
            key={item.value}
            href={item.href}
            aria-current={selected ? 'page' : undefined}
            scroll={false}
            className={cn(
              'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-colors',
              selected ? 'bg-foreground text-background' : 'text-subtle-foreground hover:bg-chip',
            )}
          >
            {item.label}
            {item.count !== undefined && (
              <span
                className={cn('rounded-full px-1.5 text-[12px]', selected ? 'bg-background/20' : 'bg-chip')}
              >
                {item.count}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
