'use client';

import Link from 'next/link';
import {
  IconBuildingStore,
  IconChartPie,
  IconCircleFilled,
  IconLogout,
  IconShieldCheck,
  IconUserCircle,
} from '@tabler/icons-react';
import { useTransition } from 'react';
import type { ViewerRole } from '@pactagent/core/platform-types';
import { usePactAuth } from '../auth/auth-context';
import { chooseViewer } from '@/server/actions/demo';
import { cn } from '@/lib/cn';

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * Live mode: which business wallet and which customer account are signed in, and a switch between
 * their views. On a local fork it says so, because balances there are not real testnet funds.
 */
export function LiveBar({ role }: { role: ViewerRole | null }) {
  const auth = usePactAuth();
  const [pending, start] = useTransition();
  const live = auth.live;
  if (!live) return null;
  const view = (next: 'merchant' | 'customer' | 'investor' | 'compliance') => start(() => chooseViewer(next));
  const side = (active: boolean) =>
    cn(
      'inline-flex min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1 hover:bg-white/10 hover:text-white',
      active && 'bg-white/15 text-white',
    );
  return (
    <div className="sticky top-0 z-40 border-b border-ink-line bg-ink text-[13px] text-ink-foreground">
      <div className="mx-auto flex h-10 max-w-[1600px] items-center gap-2 px-3 sm:gap-3 sm:px-4">
        <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-white">
          <IconCircleFilled
            className={cn('size-2.5', live.config.localFork ? 'text-warning' : 'text-primary')}
          />
          {live.config.localFork ? 'Local fork' : 'Whitechain Sepolia'}
        </span>
        <span className="h-4 w-px bg-white/15" />
        {live.merchant ? (
          <button
            type="button"
            disabled={pending}
            className={side(role === 'merchant' || role === 'accountant')}
            onClick={() => view('merchant')}
          >
            <IconBuildingStore className="size-4" />
            <span className="truncate">Business {short(live.merchant.address)}</span>
          </button>
        ) : (
          <Link href="/login" className={side(false)}>
            <IconBuildingStore className="size-4" /> Connect a business wallet
          </Link>
        )}
        {live.customer ? (
          <button
            type="button"
            disabled={pending}
            className={side(role === 'customer')}
            onClick={() => view('customer')}
          >
            <IconUserCircle className="size-4" />
            <span className="truncate">Customer {live.customer.email ?? short(live.customer.address)}</span>
          </button>
        ) : (
          <Link href="/login" className={side(false)}>
            <IconUserCircle className="size-4" /> Sign in as a customer
          </Link>
        )}
        {live.investor && (
          <button
            type="button"
            disabled={pending}
            className={side(role === 'investor')}
            onClick={() => view('investor')}
          >
            <IconChartPie className="size-4" />
            <span className="hidden truncate md:inline">Investor {short(live.investor.address)}</span>
          </button>
        )}
        {live.compliance && (
          <button
            type="button"
            disabled={pending}
            className={side(role === 'compliance')}
            onClick={() => view('compliance')}
          >
            <IconShieldCheck className="size-4" />
            <span className="hidden truncate md:inline">Compliance {short(live.compliance.address)}</span>
          </button>
        )}
        <span className="flex-1" />
        {(live.merchant || live.customer || live.investor || live.compliance) && (
          <button type="button" className={side(false)} onClick={() => void auth.logout()}>
            <IconLogout className="size-4" />
            <span className="hidden sm:inline">Sign out</span>
          </button>
        )}
      </div>
    </div>
  );
}
