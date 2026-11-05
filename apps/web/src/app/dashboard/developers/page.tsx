import type { Metadata } from 'next';
import Link from 'next/link';
import { IconArrowUpRight, IconBook, IconLink, IconPlayerPlay, IconPlus } from '@tabler/icons-react';
import { ApiKeys } from '@/components/merchant/developers/api-keys';
import { Webhooks } from '@/components/merchant/developers/webhooks';
import { CodeTabs } from '@/components/merchant/integration/code-tabs';
import { GetCode } from '@/components/merchant/integration/get-code';
import {
  hostedLink,
  packages,
  paymentLinkSnippet,
  snippet,
  storeDiff,
  webhookHandler,
  type SnippetContext,
} from '@/components/merchant/integration/snippets';
import { NotConnected } from '@/components/states/not-connected';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CodeBlock } from '@/components/ui/code-block';
import { CopyButton } from '@/components/ui/copy-button';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { LinkTabs } from '@/components/ui/tabs';
import { fromMinor } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { publicOrigin } from '@/server/origin';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Integration' };

const tabs = [
  { value: 'react', label: 'React widget', href: '/dashboard/developers' },
  { value: 'sdk', label: 'SDK', href: '/dashboard/developers?tab=sdk' },
  { value: 'link', label: 'Payment link', href: '/dashboard/developers?tab=link' },
  { value: 'keys', label: 'API keys', href: '/dashboard/developers?tab=keys' },
  { value: 'webhooks', label: 'Webhooks', href: '/dashboard/developers?tab=webhooks' },
];

export default async function DevelopersPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: requested } = await searchParams;
  const tab = tabs.some(item => item.value === requested) ? requested! : 'react';
  const data = await getData();
  const [viewer, origin, products] = await Promise.all([
    getViewer(),
    publicOrigin(),
    load(() => data.merchant.products()),
  ]);
  const readOnly = viewer?.role !== 'merchant';
  // Snippets use a real product from the catalogue when there is one.
  const product = isNotWired(products) ? undefined : products.find(p => p.status === 'active');
  const context: SnippetContext = {
    origin,
    amount: product ? fromMinor(product.prices[0].amountMinor) : '25.00',
    description: product?.name ?? 'Order 1042',
    productId: product?.id ?? 'prod_your_product',
  };

  let body: React.ReactNode;
  if (tab === 'keys') {
    const keys = await load(() => data.merchant.apiKeys());
    body = isNotWired(keys) ? (
      <NotConnected feature={keys.feature} />
    ) : (
      <ApiKeys keys={keys} readOnly={readOnly} />
    );
  } else if (tab === 'webhooks') {
    const [config, events, deliveries, receipts] = await Promise.all([
      load(() => data.merchant.webhook()),
      load(() => data.merchant.webhookEvents()),
      load(() => data.merchant.webhookDeliveries()),
      data.lab ? data.lab.webhookReceipts() : Promise.resolve(null),
    ]);
    body =
      isNotWired(config) || isNotWired(events) || isNotWired(deliveries) ? (
        <NotConnected feature="Webhooks" />
      ) : (
        <div className="grid gap-6">
          <Webhooks
            config={config}
            events={events}
            deliveries={deliveries}
            readOnly={readOnly}
            lab={receipts ? { receipts } : null}
          />
          <CodeBlock title="Handle the webhook · @pactagent/node" code={webhookHandler} />
        </div>
      );
  } else if (tab === 'sdk') {
    body = (
      <div className="grid gap-6">
        <Card>
          <CardHeader
            title="SDK"
            description="Create payments from your server, or check out from a mobile app. Every version charges the same order."
          />
          <CardBody>
            <CodeTabs context={context} initial="Node server" />
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Integrate in under 20 lines"
            description="The exact change to the independent demo store in examples/merchant-store: a hosted checkout link and a signed webhook."
          />
          <CardBody>
            <CodeBlock title="merchant-store · 9 lines added" code={storeDiff(origin)} diff />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Packages" />
          <ul className="divide-y divide-border-subtle">
            {packages.map(item => (
              <li key={item.name} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                <code className="font-mono text-[13px] font-semibold">{item.name}</code>
                <span className="text-sm text-muted-foreground">{item.use}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    );
  } else if (tab === 'link') {
    const link = hostedLink(context);
    body = (
      <div className="grid gap-6">
        <Card>
          <CardHeader
            title="Payment link"
            description="No code: share a hosted checkout by link or QR code. Product, tip jar and subscription links all pay through the same checkout."
            action={
              <>
                <Button asChild size="sm">
                  <Link href="/dashboard/payment-links">
                    <IconLink className="size-4" />
                    Payment links
                  </Link>
                </Button>
                {!readOnly && (
                  <Button asChild size="sm" variant="primary">
                    <Link href="/dashboard/payment-links/new">
                      <IconPlus className="size-4" />
                      New payment link
                    </Link>
                  </Button>
                )}
              </>
            }
          />
          <CardBody className="grid gap-4">
            {product ? (
              <div className="grid gap-1.5">
                <p className="text-sm font-medium">Hosted checkout for {product.name}</p>
                <div className="flex min-w-0 items-center gap-2 rounded-[14px] border border-input bg-raised py-1 pr-1 pl-3.5">
                  <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{link}</code>
                  <CopyButton value={link} label="Copy link" />
                  <Button asChild size="sm" variant="ghost">
                    <a href={`/buy/${product.id}`} target="_blank" rel="noreferrer">
                      Open
                      <IconArrowUpRight className="size-4" />
                    </a>
                  </Button>
                </div>
              </div>
            ) : (
              <Notice>Add an active product to get its hosted checkout link.</Notice>
            )}
            <CodeBlock
              title="Create a link from your server · @pactagent/node"
              code={paymentLinkSnippet(context)}
            />
          </CardBody>
        </Card>
      </div>
    );
  } else {
    body = (
      <div className="grid gap-6">
        <Card>
          <CardHeader
            title="React widget"
            description="Drop the checkout into any page. Try its appearance in the Playground first."
            action={
              <Button asChild size="sm">
                <Link href="/playground">
                  <IconPlayerPlay className="size-4" />
                  Playground
                </Link>
              </Button>
            }
          />
          <CardBody className="grid gap-4">
            <CodeBlock title="Install" code="pnpm add @pactagent/checkout-react" />
            <CodeBlock title="checkout.tsx · @pactagent/checkout-react" code={snippet('React', context)} />
            <p className="text-sm text-subtle-foreground">
              <code>apiBaseUrl</code> points at a route on your own server that calls Pact with your secret
              key, so the key never reaches the browser.
            </p>
          </CardBody>
        </Card>
        <Notice tone="shield" title="Fulfil from the webhook">
          Mark an order paid only from the signed <code>order.paid</code> or <code>payment.captured</code>{' '}
          webhook, never from a browser redirect. See the Webhooks tab.
        </Notice>
      </div>
    );
  }
  return (
    <>
      <PageHeader
        title="Integration"
        description="Everything a separate app needs to accept USDT on Whitechain: a widget, SDKs, links, keys and webhooks."
        actions={
          <>
            <Button asChild variant="ghost">
              <Link href="/docs">
                <IconBook className="size-4.5" />
                Quickstart
              </Link>
            </Button>
            <GetCode context={context} />
          </>
        }
      />
      <LinkTabs label="Integration" active={tab} items={tabs} />
      {body}
    </>
  );
}
