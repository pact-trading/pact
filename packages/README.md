# Pact SDK

Pact has four TypeScript packages for six-decimal USDT payments on chain 1874. The signed EIP-712 domain names (`Settle Router`, `Settle Subscription`) and the `x-settle-*` webhook headers keep their original spelling because the contracts and integrations verify them. Payment amounts are decimal strings, such as `"12.50"`; never calculate them with JavaScript floating point.

| Package | Use |
| --- | --- |
| `@pactagent/core` | Amount conversion, typed data, API transport, webhook verification, theme tokens |
| `@pactagent/node` | Server client and webhook verification |
| `@pactagent/checkout-react` | Browser checkout form |
| `@pactagent/react-native` | Expo checkout view and payment hook |

## Install

```sh
pnpm add @pactagent/core @pactagent/checkout-react
# Server
pnpm add @pactagent/node
# Expo
pnpm add @pactagent/core @pactagent/react-native expo-linking expo-secure-store
```

This repository installs every package with `pnpm install` at the root. The SDK-against-API integration tests live in `apps/api/test/sdk/` and need compiled contract artifacts (`forge build` in `contracts/`).

## React checkout

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

The merchant route at `/api/pact` must forward the SDK's `/v1/payments` request to the Pact API. Keep the server API key in that route. `onSuccess` is a UI event; confirm payment status on your server before fulfilling an order.

## Node webhook verification

```ts
import express from 'express';
import { webhooks } from '@pactagent/node';

const app = express();
app.post('/webhooks/pact', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.header('x-settle-signature') ?? '';
  const valid = await webhooks.verify(req.body, signature, process.env.PACT_WEBHOOK_SECRET ?? '');
  if (!valid) return res.sendStatus(400);
  const event = JSON.parse(req.body.toString('utf8'));
  // Persist the event ID before processing so retries are safe.
  res.sendStatus(200);
});
```

Verify the raw body before parsing JSON. The signing header retains its `x-settle-signature` protocol name. The verifier accepts 64 hexadecimal characters, with or without the `sha256=` prefix. Keep webhook secrets on the server.

## Expo checkout

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

Register a matching Expo URL scheme and have the merchant proxy authenticate mobile requests. The repository app reads `EXPO_PUBLIC_PACT_PROXY_URL` for that proxy. A return URL is a UI signal; the merchant server must verify final payment state. See [React Native setup](packages/react-native/README.md) for passkey, secure storage, and authenticated transport adapters.

## Appearance

`pactTheme()` defaults to the GOL light theme: blue `#2463eb`, white surface, `#f7f9fc` background, `#dfe5ef` borders, DM Sans, and the Pact brand label. Pass `appearance` to either checkout component. Options are `type: 'light' | 'dark'`, partial `colors`, `radius` from 0 to 48, `font`, and partial `brand: { name, logo }`. `themeToCssVariables()` maps the resulting theme to checkout-scoped `--pact-checkout-*` properties; React Native uses the same token values as native styles.

## API and rollout status

The client methods represent `/v1` API routes. The node wrapper requires an explicit `baseUrl` or `transport`. The chain definition is Whitechain (1874), with RPC `https://rpc.testnet.whitechain.io`. Keep `apiKey` server-side. EIP-712 domain strings (`Settle Router`, `Settle Subscription`) and chain constants are signing protocol values and must remain unchanged.

x402 settlement is not available: `/supported` advertises no schemes, and `/verify` and `/settle` return 501 until Permit2 and the required proxies are configured and checked on chain. Do not advertise x402 payments to customers yet.

See [Integration guide](../docs/integration.md) for setup details and the complete public function table.


## Backend client

```ts
import { createPactNodeClient } from '@pactagent/node';

const client = createPactNodeClient({
  apiKey: process.env.PACT_SECRET_KEY!,
  baseUrl: process.env.PACT_API_URL!,
});
const payment = await client.payments.create(
  { amount: '2', description: 'Order 123' },
  { idempotencyKey: 'order-123' },
);
const detail = await client.payments.get(payment.id);
// Fulfill only after confirmed capture, using detail.financialStatus/captured.
```

| Methods | Current API behavior |
| --- | --- |
| `config.get()` | Merchant, configured addresses and optional `subscriptionVersion: 1 \| 2` |
| `payments.create/get/list()` | Create and read payments; no wallet signing or automatic charging |
| `intents.create({ intent, data, signature })` | Submit a signed Router intent; `txHash` is nullable on an existing attempt |
| `payments.refund(id, signedRefund)` / `refunds.list()` | Merchant-signed refund submission and settlement status |
| `payments.getApproval(id, payer)` / `payments.approve(id, request)` | Secret-key-only sponsored-approval readiness and signed submission |
| `subscriptions.createPlan/getPlan/listPlans/nonce/create/list/renew/cancel()` | V1 mandate and signed Router cancellation; plans/nonce/list/renew are shared |
| `subscriptions.createV2/cancelV2()` | Explicit V2 merchant-consented registration and payer-signed direct cancellation |
| `invoices.create/get/list/send/createPayment()` | Draft/send invoices and create linked payment attempts, including partial payments |
| `paymentLinks.create/get/list/deactivate()` | Product, tip and subscription links; `get` increments visits |
| `gasTank.get()` / `refusals.list()` / `dashboard.get()` | Merchant financial and operational reads |
| `export()` / `export({ format: 'csv' })` | Typed JSON report / CSV string; totals include signed refund entries |
| `client.webhooks.configure/test/events/deliveries/replay()` | Server administration; configure rotates its signing secret, test/replay queues delivery |
| `apiKeys.create/revoke()` | Server-only API-key administration |

`webhooks.verify` exported from the package remains the local signature verifier; `client.webhooks` manages API deliveries. Keep administrative keys and webhook signing secrets server-side.

### Signed refunds and subscriptions

Amount/reason-only refunds were incompatible with the backend and now fail locally. Build calldata with the deployed Escrow ABI, construct an `Intent` whose `dataHash` is `keccak256(data)`, and sign `intentTypedData(intent, config.router)` with the merchant signer. Then submit:

```ts
const result = await client.payments.refund(paymentId, {
  amount: '1', // decimal USDT; must equal the signed refund calldata amount
  reason: 'Customer request',
  intent, data, signature,
});
// result.status is pending: poll refunds.list() and payments.get(paymentId).
```

Omitting `amount` requests the remaining refundable amount, but the signed payload is still mandatory and must match that amount. The SDK never creates signatures or changes calldata/nonce for you. `Intent`/`Mandate` integer fields use bigint in application code; requests serialize them as decimal strings without Number conversion. Refund amounts and payment amounts are decimal USDT strings, not base units.

V1 subscription registration accepts `{ planId, mandate, signature }`; get the payer nonce with `subscriptions.nonce(payer)` and sign `mandateTypedData(mandate, config.subscription)`. Plan IDs in mandates are the keccak256 hash of the API plan ID. `Subscription.chainId` is the on-chain bytes32 subscription identifier, **not** network ID 1874. Cancellation currently requires a payer-signed Router intent targeting `cancel(bytes32)` through `subscriptions.cancel(id, { intent, data, signature })`.

### Subscription V2

Use the configured **V2** contract address and version. `config.get().subscriptionVersion` exposes `1 | 2` when the API provides it; older APIs omit it, so absence is not evidence that V2 is active. An existing V1 row/mandate must not be repointed to V2. The V1 `mandateTypedData`, `hashMandate`, `subscriptions.create` and `subscriptions.cancel` remain unchanged.

```ts
import {
  mandateV2TypedData, sponsorshipConsentV2TypedData,
  cancellationV2TypedData,
} from '@pactagent/node'; // also exported from @pactagent/core

const config = await client.config.get();
if (config.subscriptionVersion !== 2) throw new Error('V2 configuration required');
// mandate has the existing eight fields, including the current payer nonce.
// payer and merchant are caller-owned signing interfaces, never API request keys.
const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
const created = await client.subscriptions.createV2({
  planId: plan.id,
  mandate,
  signature: await payer.signTypedData(mandateV2TypedData(mandate, config.subscription)),
  merchantConsent: {
    deadline, // must not exceed mandate.endTime
    signature: await merchant.signTypedData(
      sponsorshipConsentV2TypedData(mandate, deadline, config.subscription),
    ),
  },
});

// After registration is confirmed, cancellation signs its on-chain bytes32 ID.
const cancelDeadline = BigInt(Math.floor(Date.now() / 1000) + 120);
await client.subscriptions.cancelV2(created.id, {
  deadline: cancelDeadline,
  signature: await payer.signTypedData(
    cancellationV2TypedData(created.chainId, cancelDeadline, config.subscription),
  ),
});
// Poll subscriptions.list(); a submitted response is not settlement confirmation.
```

`mandateV2TypedData` uses `Settle Subscription`, version `2`, chain `1874`, and the supplied verifying contract. `hashMandateV2` returns the full EIP-712 digest. `sponsorshipConsentV2TypedData` computes that digest internally and binds it to `SponsorshipConsent(bytes32 mandateHash,uint64 deadline)`; it never substitutes a V1 digest or a bare struct hash. Only the merchant signs that consent. Changing any mandate field, domain, or consent deadline invalidates the authorization.

`cancellationV2TypedData` produces `Cancel(bytes32 id,uint64 deadline)` in the same V2 domain. The payer signs it; `cancelV2` sends only `{ deadline, signature }` to the API subscription ID route. The API uses its clock to enforce an inclusive deadline between now and now+300 seconds (`SUBSCRIPTION_V2_CANCEL_MAX_SECONDS`), and rejects wrong signer, chain, contract or subscription ID. Deadlines use bigint Unix seconds and serialize losslessly as strings. Helpers do not extend deadlines or re-sign expired requests.

V2 cancellation works without merchant GasTank balance and makes no token transfer; the relayer pays network gas under backend limits. Shared `renew` retains the current direct-keeper API behavior and does not imply automatic merchant-sponsored renewal. Replacement, consent revocation, allowance onboarding and automatic renewal authorization provisioning remain separate integration work; these SDK methods do not deploy or activate V2.

### Status and retry semantics

Payment creation returns `pending`; payment details return normalized `pending/succeeded/failed/refunded` plus `financialStatus`, `captured`, `refunded` and nullable `txHash`. Payment lists expose the raw financial status (`open/captured/partially_refunded/...`) in `status`. Successful HTTP submission does not imply successful settlement. Unknown receipts remain pending; missing settlement events can surface as `reconciliation_required`. A partial refund retains normalized `succeeded`, so use the financial fields.

Approval readiness amounts, balances, allowances, approval/authorization nonces and deadlines are decimal **base-unit/integer strings**, with null for unavailable reads. Sign the returned `message` as raw bytes, preserve its deadline and exact amount, and include a signed EIP-7702 authorization only when required. The SDK strips viem's extra `v` field and requires a safe integer authorization nonce rather than rounding it. Keep polling readiness; an old `ready` response is not proof that allowance is still available. Approval gas is paid by the relayer separately from GasTank.

Methods accept the old trailing `AbortSignal` or `{ signal, idempotencyKey }`. Keys are forwarded for POST requests; backend route semantics determine whether they are honored (approval uses its durable attempt identity). The SDK never automatically retries. Abort, timeout or lost HTTP responses can occur after submission: inspect state before any further action, retain the original signed payload/nonce, and never generate a replacement nonce automatically. `PactApiError` exposes `status`, `details` and the optional API `code`.

### Local backend verification

From the repository root, after `pnpm install` and `forge build` in `contracts/`:

```sh
pnpm --filter @pactagent/core test                      # unit tests
pnpm --filter @pact/api exec vitest run test/sdk   # SDK clients against the real API
pnpm build:packages
```

The API tests import the SDK packages from source, so no package build is needed first. Set `CONTRACT_ARTIFACTS_DIR` to an absolute directory if the compiled ABIs live elsewhere. Integration tests call the real Hono API through injected fetch using in-memory SQLite, FakeChain and a fixed synthetic signer. They open no listener, perform no RPC calls and send no live transactions. Compiled contract ABIs are read locally; no contract build or deployment is performed by SDK tests.

### Atomic subscription replacement

Call `client.subscriptions.replace(oldApiId, { planId, intent, data, signature })` with a payer-signed Router intent targeting the configured subscription contract. `data` must encode the contract version's `replace` call, including the old onchain ID, fresh payer mandate signature, and V2 merchant consent. The API validates the new plan and both identities before reserving the replacement. The response contains the new API `id`, onchain `chainId`, `replaces`, submission `status` and `txHash`. Read subscription status after confirmation; a submitted response is not settlement. Exact replay returns the existing replacement. No SDK-generated signatures, automatic retries or V1-to-V2 migration are implied.
