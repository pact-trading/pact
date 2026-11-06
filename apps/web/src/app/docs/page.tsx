import type { Metadata } from 'next';
import Link from 'next/link';
import {
  IconArrowRight,
  IconBuildingStore,
  IconCode,
  IconLink,
  IconPlayerPlay,
  type Icon,
} from '@tabler/icons-react';
import { PactLogo } from '@/components/brand/pact-logo';
import { CodeTabs } from '@/components/merchant/integration/code-tabs';
import { packages, webhookHandler, type SnippetContext } from '@/components/merchant/integration/snippets';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CodeBlock } from '@/components/ui/code-block';
import { isMock } from '@/server/mode';
import { publicOrigin } from '@/server/origin';

export const metadata: Metadata = { title: 'Quickstart' };

const steps = [
  { id: 'install', title: 'Install' },
  { id: 'checkout', title: 'Create a checkout' },
  { id: 'webhook', title: 'Handle the webhook' },
  { id: 'test', title: 'Test it' },
] as const;

function Step({
  index,
  id,
  title,
  children,
}: {
  index: number;
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="grid gap-4 sm:grid-cols-[2.5rem_minmax(0,1fr)]"
    >
      <span
        aria-hidden
        className="grid size-9 place-items-center rounded-full bg-foreground text-sm font-semibold text-background"
      >
        {index}
      </span>
      <div className="grid min-w-0 gap-4">
        <h2 id={`${id}-title`} className="text-xl font-semibold">
          <span className="sr-only">Step {index}: </span>
          {title}
        </h2>
        {children}
      </div>
    </section>
  );
}

function Next({ href, icon: Glyph, title, body }: { href: string; icon: Icon; title: string; body: string }) {
  return (
    <Link
      href={href}
      className="group flex items-start gap-3 rounded-2xl border border-border bg-card p-5 shadow-panel transition-colors hover:border-foreground/30"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-chip">
        <Glyph className="size-5" />
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1 font-semibold">
          {title}
          <IconArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
        </span>
        <span className="mt-0.5 block text-sm text-muted-foreground">{body}</span>
      </span>
    </Link>
  );
}

/** Public quickstart: install, create a checkout, handle the webhook, test. */
export default async function DocsPage() {
  const origin = await publicOrigin();
  const context: SnippetContext = {
    origin,
    amount: '490.00',
    description: 'Website audit',
    productId: 'prod_audit',
  };
  return (
    <div className="min-h-[calc(100dvh-2.5rem)] [.no-demo_&]:min-h-dvh">
      <header className="mx-auto flex max-w-4xl items-center gap-3 px-5 pt-6">
        <Link href="/" aria-label="Pact home">
          <PactLogo width={96} />
        </Link>
        <nav aria-label="Docs" className="ml-auto flex items-center gap-1">
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link href="/playground">Playground</Link>
          </Button>
          <ThemeToggle />
          <Button asChild variant="dark" size="sm">
            <Link href="/dashboard/developers">Integration</Link>
          </Button>
        </nav>
      </header>
      <main className="mx-auto max-w-4xl px-5 pt-12 pb-16">
        <p className="text-sm font-medium text-muted-foreground">Docs</p>
        <h1 className="mt-1 text-[34px] leading-tight font-semibold sm:text-5xl">Quickstart</h1>
        <p className="mt-3 max-w-2xl text-[17px] text-muted-foreground">
          Take your first USDT payment in four steps. Customers pay in dollars with a passkey and never pay gas;
          Pact’s fee comes out of the payment; your server fulfils from a signed webhook.
        </p>
        <nav aria-label="Steps" className="mt-6 flex flex-wrap gap-1.5">
          {steps.map((step, index) => (
            <a
              key={step.id}
              href={`#${step.id}`}
              className="rounded-full bg-chip px-3 py-1 text-sm font-medium text-subtle-foreground hover:text-foreground"
            >
              {index + 1}. {step.title}
            </a>
          ))}
        </nav>

        <div className="mt-12 grid gap-14">
          <Step index={1} id="install" title="Install">
            <p className="text-[15px] text-subtle-foreground">
              Add the server client, and the widget if you check out on a React page. Create a secret key
              under{' '}
              <Link
                href="/dashboard/developers?tab=keys"
                className="font-medium underline underline-offset-4"
              >
                Integration · API keys
              </Link>{' '}
              and set it on your server with the API address. Sign Pact’s fee terms once on the{' '}
              <Link href="/dashboard/fees" className="font-medium underline underline-offset-4">
                Fees
              </Link>{' '}
              page: until you do, payments to you are refused.
            </p>
            <CodeBlock title="terminal" code="pnpm add @pactagent/node @pactagent/checkout-react" />
            <CodeBlock
              title=".env · your server only"
              code={`PACT_API_URL=https://api.example.com\nPACT_SECRET_KEY=sk_test_…\nPACT_WEBHOOK_SECRET=whsec_…`}
            />
            <ul className="grid gap-2 sm:grid-cols-2">
              {packages.map(item => (
                <li key={item.name} className="rounded-xl border border-border px-4 py-2.5">
                  <code className="font-mono text-[13px] font-semibold">{item.name}</code>
                  <p className="text-[13px] text-muted-foreground">{item.use}</p>
                </li>
              ))}
            </ul>
          </Step>

          <Step index={2} id="checkout" title="Create a checkout">
            <p className="text-[15px] text-subtle-foreground">
              Create the payment on your server for the amount you charge, then send the customer to its
              checkout. The same order in each stack:
            </p>
            <CodeTabs context={context} initial="Node server" showInstall={false} />
            <p className="text-[15px] text-subtle-foreground">
              No code at all? Share a hosted checkout from{' '}
              <Link href="/dashboard/payment-links" className="font-medium underline underline-offset-4">
                payment links
              </Link>
              , or link a product page such as{' '}
              <code className="font-mono text-[13px]">{origin}/buy/prod_audit</code>.
            </p>
          </Step>

          <Step index={3} id="webhook" title="Handle the webhook">
            <p className="text-[15px] text-subtle-foreground">
              Pact signs every event with your webhook secret and retries with backoff until you answer 2xx.
              Fulfil from <code className="font-mono text-[13px]">order.paid</code>, never from the browser
              redirect.
            </p>
            <CodeBlock title="webhooks.ts · @pactagent/node" code={webhookHandler} />
            <ul className="grid gap-1.5 text-[15px] text-subtle-foreground">
              <li>
                Verify the raw body against the{' '}
                <code className="font-mono text-[13px]">x-settle-signature</code> header before you parse it.
              </li>
              <li>
                Record each event id: a retry or replay sends the same id again, so a duplicate is a no-op.
              </li>
              <li>Fulfil each order once, even if two different events mention it.</li>
            </ul>
          </Step>

          <Step index={4} id="test" title="Test it">
            <p className="text-[15px] text-subtle-foreground">
              Everything runs on Whitechain Sepolia with test USDT. Send a test event from Integration ·
              Webhooks, try the checkout’s look in the Playground
              {isMock ? ', and buy on the demo store to watch the webhook fulfil an order once' : ''}.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Next
                href="/playground"
                icon={IconPlayerPlay}
                title="Playground"
                body="Tune the checkout’s colours, radius and copy, then copy the code."
              />
              <Next
                href="/dashboard/developers"
                icon={IconCode}
                title="Integration"
                body="API keys, webhook endpoint, event log and code for your stack."
              />
              <Next
                href="/dashboard/payment-links"
                icon={IconLink}
                title="Payment links"
                body="Hosted checkouts to share without writing code."
              />
              {isMock && (
                <Next
                  href="/demo/store"
                  icon={IconBuildingStore}
                  title="Demo store"
                  body="A separate store that integrates Pact. Buy, then watch the webhook."
                />
              )}
            </div>
          </Step>
        </div>
        <Card className="mt-14 p-5 text-sm text-subtle-foreground">
          Package and environment names match <code className="font-mono">packages/</code> and{' '}
          <code className="font-mono">examples/merchant-store</code> in the repository.
        </Card>
      </main>
    </div>
  );
}
