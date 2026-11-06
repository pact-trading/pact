'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  IconApi,
  IconBook,
  IconBox,
  IconBuildingBank,
  IconChevronLeft,
  IconChevronRight,
  IconCode,
  IconDiscount2,
  IconFileExport,
  IconFileInvoice,
  IconHome,
  IconLayoutSidebarLeftExpand,
  IconLink,
  IconLogout,
  IconMenu2,
  IconPlayerPlay,
  IconPlus,
  IconReceiptRefund,
  IconReceiptTax,
  IconRepeat,
  IconRobot,
  IconSearch,
  IconSettings,
  IconShieldCheck,
  IconShoppingBag,
  IconStack2,
  IconUsers,
  IconWorld,
  IconX,
  type Icon,
} from '@tabler/icons-react';
import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Viewer } from '@pactagent/core/platform-types';
import { cn } from '@/lib/cn';
import { SIDEBAR_COOKIE } from '@/lib/sidebar';
import { PactLogo } from '../brand/pact-logo';
import { usePactAuth } from '../auth/auth-context';
import { Badge } from '../ui/badge';
import { CommandPalette, type Command } from './command-palette';
import { ThemeToggle } from './theme-toggle';

type NavItem = { href: string; label: string; icon: Icon; accountant?: boolean; keywords?: string };
const groups: Array<{ label: string | null; items: NavItem[] }> = [
  { label: null, items: [{ href: '/dashboard', label: 'Overview', icon: IconHome }] },
  {
    label: 'Commerce',
    items: [
      { href: '/dashboard/products', label: 'Products', icon: IconBox, keywords: 'catalog price share qr' },
      {
        href: '/dashboard/payment-links',
        label: 'Payment links',
        icon: IconLink,
        accountant: true,
        keywords: 'tip share',
      },
      {
        href: '/dashboard/orders',
        label: 'Orders',
        icon: IconShoppingBag,
        accountant: true,
        keywords: 'payments',
      },
      { href: '/dashboard/refunds', label: 'Refunds', icon: IconReceiptRefund, accountant: true },
      { href: '/dashboard/discounts', label: 'Discounts', icon: IconDiscount2, keywords: 'promo code sale coupon' },
      { href: '/dashboard/customers', label: 'Customers', icon: IconUsers, accountant: true },
    ],
  },
  {
    label: 'Billing',
    items: [
      { href: '/dashboard/invoices', label: 'Invoices', icon: IconFileInvoice, accountant: true },
      {
        href: '/dashboard/plans',
        label: 'Plans',
        icon: IconStack2,
        accountant: true,
        keywords: 'pricing recurring',
      },
      {
        href: '/dashboard/subscriptions',
        label: 'Subscriptions',
        icon: IconRepeat,
        keywords: 'renewal mandate',
      },
      {
        href: '/dashboard/financing',
        label: 'Financing',
        icon: IconBuildingBank,
        accountant: true,
        keywords: 'advance investor',
      },
    ],
  },
  {
    label: 'Agents',
    items: [
      { href: '/dashboard/paid-api', label: 'Paid API', icon: IconApi, keywords: 'x402 endpoint' },
      {
        href: '/dashboard/agents',
        label: 'Agents',
        icon: IconRobot,
        keywords: 'ai budget cap request',
      },
    ],
  },
  {
    label: 'Money',
    items: [
      {
        href: '/dashboard/fees',
        label: 'Fees',
        icon: IconReceiptTax,
        accountant: true,
        keywords: 'pricing rate terms permit refund net',
      },
      { href: '/dashboard/security', label: 'Security', icon: IconShieldCheck, keywords: 'drain relayer' },
      {
        href: '/dashboard/exports',
        label: 'Exports',
        icon: IconFileExport,
        accountant: true,
        keywords: 'csv',
      },
    ],
  },
  {
    label: 'Developers',
    items: [
      {
        href: '/dashboard/developers',
        label: 'Integration',
        icon: IconCode,
        keywords: 'api keys webhooks sdk',
      },
      { href: '/playground', label: 'Playground', icon: IconPlayerPlay, keywords: 'checkout appearance' },
      { href: '/docs', label: 'Quickstart', icon: IconBook, keywords: 'docs guide' },
    ],
  },
  {
    label: 'Workspace',
    items: [
      { href: '/dashboard/settings', label: 'Settings', icon: IconSettings, keywords: 'brand refund window' },
    ],
  },
];

const actions: Array<NavItem & { id: string }> = [
  { id: 'new-invoice', href: '/dashboard/invoices/new', label: 'New invoice', icon: IconPlus },
  { id: 'new-order', href: '/dashboard/orders/new', label: 'Create order', icon: IconPlus },
  { id: 'new-link', href: '/dashboard/payment-links/new', label: 'New payment link', icon: IconPlus },
  { id: 'new-plan', href: '/dashboard/plans/new', label: 'New plan', icon: IconPlus },
];

const isActive = (path: string, href: string) =>
  href === '/dashboard' ? path === href : path === href || path.startsWith(`${href}/`);

/** Breadcrumb trail for the current path: business, section, then any deeper segment. */
function trail(path: string, items: NavItem[]): Array<{ label: string; href: string | null }> {
  const section = items
    .filter(item => isActive(path, item.href))
    .sort((a, b) => b.href.length - a.href.length)[0];
  if (!section) return [{ label: 'Overview', href: null }];
  const crumbs: Array<{ label: string; href: string | null }> = [
    { label: section.label, href: path === section.href ? null : section.href },
  ];
  const rest = path.slice(section.href.length).split('/').filter(Boolean);
  rest.forEach((segment, index) => {
    const href = `${section.href}/${rest.slice(0, index + 1).join('/')}`;
    const label =
      segment === 'new' ? 'New' : segment === 'requests' ? 'Requests' : decodeURIComponent(segment);
    crumbs.push({ label, href: index === rest.length - 1 ? null : href });
  });
  return crumbs;
}

export function MerchantShell({
  viewer,
  business,
  initialCollapsed = false,
  children,
}: {
  viewer: Viewer;
  business: string;
  initialCollapsed?: boolean;
  children: ReactNode;
}) {
  const path = usePathname();
  const auth = usePactAuth();
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [palette, setPalette] = useState(false);
  useEffect(() => setOpen(false), [path]);
  const readOnly = viewer.role === 'accountant';
  const visible = useMemo(
    () =>
      groups
        .map(g => ({ ...g, items: g.items.filter(item => !readOnly || item.accountant) }))
        .filter(g => g.items.length),
    [readOnly],
  );
  const allItems = useMemo(() => visible.flatMap(g => g.items), [visible]);
  const commands: Command[] = useMemo(
    () => [
      ...visible.flatMap(g =>
        g.items.map(item => ({
          id: item.href,
          label: item.label,
          group: g.label ?? 'Workspace',
          href: item.href,
          icon: item.icon,
          keywords: item.keywords,
        })),
      ),
      ...(readOnly ? [] : actions.map(a => ({ ...a, group: 'Actions' }))),
    ],
    [visible, readOnly],
  );

  const toggleCollapsed = useCallback(() => {
    setCollapsed(value => {
      const next = !value;
      document.cookie = `${SIDEBAR_COOKIE}=${next ? 'collapsed' : 'open'}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(false);
        setPalette(value => !value);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /** `compact` is the collapsed desktop rail: icons only, labels in tooltips and for screen readers. */
  const sidebar = (compact: boolean) => (
    <div className="flex h-full flex-col">
      <div className={cn('flex items-center px-3 pt-4 pb-3', compact ? 'justify-center' : 'justify-between')}>
        <Link href="/dashboard" aria-label="Pact dashboard" className={cn(compact && 'hidden')}>
          <PactLogo width={92} />
        </Link>
        <button
          type="button"
          className="grid size-9 place-items-center rounded-full hover:bg-chip lg:hidden"
          onClick={() => setOpen(false)}
          aria-label="Close menu"
        >
          <IconX className="size-5" />
        </button>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label={compact ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!compact}
          title={compact ? 'Expand sidebar' : 'Collapse sidebar'}
          className="group hidden size-9 place-items-center rounded-xl border border-border text-muted-foreground hover:bg-chip hover:text-foreground lg:grid"
        >
          {compact ? (
            <>
              <span className="text-sm font-bold text-foreground group-hover:hidden group-focus-visible:hidden">
                <PactLogo width={20} markOnly />
              </span>
              <IconLayoutSidebarLeftExpand
                className="hidden size-5 group-hover:block group-focus-visible:block"
                stroke={1.6}
              />
            </>
          ) : (
            <IconChevronLeft className="size-[18px]" stroke={1.6} />
          )}
        </button>
      </div>
      <div
        className={cn(
          'mb-3 rounded-2xl border border-border bg-card',
          compact ? 'mx-auto p-1.5' : 'mx-1 p-2.5',
        )}
      >
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden={!compact}
            title={compact ? business : undefined}
            className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary text-sm font-bold text-primary-foreground"
          >
            {business.charAt(0)}
          </span>
          {!compact && (
            <div className="min-w-0">
              <p className="truncate text-[15px] font-semibold">{business}</p>
              <p className="truncate text-[13px] text-muted-foreground">Testnet workspace</p>
            </div>
          )}
        </div>
      </div>
      <div className={cn('px-1 pb-2', compact && 'flex justify-center')}>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setPalette(true);
          }}
          title={compact ? 'Search (⌘K)' : undefined}
          aria-label={compact ? 'Search' : undefined}
          aria-keyshortcuts="Meta+K Control+K"
          className={cn(
            'flex h-8 items-center gap-2.5 rounded-xl text-[15px] text-subtle-foreground hover:bg-chip hover:text-foreground',
            compact ? 'w-10 justify-center' : 'w-full px-3',
          )}
        >
          <IconSearch className="size-[18px]" stroke={1.6} />
          {!compact && (
            <>
              <span>Search</span>
              <kbd className="ml-auto rounded-md border border-border px-1.5 text-[12px] text-muted-foreground">
                ⌘ K
              </kbd>
            </>
          )}
        </button>
      </div>
      <nav aria-label="Workspace" className="flex-1 overflow-y-auto px-1 pb-4">
        <div className="grid gap-3">
          {visible.map(group => (
            <div key={group.label ?? 'main'} className="grid gap-0.5">
              {group.label &&
                (compact ? (
                  <span aria-hidden className="mx-auto my-1 h-px w-6 bg-border" />
                ) : (
                  <p className="px-3 pb-0.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                    {group.label}
                  </p>
                ))}
              {group.items.map(item => {
                const active = isActive(path, item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    aria-label={compact ? item.label : undefined}
                    title={compact ? item.label : undefined}
                    className={cn(
                      'flex h-8 items-center gap-2.5 rounded-xl text-[15px] transition-colors',
                      compact ? 'mx-auto w-10 justify-center' : 'px-3',
                      active
                        ? 'bg-foreground font-medium text-background'
                        : 'text-subtle-foreground hover:bg-chip hover:text-foreground',
                    )}
                  >
                    <item.icon className="size-[18px] shrink-0" stroke={1.6} />
                    {!compact && <span className="truncate">{item.label}</span>}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      </nav>
      <div className="border-t border-border px-2 py-3">
        <div className={cn('flex items-center gap-2', compact && 'flex-col')}>
          {!compact && (
            <div className="min-w-0 flex-1 px-1">
              <p className="truncate text-sm font-medium">{viewer.name}</p>
              <p className="truncate text-[13px] text-muted-foreground">
                {readOnly ? 'Accountant · read only' : 'Owner'}
              </p>
            </div>
          )}
          <ThemeToggle />
          <button
            type="button"
            onClick={() => void auth.logout()}
            aria-label="Sign out"
            title={compact ? 'Sign out' : undefined}
            className="grid size-10 place-items-center rounded-full text-muted-foreground hover:bg-chip hover:text-foreground"
          >
            <IconLogout className="size-4.5" />
          </button>
        </div>
        {!compact && (
          <p className="mt-2 flex items-center gap-1.5 px-1 text-[12px] text-muted-foreground">
            <IconWorld className="size-3.5" stroke={1.6} aria-hidden />
            Whitechain testnet · USDT
          </p>
        )}
      </div>
    </div>
  );

  const crumbs = trail(path, allItems);

  return (
    <div
      className={cn(
        'min-h-dvh lg:grid lg:transition-[grid-template-columns] lg:duration-200 lg:ease-out motion-reduce:transition-none',
        collapsed ? 'lg:grid-cols-[72px_minmax(0,1fr)]' : 'lg:grid-cols-[260px_minmax(0,1fr)]',
      )}
    >
      <aside
        aria-label="Merchant workspace"
        className="sticky top-10 hidden h-[calc(100dvh-2.5rem)] overflow-hidden border-r border-border bg-background px-2 lg:block [.no-demo_&]:top-0 [.no-demo_&]:h-dvh"
      >
        {sidebar(collapsed)}
      </aside>
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div aria-hidden className="absolute inset-0 bg-black/45" onClick={() => setOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-[284px] max-w-[85vw] animate-fade-in border-r border-border bg-background px-2">
            {sidebar(false)}
          </aside>
        </div>
      )}
      <div className="min-w-0">
        <header className="flex h-14 items-center gap-3 border-b border-border bg-nav px-4 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Open menu"
            className="-ml-2 grid size-10 place-items-center rounded-full hover:bg-chip"
          >
            <IconMenu2 className="size-5" />
          </button>
          <span className="truncate font-semibold">{business}</span>
          <div className="ml-auto flex items-center gap-1">
            {readOnly && <Badge>Read only</Badge>}
            <button
              type="button"
              onClick={() => setPalette(true)}
              aria-label="Search"
              className="grid size-10 place-items-center rounded-full hover:bg-chip"
            >
              <IconSearch className="size-5" />
            </button>
          </div>
        </header>
        <header className="sticky top-10 z-30 hidden h-14 items-center gap-3 border-b border-border bg-nav px-6 backdrop-blur lg:flex lg:px-10 [.no-demo_&]:top-0">
          <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
            <ol className="flex min-w-0 items-center gap-1.5 text-[14px]">
              <li className="shrink-0 text-muted-foreground">
                <Link href="/dashboard" className="hover:text-foreground">
                  {business}
                </Link>
              </li>
              {crumbs.map(crumb => (
                <Fragment key={`${crumb.label}-${crumb.href}`}>
                  <li aria-hidden className="text-muted-foreground">
                    <IconChevronRight className="size-3.5" stroke={1.6} />
                  </li>
                  <li className="min-w-0 truncate">
                    {crumb.href ? (
                      <Link href={crumb.href} className="text-muted-foreground hover:text-foreground">
                        {crumb.label}
                      </Link>
                    ) : (
                      <span aria-current="page" className="font-medium">
                        {crumb.label}
                      </span>
                    )}
                  </li>
                </Fragment>
              ))}
            </ol>
          </nav>
          {readOnly && <Badge>Read only</Badge>}
          <button
            type="button"
            onClick={() => setPalette(true)}
            aria-keyshortcuts="Meta+K Control+K"
            className="flex h-9 w-60 items-center gap-2 rounded-xl border border-border bg-card px-3 text-[14px] text-muted-foreground hover:border-foreground/30"
          >
            <IconSearch className="size-4" />
            Search
            <kbd className="ml-auto rounded-md border border-border px-1.5 text-[12px]">⌘ K</kbd>
          </button>
        </header>
        <main className="mx-auto w-full max-w-[1240px] px-4 py-6 sm:px-6 lg:px-10 lg:py-9">{children}</main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} />
    </div>
  );
}
