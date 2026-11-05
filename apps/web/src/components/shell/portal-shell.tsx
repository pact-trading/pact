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

const tabs = [
  { href: '/portal', label: 'Overview' },
  { href: '/portal/purchases', label: 'Purchases' },
  { href: '/portal/subscriptions', label: 'Subscriptions' },
  { href: '/portal/invoices', label: 'Invoices' },
  { href: '/portal/agents', label: 'Agents' },
  { href: '/portal/account', label: 'Account' },
];

export function PortalShell({ viewer, children }: { viewer: Viewer; children: ReactNode }) {
  const path = usePathname();
  const auth = usePactAuth();
  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-nav backdrop-blur">
        <div className="mx-auto flex h-16 max-w-5xl items-center gap-3 px-4 sm:px-6">
          <Link href="/portal" aria-label="Your Pact account">
            <PactLogo width={84} />
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
        <nav
          aria-label="Account"
          className="relative mx-auto flex max-w-5xl gap-1 overflow-x-auto px-3 sm:px-5"
        >
          {tabs.map(tab => {
            const active = tab.href === '/portal' ? path === '/portal' : path.startsWith(tab.href);
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
