import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        'min-w-0 rounded-2xl border border-border bg-card text-card-foreground shadow-panel',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle px-5 py-4',
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="text-base font-semibold">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
    </header>
  );
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('p-5', className)} {...props} />;
}

/** Label / value rows for record details. */
export function DetailList({
  items,
  className,
}: {
  items: Array<{ label: ReactNode; value: ReactNode; hint?: ReactNode }>;
  className?: string;
}) {
  return (
    <dl className={cn('divide-y divide-border-subtle', className)}>
      {items.map((item, index) => (
        <div
          key={index}
          className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3 first:pt-0 last:pb-0"
        >
          <dt className="text-sm text-muted-foreground">{item.label}</dt>
          <dd className="min-w-0 text-right text-[15px] font-medium [overflow-wrap:anywhere]">
            {item.value}
            {item.hint && (
              <span className="block text-[13px] font-normal text-muted-foreground">{item.hint}</span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
