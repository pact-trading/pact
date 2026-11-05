import { IconAlertTriangle, IconCircleCheck, IconInfoCircle, IconShieldCheck } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

const styles = {
  info: { box: 'border-border bg-raised text-foreground', icon: IconInfoCircle },
  success: { box: 'border-success/25 bg-success-soft text-foreground', icon: IconCircleCheck },
  warning: { box: 'border-warning/30 bg-warning-soft text-foreground', icon: IconAlertTriangle },
  danger: { box: 'border-destructive/30 bg-destructive-soft text-foreground', icon: IconAlertTriangle },
  shield: { box: 'border-border bg-raised text-foreground', icon: IconShieldCheck },
};

export function Notice({
  tone = 'info',
  title,
  children,
  action,
  className,
  role,
}: {
  tone?: keyof typeof styles;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  role?: 'status' | 'alert';
}) {
  const { box, icon: Icon } = styles[tone];
  return (
    <div
      role={role ?? (tone === 'danger' ? 'alert' : 'status')}
      className={cn('flex gap-3 rounded-xl border px-4 py-3 text-sm', box, className)}
    >
      <Icon
        aria-hidden
        className={cn(
          'mt-0.5 size-4.5 shrink-0',
          tone === 'success' && 'text-success',
          tone === 'warning' && 'text-warning',
          tone === 'danger' && 'text-destructive',
        )}
      />
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn('text-subtle-foreground', title && 'mt-0.5')}>{children}</div>}
      </div>
      {action && <div className="shrink-0 self-center">{action}</div>}
    </div>
  );
}
