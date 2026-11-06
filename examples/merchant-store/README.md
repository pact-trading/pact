# Example merchant store

A minimal Next.js store that takes USDT through Pact. It shows the two parts of an integration:

- `app/api/pact/[...path]/route.ts`: a server route that holds your secret key. The `<Checkout>` component posts here, its default `apiBaseUrl`.
- `app/webhooks/pact/route.ts`: fulfils an order only after a verified, signed webhook.

## Run it

From the repository root:

```sh
pnpm install
pnpm build:packages
cp examples/merchant-store/example.env examples/merchant-store/.env.local
```

Fill in `.env.local`:

1. `PACT_SECRET_KEY`: your secret key. It stays on this server.
2. `PACT_WEBHOOK_SECRET`: under **Settings → Webhooks**, set the URL to `http://127.0.0.1:3210/webhooks/pact` (use a tunnel if your API is not on this machine) and copy the signing secret.
3. `PACT_API_URL`: only if you are not using `https://api.pactagent.app`, for example `http://127.0.0.1:3001`.

Then build and start it:

```sh
pnpm --filter @pact/example-merchant-store build
pnpm --filter @pact/example-merchant-store start
```

Open http://127.0.0.1:3210. The customer enters an email and continues to Pact's hosted page, where they sign in with that email and pay.

## Why the proxy route is restrictive

Anyone can call this route, and it answers with your secret key. A proxy that forwards everything would let any visitor refund payments, read your orders or set their own price. So this one:

- forwards only `POST /v1/payments` and answers 404 to everything else;
- refuses any amount except the store's own price from `lib/store.ts`, and sets the description itself;
- refuses metadata that Pact acts on, such as `invoiceId`, and adds its own `store_item`;
- passes on no browser headers except `idempotency-key`.

Add a limit on request rate before using this pattern in production.

## Fulfilment

`fulfillment.ts` verifies the signature over the raw body before parsing it, then records each order once in SQLite (`merchant-store.sqlite`, or `PACT_STORE_DB`), in one transaction with the event ID.

| Payment | Webhook | Checked |
| --- | --- | --- |
| Embedded checkout | `payment.captured` | `store_item` and amount, both set by this server |
| Hosted product link (`PACT_PRODUCT_ID`) | `order.paid` | Product, order, currency and status |

The embedded checkout creates a payment rather than an order, so it sends `payment.captured` and not `order.paid`.

Invalid signatures get 401. Set `PACT_DEMO_REFUSE_FIRST_WEBHOOK=true` to answer the first webhook with 503 and watch Pact retry it. Browser callbacks and query parameters never mark an order paid.
