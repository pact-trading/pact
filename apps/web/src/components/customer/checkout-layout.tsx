import type { CSSProperties, ReactNode } from 'react';
import { primaryTextColor } from '@pactagent/core/theme';
import { ThemeToggle } from '../shell/theme-toggle';
import { CheckoutFrame, type CheckoutBack } from './checkout/frame';
import { SummaryPanel, type SummaryItem, type SummaryRow } from './checkout/summary';

export type { CheckoutBack } from './checkout/frame';
export type { SummaryItem, SummaryRow } from './checkout/summary';

/**
 * Merchant-branded payment page. The customer sees the business, never Pact's dashboard.
 * Summary on the left, payment card on the right; stacked on small screens.
 */
export function CheckoutLayout({
  brand,
  summary,
  children,
  back,
}: {
  brand: { brandName: string; logoUrl: string | null; brandColor?: string | null };
  summary: ReactNode;
  children: ReactNode;
  /** The back arrow by the brand. */
  back?: CheckoutBack;
}) {
  // The merchant's saved accent colour drives the primary buttons, with a readable label colour.
  const accent =
    brand.brandColor && /^#[0-9a-f]{6}$/i.test(brand.brandColor)
      ? ({
          '--primary': brand.brandColor,
          '--primary-foreground': primaryTextColor(brand.brandColor),
        } as CSSProperties)
      : undefined;
  return (
    <main className="min-h-[calc(100dvh-2.5rem)] bg-background [.no-demo_&]:min-h-dvh">
      <CheckoutFrame brand={brand} back={back} summary={summary} aside={<ThemeToggle />} style={accent}>
        {children}
      </CheckoutFrame>
    </main>
  );
}

/**
 * The order summary column. `title`, `description` and `amount` describe one item; pass `items`,
 * `subtotal`, `rows` and `dueToday` for anything richer. `lines` render as rows after the subtotal.
 */
export function OrderSummary({
  eyebrow,
  title,
  description,
  amount,
  lines,
  items,
  subtotal,
  rows,
  dueToday,
  totalNote,
  imageUrl,
  icon,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string | null;
  /** The big total. */
  amount: string;
  lines?: Array<{ label: string; value: string }>;
  items?: SummaryItem[];
  subtotal?: string;
  rows?: SummaryRow[];
  dueToday?: string;
  totalNote?: ReactNode;
  imageUrl?: string | null;
  icon?: SummaryItem['icon'];
  children?: ReactNode;
}) {
  return (
    <SummaryPanel
      heading={title}
      eyebrow={eyebrow}
      total={amount}
      totalNote={totalNote}
      items={items ?? [{ id: 'item', title, detail: description, amount, imageUrl, icon }]}
      subtotal={subtotal ?? amount}
      rows={[...(rows ?? []), ...(lines ?? [])]}
      dueToday={dueToday ?? amount}
    >
      {children}
    </SummaryPanel>
  );
}
