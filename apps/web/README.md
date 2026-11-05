# @pact/web

Next.js app for every side of a Pact payment: the merchant dashboard, hosted checkout,
subscribe and invoice pages, the customer portal, the AI agent console and the checkout playground.

## Data modes

Every screen reads through `src/server/data` (`getData()`), so the same UI runs on two sources:

| `PACT_DATA` | Source | Use |
| --- | --- | --- |
| `mock` | In-memory demo store seeded with the PRD story (`src/server/data/mock`) | Demo, design work, e2e tests |
| unset | The Pact API via the visitor’s session (`src/server/data/api`) | Real use; unwired screens say “Not connected yet” |

## Run

From the repository root:

```sh
pnpm preview                       # mock data, production build, http://127.0.0.1:3200/demo
pnpm --filter @pact/web build      # API mode
pnpm --filter @pact/web start
pnpm --filter @pact/web e2e        # builds the mock preview, then Playwright on desktop and mobile
pnpm --filter @pact/web qa         # screenshots every screen into docs/screens (needs `pnpm preview` running)
```

In mock mode, `/demo` chooses the viewpoint (merchant, customer, AI agent, attacker, accountant,
investor), and `/demo/screens` links every screen, each opened as the right viewer. The demo bar also
switches review scenarios (empty, loading, error, insufficient funds, gas empty, expired, overdue,
renewal failed, cap reached) for the visitor's own sandbox.
The demo bar moves the clock forward for renewals and due dates, and resets the data. Each browser
has its own sandbox (the `pact_sandbox` cookie), so those controls only affect that visitor. Signatures
are collected by a mock passkey sheet; transaction hashes open the mock explorer at `/demo/explorer`.
The public demo at pay.pactagent.app is described in [docs/deployment.md](../../docs/deployment.md).

## API mode configuration

Keep secrets on the server. `PACT_API_URL` points at the API. `NEXT_PUBLIC_PRIVY_APP_ID`
(and optionally `NEXT_PUBLIC_PRIVY_CLIENT_ID`) enable email and passkey sign-in. Behind a proxy,
set `PACT_PUBLIC_ORIGIN` to the exact public origin. The browser signs messages only; the API's
relayer submits every transaction.

## Layout

```
src/app            routes: /dashboard/*, /portal/*, /investor/*, /buy, /checkout, /subscribe, /invoice,
                   /l (payment links), /pay (manual orders), /playground, /docs, /legal, /demo
src/components     ui/ kit, shell/, merchant/, customer/, auth/ (Privy and mock signer)
src/server         data/ sources, actions/ (server actions), viewer, load
src/lib            formatting, explorer links, refusal copy
```
