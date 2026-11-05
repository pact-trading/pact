/**
 * Integration snippets. Package names are the ones in packages/<name>/package.json and the
 * environment names come from examples/merchant-store, examples/expo-store and apps/web/example.env.
 */

export type CodeLanguage = 'React' | 'Node server' | 'React Native' | 'curl';
export const codeLanguages: CodeLanguage[] = ['React', 'Node server', 'React Native', 'curl'];

export interface SnippetContext {
  /** Where this Pact app is served, for hosted checkout links. */
  origin: string;
  /** Decimal dollars, e.g. "490.00". */
  amount: string;
  description: string;
  productId: string;
}

export const packages = [
  { name: '@pactagent/checkout-react', use: 'React checkout widget' },
  { name: '@pactagent/node', use: 'Server client, keeps the secret key' },
  { name: '@pactagent/react-native', use: 'Expo and React Native checkout' },
  { name: '@pactagent/core', use: 'Types, client, webhook verification' },
] as const;

export const install: Record<CodeLanguage, string> = {
  React: 'pnpm add @pactagent/checkout-react',
  'Node server': 'pnpm add @pactagent/node',
  'React Native': 'pnpm add @pactagent/react-native @pactagent/core',
  curl: '# No package needed: call the API with your secret key.',
};

export const fileName: Record<CodeLanguage, string> = {
  React: 'checkout.tsx · @pactagent/checkout-react',
  'Node server': 'server.ts · @pactagent/node',
  'React Native': 'BuyScreen.tsx · @pactagent/react-native',
  curl: 'terminal',
};

const q = (value: string) => JSON.stringify(value);

export function snippet(language: CodeLanguage, ctx: SnippetContext): string {
  const label = `Pay for ${ctx.description}`;
  switch (language) {
    case 'React':
      return `import { Checkout } from '@pactagent/checkout-react';

export function Buy() {
  return (
    <Checkout
      amount=${q(ctx.amount)}             // dollars; settled in USDT
      apiBaseUrl="/api/pact"      // your server route; it holds the secret key
      buttonLabel=${q(label)}
      onSuccess={payment => console.log('Paid', payment.id)}
    />
  );
}`;
    case 'Node server':
      return `import { createPactNodeClient } from '@pactagent/node';

// Keep the secret key on your server.
const pact = createPactNodeClient({
  apiKey: process.env.PACT_SECRET_KEY!,
  baseUrl: process.env.PACT_API_URL!,
});

const payment = await pact.payments.create(
  { amount: ${q(ctx.amount)}, description: ${q(ctx.description)} },
  { idempotencyKey: 'order-1042' }, // a retry never charges twice
);
// Send the customer to payment.checkoutUrl. Fulfil from the webhook, not the redirect.`;
    case 'React Native':
      return `import * as Linking from 'expo-linking';
import { PactClient, fetchTransport } from '@pactagent/core';
import { PactCheckout } from '@pactagent/react-native';

// Your server proxies Pact with the secret key; the app never holds it.
const client = new PactClient({
  transport: fetchTransport(process.env.EXPO_PUBLIC_PACT_PROXY_URL!),
});

export function BuyScreen() {
  return (
    <PactCheckout
      client={client}
      amount=${q(ctx.amount)}
      buttonLabel=${q(label)}
      returnUrl={Linking.createURL('payment-return')}
      onSuccess={payment => console.log('Paid', payment.id)}
    />
  );
}`;
    case 'curl':
      return `curl -X POST "$PACT_API_URL/v1/payments" \\
  -H "Authorization: Bearer $PACT_SECRET_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-1042" \\
  -d '${JSON.stringify({ amount: ctx.amount, description: ctx.description })}'`;
  }
}

/** The webhook handler, shaped like examples/merchant-store/fulfillment.ts. */
export const webhookHandler = `import { verifyWebhook } from '@pactagent/node';

// POST /webhooks/pact. Verify the raw body before parsing it.
export async function onPactWebhook(raw: string, headers: Headers) {
  const signature = headers.get('x-settle-signature') ?? '';
  if (!(await verifyWebhook(raw, signature, process.env.PACT_WEBHOOK_SECRET!))) return 401;

  const event = JSON.parse(raw);
  // Pact retries until you answer 2xx, so the same event id can arrive twice.
  if (await alreadyHandled(event.id)) return 200;
  if (event.type === 'order.paid') await fulfil(event.object_id); // once per order
  await markHandled(event.id);
  return 200;
}`;

/** The hosted link a product page shares. */
export const hostedLink = (ctx: SnippetContext) => `${ctx.origin}/buy/${ctx.productId}`;

export const paymentLinkSnippet = (ctx: SnippetContext) => `const link = await pact.paymentLinks.create({
  kind: 'product',
  name: ${q(ctx.description)},
  amount: ${q(ctx.amount)},
});
console.log(link.url); // share it, or print it as a QR code`;

/** The change to the independent demo store in examples/merchant-store. */
export const storeDiff = (origin: string) => `  // examples/merchant-store/app/webhooks/pact/route.ts
+ export async function POST(request: Request) {
+   const raw = await request.text();
+   const signature = request.headers.get('x-settle-signature') ?? '';
+   if (!(await verifyWebhook(raw, signature, process.env.PACT_WEBHOOK_SECRET!))) return new Response(null, { status: 401 });
+   const event = JSON.parse(raw);
+   if (event.type === 'order.paid') await fulfil(event.order, event.id); // dedupe by event.id
+   return new Response(null, { status: 200 });
+ }

  // examples/merchant-store/app/page.tsx
+ <a href={\`${origin}/buy/\${process.env.PACT_PRODUCT_ID}\`}>Pay with Pact</a>`;
