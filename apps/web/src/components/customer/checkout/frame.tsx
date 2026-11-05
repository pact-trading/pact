import { IconLock } from '@tabler/icons-react';
import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { BackControl, type CheckoutBack } from './back-control';

export type { CheckoutBack } from './back-control';

export interface CheckoutBrandView {
  brandName: string;
  logoUrl: string | null;
}

/** Corner radius of the checkout's boxes; the Playground overrides `--checkout-radius`. */
export const radius = {
  card: 'rounded-[calc(var(--checkout-radius,16px)*1.5)]',
  box: 'rounded-[var(--checkout-radius,16px)]',
  control: 'rounded-[calc(var(--checkout-radius,16px)*0.75)]',
  button: 'rounded-[var(--checkout-button-radius,9999px)]',
};

export function BrandMark({ brand }: { brand: CheckoutBrandView }) {
  return brand.logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={brand.logoUrl}
      alt=""
      className="size-9 shrink-0 rounded-xl object-contain"
      referrerPolicy="no-referrer"
    />
  ) : (
    <span
      aria-hidden
      className="grid size-9 shrink-0 place-items-center rounded-xl bg-foreground text-sm font-bold text-background"
    >
      {(brand.brandName.trim() || '?').charAt(0).toUpperCase()}
    </span>
  );
}

/** "Powered by Pact · Terms · Privacy", at the foot of every payment card. */
export function CheckoutFooter() {
  const link = 'rounded-sm underline-offset-4 hover:text-foreground hover:underline';
  return (
    <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-subtle pt-4 text-[13px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <IconLock aria-hidden className="size-3.5" />
        Powered by <strong className="font-semibold text-foreground">Pact</strong>
      </span>
      <a href="/legal/terms" target="_blank" rel="noreferrer" className={link}>
        Terms
      </a>
      <a href="/legal/privacy" target="_blank" rel="noreferrer" className={link}>
        Privacy
      </a>
    </footer>
  );
}

/**
 * The one-page checkout: the business and order summary on the left, the payment card on the right.
 * Container queries, not the viewport, decide the layout, so the Playground's device frames and the
 * real page lay out the same way. Narrow containers stack the summary above the payment card.
 */
export function CheckoutFrame({
  brand,
  back,
  summary,
  children,
  aside,
  className,
  style,
  embedded,
}: {
  brand: CheckoutBrandView;
  back?: CheckoutBack;
  summary: ReactNode;
  children: ReactNode;
  /** Extra controls at the end of the brand row, such as the theme toggle. */
  aside?: ReactNode;
  className?: string;
  style?: CSSProperties;
  /**
   * Only the payment card, for a checkout embedded in the merchant's own page or popup. The host
   * page shows the order, so `summary` is not rendered.
   */
  embedded?: { total: string };
}) {
  if (embedded)
    return (
      <section
        aria-label="Payment"
        className={cn('grid gap-6 bg-card p-5 sm:p-6', className)}
        style={style}
        data-testid="checkout-embedded"
      >
        <div className="flex min-w-0 items-center gap-3">
          <BrandMark brand={brand} />
          <span className="min-w-0 flex-1 truncate font-semibold">{brand.brandName || 'Your business'}</span>
          <span className="text-lg font-semibold tabular-nums">{embedded.total}</span>
        </div>
        {children}
        <CheckoutFooter />
      </section>
    );
  return (
    <div className={cn('@container', className)} style={style}>
      <div className="mx-auto grid w-full max-w-6xl @3xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] @3xl:gap-12 @3xl:px-8 @3xl:py-12 @5xl:gap-20">
        <section aria-label="Order summary" className="min-w-0 px-5 pt-6 pb-8 @3xl:px-0 @3xl:pt-1 @3xl:pb-0">
          <div className="grid content-start gap-7 @3xl:sticky @3xl:top-8">
            <div className="flex min-w-0 items-center gap-3" data-testid="checkout-brand">
              {back && <BackControl back={back} variant="icon" />}
              <BrandMark brand={brand} />
              <span className="min-w-0 truncate text-base font-semibold">
                {brand.brandName || 'Your business'}
              </span>
              {aside && <div className="ml-auto flex items-center">{aside}</div>}
            </div>
            {summary}
          </div>
        </section>
        <section
          aria-label="Payment"
          className="min-w-0 border-t border-border bg-card px-5 py-7 @3xl:rounded-[calc(var(--checkout-radius,16px)*1.5)] @3xl:border @3xl:p-8 @3xl:shadow-panel"
        >
          <div className="grid gap-6">
            {children}
            <CheckoutFooter />
          </div>
        </section>
      </div>
    </div>
  );
}
