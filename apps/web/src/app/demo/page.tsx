import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import {
  IconBuildingBank,
  IconBuildingStore,
  IconCalculator,
  IconRobot,
  IconShieldBolt,
  IconShieldCheck,
  IconShoppingCart,
  IconUserCircle,
  type Icon,
} from '@tabler/icons-react';
import type { ViewerRole } from '@pactagent/core/platform-types';
import { PactLogo } from '@/components/brand/pact-logo';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { chooseViewer } from '@/server/actions/demo';
import { DEMO } from '@/server/data/mock/fixtures';
import { isMock } from '@/server/mode';

export const metadata: Metadata = { title: 'Demo viewpoints' };
export const dynamic = 'force-dynamic';

const views: Array<{
  role: ViewerRole;
  next: string;
  icon: Icon;
  title: string;
  who: string;
  body: string;
  track: string;
}> = [
  {
    role: 'merchant',
    next: '/dashboard',
    icon: IconBuildingStore,
    title: 'Merchant',
    who: 'Maya Chen · Kite Labs',
    body: 'Products, orders and one-click refunds, invoices, capped subscriptions, fees and exports.',
    track: 'Operate',
  },
  {
    role: 'customer',
    next: `/buy/${DEMO.productId}`,
    icon: IconShoppingCart,
    title: 'Customer at checkout',
    who: 'Jordan Lee · Acme Robotics',
    body: 'Pay a one-off order with email or passkey: dollars only, no wallet, no fees, no network names.',
    track: 'Scale',
  },
  {
    role: 'customer',
    next: '/portal',
    icon: IconUserCircle,
    title: 'Customer portal',
    who: 'Jordan Lee · Acme Robotics',
    body: 'Receipts and refunds, subscriptions with cancel anytime, invoices to acknowledge and pay.',
    track: 'Operate',
  },
  {
    role: 'customer',
    next: `/portal/agents/${DEMO.agentId}`,
    icon: IconRobot,
    title: 'AI agent',
    who: 'Acme’s research agent',
    body: 'The agent calls Kite Labs’ paid API over x402 at $0.01 a call, inside limits its owner set. The 11th call is refused.',
    track: 'Scale',
  },
  {
    role: 'merchant',
    next: '/dashboard/security',
    icon: IconShieldBolt,
    title: 'Attacker',
    who: 'A script against the relayer',
    body: 'Replays, dust, arbitrary calldata and 50 fresh accounts try to make Pact pay for junk or spend the merchant’s USDT. Every attempt is refused.',
    track: 'Scale',
  },
  {
    role: 'accountant',
    next: '/dashboard/exports',
    icon: IconCalculator,
    title: 'Accountant',
    who: 'Priya Nair · Kite Labs books',
    body: 'A read-only view: export every payment, refund and fee, gross and net, and check one row on the explorer.',
    track: 'Operate',
  },
  {
    role: 'investor',
    next: '/investor',
    icon: IconBuildingBank,
    title: 'Investor',
    who: 'Arjun Mehta · Lotus Capital',
    body: 'Buy all or part of Kite Labs invoices at a discount. The customer’s payment comes straight to you; a reserve and a buy-back stand behind it.',
    track: 'Tokenize',
  },
  {
    role: 'compliance',
    next: '/compliance',
    icon: IconShieldCheck,
    title: 'Compliance',
    who: 'Elena Novak · Pact compliance',
    body: 'Approve or revoke investors in the registry the receivable token checks. Purchases and transfers by anyone else are refused.',
    track: 'Tokenize',
  },
];

const sideOf = (path: string): ViewerRole =>
  path === '/investor' || path.startsWith('/investor/')
    ? 'investor'
    : path === '/compliance' || path.startsWith('/compliance/')
      ? 'compliance'
      : path === '/dashboard' || path.startsWith('/dashboard/')
        ? 'merchant'
        : 'customer';

/** Where a tile continues to: a `next` from a guarded page applies to the side it belongs to. */
function target(view: (typeof views)[number], next: string | undefined) {
  if (!next) return view.next;
  const side = sideOf(next);
  if (side === 'merchant') return view.role === 'merchant' || view.role === 'accountant' ? next : view.next;
  return side === view.role ? next : view.next;
}

export default async function DemoPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (!isMock) redirect('/login');
  const { next } = await searchParams;
  return (
    <div className="min-h-[calc(100dvh-2.5rem)]">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 pt-6">
        <PactLogo width={96} />
        <ThemeToggle />
      </header>
      <main className="mx-auto max-w-6xl px-5 pt-12 pb-16 sm:pt-16">
        <p className="text-sm font-medium text-muted-foreground">
          ETHGlobal Mumbai · Whitechain Operate, Scale and Tokenize
        </p>
        <h1 className="mt-2 max-w-3xl text-[34px] leading-[1.08] font-semibold sm:text-5xl">
          One business, every side of the payment.
        </h1>
        <p className="mt-4 max-w-2xl text-[17px] text-muted-foreground">
          Kite Labs is a software studio with an API product. Pick who you want to be. Every screen runs on
          mock data shaped like the real API, with the same limits the contracts enforce.
        </p>
        {next && (
          <p className="mt-4 inline-flex rounded-full bg-chip px-3 py-1 text-sm">
            Choose a viewpoint to continue to {next}
          </p>
        )}
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {views.map(view => (
            <form key={view.title} action={chooseViewer.bind(null, view.role, target(view, next))}>
              <button
                type="submit"
                className="group flex h-full w-full flex-col rounded-3xl border border-border bg-card p-6 text-left shadow-panel transition-[border-color,transform] hover:-translate-y-0.5 hover:border-foreground/30"
              >
                <div className="flex items-center justify-between">
                  <span className="grid size-11 place-items-center rounded-2xl bg-chip text-foreground [&_svg]:size-5.5">
                    <view.icon stroke={1.6} />
                  </span>
                  <span className="rounded-full border border-border px-2.5 py-0.5 text-[12px] font-medium text-muted-foreground">
                    {view.track}
                  </span>
                </div>
                <h2 className="mt-5 text-xl font-semibold">{view.title}</h2>
                <p className="text-sm text-muted-foreground">{view.who}</p>
                <p className="mt-3 flex-1 text-[15px] text-subtle-foreground">{view.body}</p>
                <span className="mt-5 text-sm font-semibold underline-offset-4 group-hover:underline">
                  Continue as {view.title.toLowerCase()} →
                </span>
              </button>
            </form>
          ))}
        </div>
        <section className="mt-14 rounded-3xl border border-border bg-card p-6 sm:p-8">
          <h2 className="text-lg font-semibold">The story, in order</h2>
          <ol className="mt-4 grid gap-3 text-[15px] text-subtle-foreground sm:grid-cols-2">
            {[
              'Merchant: set up checkout and sign Pact’s fee terms once.',
              'Customer: buy the website audit and subscribe to API Growth, with no crypto steps.',
              'Merchant: refund part of the audit; the customer sees it with its public record.',
              'Merchant: try an early renewal; the contract refuses it with a reason. Customer: cancel in one click.',
              'AI agent: ten paid API calls settle in USDT; the eleventh is refused over the daily cap.',
              'Customer: acknowledge invoice INV-1042, then move the clock 30 days and pay it.',
              'Attacker: run the drain simulation; every attempt is refused and the merchant’s USDT does not move.',
              'Merchant: request financing for INV-1060. Investor: buy it; the advance arrives less a reserve.',
              'Investor: try to transfer a claim to Northgate Fund; the contract refuses, it is not approved.',
              'Merchant: make Northwind pay INV-1060; the payment goes straight to the investor and the reserve comes back.',
              'Merchant: move the clock 7 days; INV-1051 defaults, the token freezes, then buy it back.',
              'Accountant: export the ledger; it reconciles to the onchain balance change.',
            ].map((step, i) => (
              <li key={step} className="flex gap-3">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-chip text-[13px] font-semibold text-foreground">
                  {i + 1}
                </span>
                {step}
              </li>
            ))}
          </ol>
          <p className="mt-6 text-[13px] text-muted-foreground">
            All records, addresses and transaction hashes are synthetic. The demo clock can be moved forward
            from the bar at the top; it is labelled whenever it is ahead of real time.
          </p>
        </section>
      </main>
    </div>
  );
}
