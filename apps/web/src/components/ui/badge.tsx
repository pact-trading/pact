import { cva, type VariantProps } from 'class-variance-authority';
import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/cn';
import { humanize } from '@/lib/format';

export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-[13px] font-medium',
  {
    variants: {
      tone: {
        neutral: 'bg-chip text-subtle-foreground',
        success: 'bg-success-soft text-success',
        warning: 'bg-warning-soft text-warning',
        danger: 'bg-destructive-soft text-destructive',
        accent: 'bg-primary text-primary-foreground',
        outline: 'border border-border text-subtle-foreground',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type Tone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export function Badge({
  className,
  tone,
  ...props
}: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

const tones: Record<string, Tone> = {
  paid: 'success',
  active: 'success',
  trialing: 'accent',
  settled: 'success',
  succeeded: 'success',
  delivered: 'success',
  charged: 'success',
  captured: 'success',
  online: 'success',
  sent: 'neutral',
  acknowledged: 'neutral',
  open: 'neutral',
  draft: 'outline',
  pending: 'warning',
  partially_paid: 'warning',
  partially_refunded: 'warning',
  past_due: 'warning',
  retry_scheduled: 'warning',
  paused: 'warning',
  refunded: 'neutral',
  overdue: 'danger',
  refused: 'danger',
  failed: 'danger',
  expired: 'outline',
  cancelled: 'outline',
  revoked: 'outline',
  archived: 'outline',
};

const labels: Record<string, string> = {
  partially_refunded: 'Partly refunded',
  partially_paid: 'Partly paid',
  past_due: 'Past due',
  retry_scheduled: 'Retry scheduled',
};

/** A status pill for any record status from the API. */
export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge tone={tones[status] ?? 'neutral'} className={className}>
      <span aria-hidden className="size-1.5 rounded-full bg-current opacity-70" />
      {labels[status] ?? humanize(status)}
    </Badge>
  );
}
