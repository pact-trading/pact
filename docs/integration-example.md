# Independent merchant store

`examples/merchant-store` is a Next.js store on a separate origin. It shows the
embedded `<Checkout>` with its proxy route at `/api/pact`, and the hosted product
link below. It fulfills only after a signed webhook. No merchant API credential is
embedded in its pages. SDK sources are local to this repository; this document
does not claim an npm release. Setup for the embedded checkout is in
[its README](../examples/merchant-store/README.md); the steps here are for the
hosted link.

1. Configure Privy for the web/API and sign in as a merchant. Save the business
   name under Settings, then create an **active** USDT product under Products.
2. Copy the product's actual `/buy/prod_…` link. One link is the merchant's public
   integration:

   ```html
   <a href="https://YOUR_PACT_HOST/buy/YOUR_SAVED_PRODUCT_ID">Pay with Pact</a>
   ```

3. Under Integration configure a webhook URL. For a local API and store on the
   same machine use `http://127.0.0.1:3210/webhooks/pact`. Copy the newly generated
   signing secret into the store's **server environment**, never the browser.
4. Run with Node 22.13+. Set the values in `examples/merchant-store/.env.local`,
   which stays out of git, then from the repository root:

   ```sh
   # PACT_PRODUCT_ID=YOUR_SAVED_PRODUCT_ID
   # PACT_CHECKOUT_ORIGIN=http://localhost:3000
   # PACT_WEBHOOK_SECRET=the signing secret
   pnpm build:packages
   pnpm --filter @pact/example-merchant-store build
   pnpm --filter @pact/example-merchant-store start
   ```

   Open http://127.0.0.1:3210. `merchant-store.sqlite` is durable local fulfillment
   evidence. `PACT_STORE_DB` can select another path; `PORT` defaults to 3210.
   Inspect it locally with `SELECT * FROM fulfillment;`; it is not exposed as a
   public customer-data endpoint.
5. Confirm a payment using a separate verified customer. The API's confirmed
   indexer atomically queues `order.paid`; its existing delivery worker signs the
   raw body using `x-settle-signature`. The store uses the SDK HMAC verifier and
   checks product, order, currency and status. It commits the event and a unique
   order fulfillment in one SQLite transaction.
6. To demonstrate retry, start the local store with
   `PACT_DEMO_REFUSE_FIRST_WEBHOOK=true`. Its first webhook receives 503; the
   existing API delivery worker retries. Replaying the same event from the
   Integration page must leave one fulfillment row. Invalid signatures get 401.

The demo store records delivery, but intentionally does not send an email or
ship a real item. Browser callbacks and query parameters never mark an order
paid. A live demo needs configured Privy, funded test USDT, a supported signer,
a running indexer/delivery worker and the current approved suite. No runtime is
activated by these instructions or by tests.
