import type { Metadata } from 'next';
import { LiveSetupCard } from '@/components/merchant/live/live-setup';
import Link from 'next/link';
import { IconCircleCheckFilled } from '@tabler/icons-react';
import { FeeSetup } from '@/components/merchant/fees/fee-setup';
import { BrandQuickForm } from '@/components/merchant/settings-form';
import { NotConnected } from '@/components/states/not-connected';
import { Button } from '@/components/ui/button';
import { Card, CardBody } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { cn } from '@/lib/cn';
import { shortHash } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Set up' };

export default async function OnboardingPage() {
  const data = await getData();
  const [overview, fees, products, settings, viewer] = await Promise.all([
    load(() => data.merchant.overview()),
    load(() => data.merchant.fees()),
    load(() => data.merchant.products()),
    load(() => data.merchant.settings()),
    getViewer(),
  ]);
  if (isNotWired(overview)) return <NotConnected feature={overview.feature} />;
  const readOnly = viewer?.role !== 'merchant';
  const done = overview.onboarding.filter(step => step.done).length;
  const total = overview.onboarding.length;
  const firstProduct = isNotWired(products) ? null : products.find(p => p.status === 'active');
  const action: Record<string, React.ReactNode> = {
    account: (
      <p className="text-sm text-muted-foreground">
        {data.mode === 'api'
          ? `Signed in with your wallet${isNotWired(settings) ? '' : ` (${shortHash(settings.payoutAddress)})`}. It receives your payments and only ever signs: it needs no WBT.`
          : `Signed in with a passkey. Your payout account${isNotWired(settings) ? '' : ` (${shortHash(settings.payoutAddress)})`} was created for you; there is no seed phrase to write down.`}
      </p>
    ),
    brand: (
      <div className="grid gap-2">
        {!readOnly && !isNotWired(settings) && (
          <BrandQuickForm key={`${settings.brandName}|${settings.logoUrl}`} settings={settings} />
        )}
        <Link
          href="/dashboard/settings"
          className="justify-self-start text-sm font-medium underline-offset-4 hover:underline"
        >
          Colour and refund window are in settings
        </Link>
      </div>
    ),
    fees: isNotWired(fees) ? null : (
      <div className="grid gap-2">
        <FeeSetup fees={fees} readOnly={readOnly} />
        <Link
          href="/dashboard/fees"
          className="justify-self-start text-sm font-medium underline-offset-4 hover:underline"
        >
          See your rates and every fee taken
        </Link>
      </div>
    ),
    integrate: (
      <Button asChild size="sm">
        <Link href="/dashboard/developers">See the 20-line integration</Link>
      </Button>
    ),
    test_payment: firstProduct ? (
      <Button asChild size="sm">
        <a href={`/buy/${firstProduct.id}`} target="_blank" rel="noreferrer">
          Open the {firstProduct.name} checkout
        </a>
      </Button>
    ) : null,
  };
  const body: Record<string, string> = {
    account: 'Merchants and customers sign in with email or a passkey.',
    brand: 'Your name and logo appear on checkout, receipts and invoices.',
    fees: 'Pact takes 0.8% of each checkout payment (at least 0.15 USDT) and 0.5% of each invoice (at most 10 USDT), out of the payment. Sign the terms once, then two refund permits. Nobody needs WBT.',
    integrate: 'Add a hosted link, the React widget or the server SDK to your store.',
    test_payment: 'Pay once as a customer to see the whole flow end to end.',
  };
  return (
    <>
      <PageHeader
        back={{ href: '/dashboard', label: 'Overview' }}
        title={`Set up ${isNotWired(settings) ? 'your workspace' : settings.brandName}`}
        description="From sign-up to a working checkout in about three minutes."
      />
      {!readOnly && (
        <div className="mb-6">
          <LiveSetupCard />
        </div>
      )}
      <div className="mb-5 grid gap-2">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">
            {done} of {total} done
          </span>
          {done === total && <span className="text-success">Ready to take payments</span>}
        </div>
        <div
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          className="h-2 overflow-hidden rounded-full bg-chip"
        >
          <div
            className="h-full rounded-full bg-success transition-[width]"
            style={{ width: `${(done / Math.max(total, 1)) * 100}%` }}
          />
        </div>
      </div>
      <ol className="grid gap-3">
        {overview.onboarding.map((step, index) => (
          <li key={step.id}>
            <Card className={cn(step.done && 'bg-raised shadow-none')}>
              <CardBody className="flex flex-wrap items-start gap-4">
                <span
                  className={cn(
                    'grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold',
                    step.done ? 'text-success' : 'bg-foreground text-background',
                  )}
                >
                  {step.done ? <IconCircleCheckFilled className="size-7" /> : index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="font-semibold">{step.title}</h2>
                  <p className="text-sm text-muted-foreground">{body[step.id]}</p>
                  <div className="mt-3">{action[step.id]}</div>
                </div>
              </CardBody>
            </Card>
          </li>
        ))}
      </ol>
    </>
  );
}
