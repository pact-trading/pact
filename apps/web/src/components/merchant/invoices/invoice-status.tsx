import type { InvoiceStatus } from '@pactagent/core/api-types';
import { Badge, type Tone } from '../../ui/badge';

const chip: Record<InvoiceStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'outline' },
  sent: { label: 'Awaiting payment', tone: 'neutral' },
  acknowledged: { label: 'Acknowledged', tone: 'neutral' },
  partially_paid: { label: 'Partly paid', tone: 'warning' },
  paid: { label: 'Paid', tone: 'success' },
  overdue: { label: 'Overdue', tone: 'danger' },
};

/** Whole days from `now` to `due`, rounded towards the due date. */
function daysUntil(due: string, now: string) {
  return Math.ceil((new Date(due).getTime() - new Date(now).getTime()) / 86_400_000);
}

/** The invoice's status in plain words, with how long until (or since) it is due. */
export function InvoiceStatusChip({
  status,
  dueAt,
  now,
  className,
}: {
  status: InvoiceStatus;
  dueAt?: string | null;
  now?: string;
  className?: string;
}) {
  const { label, tone } = chip[status] ?? { label: status, tone: 'neutral' as const };
  const open = status !== 'draft' && status !== 'paid';
  const days = open && dueAt && now ? daysUntil(dueAt, now) : null;
  const when =
    days === null
      ? null
      : days < 0
        ? `${-days} day${days === -1 ? '' : 's'} late`
        : days === 0
          ? 'due today'
          : `due in ${days} day${days === 1 ? '' : 's'}`;
  return (
    <span className={className}>
      <Badge tone={tone} data-testid="invoice-status">
        <span aria-hidden className="size-1.5 rounded-full bg-current opacity-70" />
        {label}
      </Badge>
      {when && <span className="ml-2 text-[13px] font-normal text-muted-foreground">{when}</span>}
    </span>
  );
}

export const invoiceStatusLabel = (status: InvoiceStatus) => chip[status]?.label ?? status;
