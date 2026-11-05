import {
  IconFileInvoice,
  IconHeadset,
  IconLink,
  IconPackage,
  IconRepeat,
  type IconProps,
} from '@tabler/icons-react';
import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/lib/cn';

const icons = {
  product: IconPackage,
  invoice: IconFileInvoice,
  plan: IconRepeat,
  link: IconLink,
  support: IconHeadset,
} satisfies Record<string, ComponentType<IconProps>>;

export interface SummaryItem {
  id: string;
  title: string;
  detail?: string | null;
  quantity?: number;
  amount: string;
  imageUrl?: string | null;
  icon?: keyof typeof icons;
  /** Controls next to the item, such as the Playground's "Remove". */
  action?: ReactNode;
}

export interface SummaryRow {
  label: ReactNode;
  value: ReactNode;
}

function Row({ label, value, strong }: SummaryRow & { strong?: boolean }) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4', strong && 'font-semibold')}>
      <dt className={strong ? 'text-foreground' : 'text-muted-foreground'}>{label}</dt>
      <dd className="text-right font-medium tabular-nums [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

/**
 * The left column: what is being paid for, the big total, line items, subtotal and the total due
 * today. Purely presentational; the server computes every amount the real checkout shows.
 */
export function SummaryPanel({
  heading,
  eyebrow,
  total,
  totalNote,
  items,
  subtotal,
  rows = [],
  dueToday,
  children,
}: {
  /** Screen-reader page heading, e.g. the product or invoice name. */
  heading: string;
  eyebrow: string;
  total: string;
  totalNote?: ReactNode;
  items: SummaryItem[];
  subtotal: string;
  /** Rows between the subtotal and the total due today: discounts, tax, already paid. */
  rows?: SummaryRow[];
  dueToday: string;
  children?: ReactNode;
}) {
  return (
    <div className="grid gap-7">
      <div className="grid gap-1">
        <h1 className="sr-only">{heading}</h1>
        <p className="text-[15px] text-muted-foreground">{eyebrow}</p>
        <p
          className="text-[40px] leading-tight font-semibold tracking-tight tabular-nums @3xl:text-[44px]"
          data-testid="checkout-total"
        >
          {total}
        </p>
        {totalNote && <p className="text-sm text-muted-foreground">{totalNote}</p>}
      </div>
      <ul className="grid gap-5" aria-label="Items">
        {items.map(item => {
          const Icon = icons[item.icon ?? 'product'];
          return (
            <li key={item.id} className="flex items-start gap-3.5">
              {item.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={item.imageUrl}
                  alt=""
                  className="size-12 shrink-0 rounded-xl border border-border object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span
                  aria-hidden
                  className="grid size-12 shrink-0 place-items-center rounded-xl border border-border bg-card text-muted-foreground"
                >
                  <Icon className="size-5" stroke={1.6} />
                </span>
              )}
              <div className="grid min-w-0 flex-1 gap-0.5">
                <p className="text-[15px] font-medium [overflow-wrap:anywhere]">{item.title}</p>
                <p className="text-[13px] text-muted-foreground">Qty {item.quantity ?? 1}</p>
                {item.detail && (
                  <p className="text-[13px] text-muted-foreground [overflow-wrap:anywhere]">{item.detail}</p>
                )}
                {item.action}
              </div>
              <p className="shrink-0 text-[15px] font-medium tabular-nums">{item.amount}</p>
            </li>
          );
        })}
      </ul>
      <dl className="grid gap-3 border-t border-border pt-5 text-[15px]">
        <Row label="Subtotal" value={subtotal} />
        {rows.map((row, index) => (
          <Row key={index} {...row} />
        ))}
        <Row label="Total due today" value={dueToday} strong />
      </dl>
      {children}
    </div>
  );
}

/** The Playground's sample add-on for "Suggest product". */
export const SUGGESTED_ADDON = {
  id: 'addon_support',
  title: 'Priority support',
  detail: 'Replies within one business day',
  amountMinor: 19_000_000n,
};

/** The Playground's sample promotion code. */
export const PREVIEW_PROMO = { code: 'SAVE10', percent: 10n };

export interface PreviewTotals {
  subtotalMinor: bigint;
  discountMinor: bigint;
  totalMinor: bigint;
}

/**
 * Totals for the Playground preview only, where promotion codes and add-ons exist. The real
 * checkout never calls this: its amounts come from the data source.
 */
export function previewTotals(input: { amountMinor: bigint; promo: boolean; addon: boolean }): PreviewTotals {
  const subtotalMinor = input.amountMinor + (input.addon ? SUGGESTED_ADDON.amountMinor : 0n);
  const discountMinor = input.promo ? (subtotalMinor * PREVIEW_PROMO.percent) / 100n : 0n;
  return { subtotalMinor, discountMinor, totalMinor: subtotalMinor - discountMinor };
}
