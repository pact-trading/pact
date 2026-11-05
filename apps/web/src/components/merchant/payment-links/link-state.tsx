import type { PaymentLink, PaymentLinkState } from '@/server/data/parts/commerce';
import { usd } from '@/lib/format';
import { Badge, type Tone } from '../../ui/badge';

const states: Record<PaymentLinkState, { label: string; tone: Tone }> = {
  active: { label: 'Active', tone: 'success' },
  inactive: { label: 'Off', tone: 'outline' },
  expired: { label: 'Expired', tone: 'outline' },
  used: { label: 'Used', tone: 'neutral' },
};

export const linkStateLabel = (state: PaymentLinkState) => states[state].label;

/** Whether a payer can use the link right now, in the words the list and detail page share. */
export function LinkStateBadge({ state, className }: { state: PaymentLinkState; className?: string }) {
  const { label, tone } = states[state];
  return (
    <Badge tone={tone} className={className}>
      <span aria-hidden className="size-1.5 rounded-full bg-current opacity-70" />
      {label}
    </Badge>
  );
}

/** "$250.00", or how the payer picks the amount. */
export function linkAmount(link: Pick<PaymentLink, 'kind' | 'amountMinor'>) {
  if (link.amountMinor !== null) return usd(link.amountMinor);
  return link.kind === 'tip' ? 'Payer chooses' : '—';
}

export const linkKindLabel: Record<PaymentLink['kind'], string> = {
  product: 'Fixed amount',
  tip: 'Customer chooses',
  subscription: 'Recurring',
};
