'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { IconLogout } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { Viewer } from '@pactagent/core/platform-types';
import { cn } from '@/lib/cn';
import { PactLogo } from '../brand/pact-logo';
import { usePactAuth } from '../auth/auth-context';
import { ThemeToggle } from './theme-toggle';

const sides = {
  investor: {
    home: '/investor',
    badge: 'Investors',
    label: 'Pact for investors',
    tabs: [
      {
        href: '/investor',
        label: 'Marketplace',
        match: (path: string) => path === '/investor' || path.startsWith('/investor/invoices'),
      },
      {
        href: '/investor/portfolio',
        label: 'Portfolio',
        match: (path: string) => path.startsWith('/investor/portfolio'),
      },
    ],
  },
  compliance: {
    home: '/compliance',
    badge: 'Compliance',
    label: 'Pact compliance',
    tabs: [
      { href: '/compliance', label: 'Investor registry', match: (path: string) => path === '/compliance' },
    ],
  },
};

/**
 * The investor's side (the invoice marketplace and their portfolio) and Pact compliance's side
 * (the investor registry). Same frame as the customer portal.
 */
export function InvestorShell({
  viewer,
  children,
  side = 'investor',
}: {
  viewer: Viewer;
  children: ReactNode;
  side?: keyof typeof sides;
}) {
  const path = usePathname();
  const auth = usePactAuth();
  const { home, badge, label, tabs } = sides[side];
  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-nav backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center gap-3 px-4 sm:px-6">
          <Link href={home} aria-label={label} className="flex items-center gap-2.5">
            <PactLogo width={84} />
            <span className="rounded-full border border-border px-2 py-0.5 text-[12px] font-medium text-muted-foreground">
              {badge}
            </span>
          </Link>
          <div className="ml-auto flex items-center gap-1">
            <div className="mr-2 hidden text-right sm:block">
              <p className="text-sm leading-tight font-medium">{viewer.name}</p>
              <p className="text-[13px] leading-tight text-muted-foreground">{viewer.organization}</p>
            </div>
            <ThemeToggle />
            <button
              type="button"
              onClick={() => void auth.logout()}
              aria-label="Sign out"
              className="grid size-10 place-items-center rounded-full text-muted-foreground hover:bg-chip hover:text-foreground"
            >
              <IconLogout className="size-4.5" />
            </button>
          </div>
        </div>
        <nav aria-label={badge} className="mx-auto flex max-w-5xl gap-1 overflow-x-auto px-3 sm:px-5">
          {tabs.map(tab => {
            const active = tab.match(path);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'relative shrink-0 px-3 py-3 text-[15px] transition-colors',
                  active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {tab.label}
                {active && (
                  <span
                    aria-hidden
                    className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-foreground"
                  />
                )}
              </Link>
            );
          })}
        </nav>
      </header>
      <main className="mx-auto w-full max-w-5xl px-4 py-7 sm:px-6 sm:py-10">{children}</main>
    </div>
  );
}
