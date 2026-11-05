import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="relative -mx-px overflow-x-auto">
      <table className={cn('w-full min-w-[560px] border-collapse text-left text-sm', className)} {...props} />
    </div>
  );
}

export function Th({
  className,
  align,
  ...props
}: ThHTMLAttributes<HTMLTableCellElement> & { align?: 'right' }) {
  return (
    <th
      className={cn(
        'border-b border-border px-5 py-2.5 text-[13px] font-medium text-muted-foreground',
        align === 'right' && 'text-right',
        className,
      )}
      {...props}
    />
  );
}

export function Td({
  className,
  align,
  ...props
}: TdHTMLAttributes<HTMLTableCellElement> & { align?: 'right' }) {
  return (
    <td
      className={cn(
        'border-b border-border-subtle px-5 py-3 align-middle',
        align === 'right' && 'text-right tabular-nums',
        className,
      )}
      {...props}
    />
  );
}

export function Tr({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr className={cn('transition-colors last:[&>td]:border-b-0 hover:bg-raised', className)} {...props} />
  );
}
