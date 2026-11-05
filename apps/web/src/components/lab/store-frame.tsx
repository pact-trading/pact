import Link from 'next/link';
import type { ReactNode } from 'react';
import type { CheckoutBrand } from '@/server/data/types';
import { ThemeToggle } from '../shell/theme-toggle';

/**
 * The fictional merchant website that integrates Pact. It is the business's own site,
 * so it carries the business's brand, and only the checkout is Pact's.
 */
export function StoreFrame({
  brand,
  shopper,
  children,
}: {
  brand: CheckoutBrand;
  shopper: { name: string } | null;
  children: ReactNode;
}) {
  return (
    <div className="min-h-[calc(100dvh-2.5rem)] [.no-demo_&]:min-h-dvh">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex h-16 max-w-5xl items-center gap-3 px-5">
          <Link href="/demo/store" className="flex min-w-0 items-center gap-2.5 font-semibold">
            {brand.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={brand.logoUrl}
                alt=""
                className="size-8 rounded-lg object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              <span
                aria-hidden
                className="grid size-8 shrink-0 place-items-center rounded-lg bg-foreground text-sm font-bold text-background"
              >
                {brand.brandName.charAt(0)}
              </span>
            )}
            <span className="truncate">{brand.brandName}</span>
          </Link>
          <nav aria-label="Store" className="ml-auto flex items-center gap-1 text-sm">
            <Link
              href="/demo/store"
              className="rounded-full px-3 py-1.5 text-subtle-foreground hover:bg-chip"
            >
              Shop
            </Link>
            {shopper && (
              <span className="hidden px-2 text-muted-foreground sm:inline">Signed in as {shopper.name}</span>
            )}
            <ThemeToggle />
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-5 pt-8 pb-14">{children}</main>
      <footer className="mx-auto max-w-5xl px-5 pb-10 text-[13px] text-muted-foreground">
        A fictional storefront for the demo. Its checkout and webhooks run on Pact, like{' '}
        <code className="font-mono">examples/merchant-store</code>.
      </footer>
    </div>
  );
}
