# Integrate Pact

The TypeScript package names and exported code identifiers use `settle` for compatibility. Product labels use Pact. Amounts are six-decimal USDT strings on chain 1874. Keep API keys and webhook secrets on a merchant server.

## Install

```sh
pnpm add @pactagent/core @pactagent/checkout-react
pnpm add @pactagent/node # in the server project
pnpm add @pactagent/core @pactagent/react-native expo-linking expo-secure-store # in the Expo project
```

For this workspace, run `pnpm install` at the repository root. The packages are local pnpm workspaces; a separate project needs packages from your configured registry or a local workspace link.

## React checkout in 20 lines

```tsx
import { Checkout } from '@pactagent/checkout-react';

export function PaymentPage() {
  return (
    <Checkout
      amount="12.50"
      apiBaseUrl="/api/pact"
      appearance={{ brand: { name: 'Pact' } }}
      onSuccess={(payment) => {
        window.location.assign(`/orders/confirm?payment_id=${encodeURIComponent(payment.id)}`);
      }}
      onError={(error) => console.error(error)}
    />
  );
}
```

The widget posts to `/api/pact/v1/payments` through `fetchTransport`. Your merchant proxy forwards that request to the Pact API with a server-held API key. The current `Checkout` callback fires for an immediately succeeded response; a hosted checkout navigates to `checkoutUrl`. Confirm the payment on the server before fulfillment, including after a browser return.

A server can create payments directly with `createPactNodeClient({ apiKey: process.env.PACT_API_KEY!, baseUrl: process.env.PACT_API_URL! })`. `baseUrl` must be an actual API endpoint; the SDK default is a `.invalid` placeholder.

## Verify a Node webhook

The Pact API currently sends `x-settle-signature`, a SHA-256 HMAC of the exact request bytes. Keep the raw body and verify it before JSON parsing.

```ts
import express from 'express';
import { webhooks } from '@pactagent/node';

const app = express();
app.post('/webhooks/pact', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.header('x-settle-signature') ?? '';
  const valid = await webhooks.verify(req.body, signature, process.env.PACT_WEBHOOK_SECRET ?? '');
  if (!valid) return res.sendStatus(400);
  const event = JSON.parse(req.body.toString('utf8'));
  // Record the event ID before handling it so retries are idempotent.
  res.sendStatus(200);
});
```

`webhooks.verify` also accepts a UTF-8 string body and signatures without the `sha256=` prefix. The header and EIP-712 domain strings retain their protocol spelling.

## Expo checkout in fewer than 20 lines

```tsx
import * as Linking from 'expo-linking';
import { PactClient, fetchTransport } from '@pactagent/core';
import { PactCheckout } from '@pactagent/react-native';

const client = new PactClient({ transport: fetchTransport('https://merchant.example/api/pact') });
export default function App() {
  return <PactCheckout
    amount="12.50"
    client={client}
    returnUrl={Linking.createURL('payment-return')}
    onSuccess={(payment) => console.log(payment.id)}
  />;
}
```

Add a matching `scheme` to Expo's `app.json`. The merchant proxy must authenticate mobile requests and return the payment response. `usePayment` opens a hosted `checkoutUrl` and reads matching deep-link return values. A deep-link status is a UI signal; confirm the final payment state on your server. [The React Native guide](../packages/react-native/README.md) shows passkey and secure storage adapters.

## Theme

`pactTheme()` returns the GOL light preset by default. It follows the shared GOL tokens: `#f7f9fc` background, white surface, `#101318` text, `#dfe5ef` border, and `#2463eb` primary. The brand label is `Pact`. Both checkout components take `appearance` with the same `PactThemeOptions` shape:

```tsx
<Checkout
  amount="12.50"
  appearance={{
    type: 'light',
    colors: { primary: '#2463eb', border: '#dfe5ef' },
    radius: 14,
    font: 'DM Sans Variable, system-ui, sans-serif',
    brand: { name: 'Pact', logo: '/gol-mark.svg' },
  }}
  onSuccess={(payment) => console.log(payment.id)}
/>
```

`type` accepts `light` or `dark`. `colors` can override `primary`, `primaryText`, `background`, `surface`, `text`, `mutedText`, `border`, `success`, and `danger`. `radius` accepts 0 through 48 pixels. `brand.logo` is optional. The browser component scopes CSS variables to its root; React Native maps tokens into native styles. Load DM Sans in the host app if you want that family instead of the platform fallback.

## x402 status

x402 is closed while Permit2 and the exact and upto proxy addresses are unconfigured. `/supported` advertises no schemes; `/verify` and `/settle` return HTTP 501. The SDK has no x402 client function. Do not route customer payments through x402 yet.

## Public function reference

| Package | Function or callable API | Purpose |
| --- | --- | --- |
| `@pactagent/core` | `parseUsdt(amount)` | Parse a nonnegative decimal USDT string into six-decimal `bigint` units; reject more than six places. |
| `@pactagent/core` | `formatUsdt(units)` | Format base-unit `bigint` as a decimal string. |
| `@pactagent/core` | `intentTypedData(intent, verifyingContract)` | Build the Router EIP-712 payload. |
| `@pactagent/core` | `mandateTypedData(mandate, verifyingContract)` | Build the Subscription EIP-712 payload. |
| `@pactagent/core` | `hashIntent(intent, verifyingContract)` | Hash a Router intent with its fixed domain. |
| `@pactagent/core` | `hashMandate(mandate, verifyingContract)` | Hash a subscription mandate with its fixed domain. |
| `@pactagent/core` | `fetchTransport(baseUrl, fetcher?)` | Create a fetch-backed API transport. |
| `@pactagent/core` | `new PactClient({ transport, apiKey? })` | Create an API client. Keep `apiKey` on the server. |
| `@pactagent/core` | `client.payments.create(input, signal?)` | Create a USDT payment. |
| `@pactagent/core` | `client.payments.refund(id, input?, signal?)` | Request a full or partial refund. |
| `@pactagent/core` | `client.invoices.create(input, signal?)` | Create an invoice. |
| `@pactagent/core` | `client.subscriptions.createPlan(input, signal?)` | Create a subscription plan. |
| `@pactagent/core` | `client.intents.create(input, signal?)` | Submit a signed intent. |
| `@pactagent/core` | `client.gasTank.get(signal?)` | Read the merchant gas tank. |
| `@pactagent/core` | `client.export(options?, signal?)` | Request JSON or CSV export. |
| `@pactagent/core` | `verifyWebhook(body, signature, secret)` | Verify an HMAC over the unparsed request body. |
| `@pactagent/core`, `@pactagent/node` | `webhooks.verify(body, signature, secret)` | Alias of `verifyWebhook`. |
| `@pactagent/core` | `pactTheme(options?)` | Merge theme options with a light or dark preset. |
| `@pactagent/core` | `themeToCssVariables(theme)` | Convert theme tokens to checkout-scoped CSS properties. |
| `@pactagent/node` | `createPactNodeClient(options)` | Create a server client with an API key and optional base URL or transport. |
| `@pactagent/checkout-react` | `Checkout(props)` | Render the browser checkout form. |
| `@pactagent/react-native` | `usePayment(options)` | Manage payment creation, sign-in adapter, storage, and deep-link return state. |
| `@pactagent/react-native` | `PactCheckout(props)` | Render the Expo-compatible checkout view. |
| `@pactagent/react-native` | `pactTheme(options?)` | Re-export the core theme builder. |

`pactThemePresets`, `whitechainSepolia`, chain constants, typed-data schemas, `webhooks`, and the public TypeScript interfaces are exported values or types, not additional functions. `PactApiError` is the exported error class for non-2xx API responses.
