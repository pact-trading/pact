import Link from 'next/link';
import { IconArrowRight, IconBolt, IconReceiptRefund, IconRobot, IconShieldCheck } from '@tabler/icons-react';
import { PactLogo } from '@/components/brand/pact-logo';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { Button } from '@/components/ui/button';
import { CodeBlock } from '@/components/ui/code-block';
import { isMock } from '@/server/mode';

const snippet = `import { Checkout } from '@pactagent/checkout-react';

export function Buy({ order }) {
  return (
    <Checkout
      amount={order.total}        // dollars; USDT underneath
      apiBaseUrl="/api/pact"      // your server route holds the key
      onSuccess={payment => showThanks(payment.id)}
    />
  );
}

// server: fulfil only from the signed webhook
app.post('/webhooks/pact', async req => {
  if (!(await verifyWebhook(req.body, req.headers['x-settle-signature'], secret))) return;
  const event = JSON.parse(req.body);
  if (event.type === 'order.paid') fulfil(event.order);
});`;

const points = [
  {
    icon: IconBolt,
    title: 'Customers never see crypto',
    body: 'Email or passkey sign-in, amounts in dollars, one confirmation. No wallet install, no network names, no gas.',
  },
  {
    icon: IconReceiptRefund,
    title: 'Everything after the first payment',
    body: 'One-click full and partial refunds, capped subscriptions with cancel anytime, invoices with reminders, signed webhooks and an accountant-ready export.',
  },
  {
    icon: IconRobot,
    title: 'Software can pay software',
    body: 'AI agents pay per request over x402 in USDT, inside per-call and daily caps their owner sets.',
  },
  {
    icon: IconShieldCheck,
    title: 'Gas paid by the business, safely',
    body: 'Each merchant funds its own gas tank. Eight layered limits, five of them in the contracts, stop anyone draining it.',
  },
];

export default function Home() {
  return (
    <div className="min-h-dvh">
      <header className="mx-auto flex max-w-6xl items-center gap-3 px-5 pt-6">
        <PactLogo width={96} />
        <nav className="ml-auto flex items-center gap-1">
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <a href="/playground">Playground</a>
          </Button>
          <ThemeToggle />
          <Button asChild variant="dark" size="sm">
            <Link href={isMock ? '/demo' : '/login'}>{isMock ? 'Open the demo' : 'Sign in'}</Link>
          </Button>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-5">
        <section className="pt-16 pb-14 text-center sm:pt-24">
          <p className="text-sm font-medium text-muted-foreground">
            Whitechain Sepolia testnet · official test USDT
          </p>
          <h1 className="mx-auto mt-3 max-w-3xl text-[40px] leading-[1.05] font-semibold sm:text-6xl">
            Get paid in USDT. Your customers just pay.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-lg text-muted-foreground">
            Checkout, payment links, invoices, subscriptions and agent payments for businesses on Whitechain,
            with gas paid by you and zero crypto steps for the people paying you.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Button asChild variant="primary" size="lg">
              <Link href={isMock ? '/demo' : '/dashboard'}>
                {isMock ? 'Explore every viewpoint' : 'Open the dashboard'}{' '}
                <IconArrowRight className="size-4.5" />
              </Link>
            </Button>
            <Button asChild size="lg">
              <a href="/playground">Customise the checkout</a>
            </Button>
          </div>
        </section>
        <section className="grid items-start gap-6 lg:grid-cols-[1.15fr_1fr]">
          <CodeBlock code={snippet} title="Add checkout in under 20 lines" />
          <div className="grid gap-3">
            {points.map(point => (
              <div key={point.title} className="flex gap-4 rounded-2xl border border-border bg-card p-5">
                <point.icon className="mt-0.5 size-5 shrink-0" stroke={1.6} />
                <div>
                  <h2 className="font-semibold">{point.title}</h2>
                  <p className="mt-1 text-[15px] text-muted-foreground">{point.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
        <p className="py-14 text-center text-[13px] text-muted-foreground">
          Testnet software. Contracts are verified on the Whitechain explorer. No real funds are involved.
        </p>
      </main>
    </div>
  );
}
