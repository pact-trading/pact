import { configTheme, type PlaygroundConfig } from './config';

export type CodeTab = 'React' | 'Node server' | 'React Native' | 'curl';
export const codeTabs: CodeTab[] = ['React', 'Node server', 'React Native', 'curl'];

/** Playground switches the SDK cannot do yet; the code says so instead of pretending. */
export function previewOnly(config: PlaygroundConfig): string[] {
  const f = config.features;
  return [
    f.promo && 'promotion codes',
    f.tax && 'tax',
    f.upsell && 'product suggestions',
    f.phone && 'phone number',
    f.billing && 'billing address',
    f.shipping && 'shipping address',
  ].filter((item): item is string => Boolean(item));
}

const q = (value: string) => JSON.stringify(value);
const indent = (text: string, spaces: number) => text.replace(/\n/g, `\n${' '.repeat(spaces)}`);

/** Integration code that matches the Playground's settings. */
export function generatedCode(tab: CodeTab, config: PlaygroundConfig): string {
  const theme = configTheme(config);
  const brand = config.brandName || 'Your business';
  const label = config.buttonLabel.trim() || 'Continue to payment';
  const amount = q(config.amount);
  const appearance = JSON.stringify(
    {
      type: theme.type,
      colors: { primary: theme.colors.primary },
      radius: theme.radius,
      font: theme.font,
      brand: config.logo ? { name: brand, logo: 'https://your-site.example/logo.png' } : { name: brand },
    },
    null,
    2,
  );
  const methods = config.methods.map(method => (method === 'account' ? 'usdt' : method));
  const skipped = previewOnly(config);
  const comment = tab === 'curl' ? '#' : '//';
  const header = skipped.length
    ? `${comment} Preview only, not in the SDK yet: ${skipped.join(', ')}.\n`
    : '';
  const oneTime = config.type === 'one-time';

  const invoiceBody = {
    customerEmail: 'customer@example.com',
    lines: [{ description: 'Invoice INV-2026-001', quantity: 1, unitAmount: config.amount }],
    status: 'sent',
  };
  const planBody = { name: `${brand} monthly`, amount: config.amount, periodSeconds: 2592000 };
  const paymentBody = {
    amount: config.amount,
    currency: 'USDT',
    description: brand,
    email: 'customer@example.com',
  };

  /** Server-side creation for the configured payment type, and where the payer goes next. */
  const create =
    config.type === 'invoice'
      ? {
          code: `const invoice = await pact.invoices.create({
  customerEmail: 'customer@example.com',
  lines: [{ description: 'Invoice INV-2026-001', quantity: 1, unitAmount: ${amount} }],
  status: 'sent',
});`,
          url: 'invoice.hostedUrl',
        }
      : config.type === 'recurring'
        ? {
            code: `const plan = await pact.subscriptions.createPlan({
  name: ${q(`${brand} monthly`)},
  amount: ${amount},
  periodSeconds: 30 * 24 * 60 * 60,
});`,
            url: '`${process.env.PACT_CHECKOUT_URL}/subscribe/${plan.id}`',
          }
        : {
            code: `const payment = await pact.payments.create({
  amount: ${amount},
  currency: 'USDT',
  description: ${q(brand)},
  email: 'customer@example.com',
});`,
            url: 'payment.checkoutUrl',
          };

  const client = `import { createPactNodeClient } from '@pactagent/node';

// Keep the API key on your server.
const pact = createPactNodeClient({
  apiKey: process.env.PACT_API_KEY!,
  baseUrl: process.env.PACT_API_URL!,
});`;

  if (tab === 'Node server')
    return `${header}${client}

${create.code}
console.log(${create.url}); // send the payer here`;

  if (tab === 'curl') {
    const [path, body] =
      config.type === 'invoice'
        ? ['/v1/invoices', invoiceBody]
        : config.type === 'recurring'
          ? ['/v1/subscriptions/plans', planBody]
          : ['/v1/payments', paymentBody];
    return `${header}curl -X POST "$PACT_API_URL${path}" \\
  -H "Authorization: Bearer $PACT_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`;
  }

  if (tab === 'React Native') {
    if (!oneTime)
      return `${header}import { Linking, Pressable, Text } from 'react-native';

// PactCheckout takes one-time payments. For ${config.type === 'invoice' ? 'an invoice' : 'a subscription'}, your server
// creates it and returns the hosted page URL, which opens in the browser.
export function PayButton({ url }: { url: string }) {
  return (
    <Pressable accessibilityRole="button" onPress={() => Linking.openURL(url)}>
      <Text>{${q(label)}}</Text>
    </Pressable>
  );
}`;
    return `${header}import { PactCheckout } from '@pactagent/react-native';
import { PactClient, fetchTransport } from '@pactagent/core';

// Your server holds the API key and proxies these calls.
const client = new PactClient({ transport: fetchTransport('https://your-server.example/api/pact') });

const appearance = ${appearance};

export function MobileCheckout() {
  return (
    <PactCheckout
      client={client}
      returnUrl="myapp://checkout"
      amount=${amount}
      buttonLabel=${q(label)}
      appearance={appearance}
    />
  );
}`;
  }

  // React. The embedded widget takes one-time payments; the full page and other types redirect.
  if (config.embed === 'link' || !oneTime)
    return `${header}${
      config.embed !== 'link'
        ? '// The embedded widget takes one-time payments; this payment type opens the hosted page.\n'
        : ''
    }import { redirect } from 'next/navigation';
${client}

export async function startCheckout() {
  'use server';
  ${indent(create.code, 2)}
  redirect(${create.url});
}`;

  const slots = methods.some(method => method !== 'usdt')
    ? '\n// Card and bank are presentation slots until a provider is connected; payments settle in USDT.'
    : '';
  const widget = `<Checkout
  amount=${amount}
  buttonLabel=${q(label)}
  paymentMethods={${JSON.stringify(methods)}}
  appearance={appearance}
  showReceipt
  onSuccess={payment => console.log('paid', payment.id)}
/>`;
  if (config.embed === 'inline')
    return `${header}import { Checkout } from '@pactagent/checkout-react';
${slots}
const appearance = ${appearance};

export function OrderPage() {
  return (
    ${indent(widget, 4)}
  );
}`;
  return `'use client';
${header}import { useState } from 'react';
import { Checkout } from '@pactagent/checkout-react';
${slots}
const appearance = ${appearance};

export function BuyButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Buy now</button>
      {open && (
        <dialog open aria-label="Checkout">
          ${indent(widget, 10)}
          <button onClick={() => setOpen(false)}>Close</button>
        </dialog>
      )}
    </>
  );
}`;
}
