# Pact Pay

Merchant USDT commerce on Whitechain: products, hosted checkout, orders,
customers, signed refunds, subscriptions, invoices, private receipts, agent payments
over x402 and confirmed-ledger CSV exports. This is testnet software. Test USDT and
WBT are not real-money payments.

- Hosted app: <https://pay.pactagent.app> (API `https://api.pactagent.app`)
- Mock demo, no wallet needed: <https://demo.pactagent.app>
- How it is hosted and operated: [docs/deployment.md](docs/deployment.md); how to try it: [docs/live-mode.md](docs/live-mode.md)

## Repository layout

| Path | What |
| --- | --- |
| `apps/web` | Next.js app: merchant dashboard, hosted checkout, customer portal, playground |
| `apps/api` | Hono + SQLite API, relayer, indexer, keeper, x402 facilitator |
| `packages/` | SDK: `@pactagent/core`, `@pactagent/node`, `@pactagent/checkout-react`, `@pactagent/react-native` |
| `examples/` | Standalone merchant store and Expo store that integrate the SDK |
| `contracts/` | Foundry contracts |
| `scripts/` | Preview, dev stack and live-flow scripts |
| `deploy/` | API host setup and release scripts |
| `docs/` | Integration, x402 and Privy docs |

## Quick start

```sh
pnpm install
(cd contracts && forge build)
pnpm typecheck
pnpm test              # API, SDK and React Native tests
pnpm test:contracts    # forge test
pnpm preview           # production-built local preview with mock data
pnpm e2e               # mock-mode browser journeys, desktop and mobile
```

Open <http://127.0.0.1:3200/demo> and pick a viewpoint: merchant, customer at checkout,
customer portal, AI agent, attacker or accountant. Every screen runs on an in-memory store
seeded with the PRD story and enforcing the same limits as the contracts. Signatures use a
mock passkey sheet and transaction hashes open a mock explorer. Nothing touches a chain,
and the data resets on restart or from the demo bar. Port 3200 must be free (or set `PORT`).

- [Demo script](docs/demo-script.md): a guided walkthrough of the product
- [SDK packages](packages/README.md) and [integration guide](docs/integration.md)
- [Polar provenance and licenses](THIRD_PARTY_NOTICES.md)

## Current implementation

The commerce layer is implemented on the payment contracts, relayer,
indexer and accounting engine. It uses verified Privy identity and immutable
server-priced orders. See [the independent store example](docs/integration-example.md)
and [Polar provenance](docs/polar-port-manifest.md).

## Run the authenticated commerce UI

Keep API secrets server-side. Web configuration uses `NEXT_PUBLIC_PRIVY_APP_ID`
and optionally `NEXT_PUBLIC_PRIVY_CLIENT_ID`; API configuration uses
`PRIVY_APP_ID` and `PRIVY_APP_SECRET`. Set the web's `PACT_API_URL` to the API and
the API's `PUBLIC_BASE_URL` to the hosted web origin. Behind a proxy, set
server-only `PACT_PUBLIC_ORIGIN` to that exact web origin. Configure allowed
origins and embedded Ethereum wallets in your Privy app. Do not paste secrets
into chat or commit env files.

Sign in at `/login`; choose merchant onboarding explicitly. Set the business
name/logo under `/dashboard/settings`, create an active product, then copy its
`/buy/:productId` link. A separate customer signs in at checkout and can later
open `/portal`. The customer session does not register a merchant or gain
merchant API access.

## Reuse

Contracts, relayer/indexer/accounting, subscription/x402 internals and the Pact UI
form the baseline. The scoped catalog/customer/order layer, confirmed order outbox
and standalone fulfillment example build on top. The web work adapts selected Polar
layout/summary/form composition under Apache-2.0; see the manifest for exact sources.
It does not import Polar's backend, branding or telemetry.

## Why this needs onchain stablecoin settlement on Whitechain
1. A refund is a public record. The merchant refunds, and the customer can verify the amount and the original payment on-chain. There are no chargebacks to dispute.
2. Subscription limits live in a contract. The customer signs a cap and a period, a renewal that is too early or too large is refused with a reason, and anyone can read the refusal.
3. The merchant pays gas for the customer, with limits enforced onchain: per merchant tank, daily cap, replay protection, function allowlist. A card network has no equivalent.
4. One second blocks and a sub-cent gas transfer make small payments and settlement in the same block practical, which wires and cards cannot do for global clients.

## Architecture
Customers and agents only sign messages. Services turn signatures into transactions. Contracts check every rule and move USDT.
- `contracts/` Foundry: `Router` (sponsored execute, signature, nonce, deadline, function allowlist, daily caps), `GasTank`, `PaymentEscrow` (authorize, capture, charge, void, reclaim, refund), `SubscriptionManager` (EIP-712 mandates, refusal events), x402 agent account and funded gateway, with a fuzz test that refunds never exceed captures.
- `apps/api` Hono and SQLite: payments, refunds, invoices, plans, intents, export, signed webhooks with retry, indexer, relayer (simulate before send, gas caps, circuit breaker), keeper, x402 routes (closed until Permit2 is configured). Offline fake chain by default; viem adapter for the live chain. See `apps/api/scripts/drain-attack.ts`.
- `apps/web` Next.js: landing, merchant dashboard, hosted checkout, customer portal, playground for theming the checkout, CSV export.
- `packages/` TypeScript: `@pactagent/core`, `@pactagent/node`, `@pactagent/checkout-react`, `@pactagent/react-native` (Expo) with a shared theme API; `examples/expo-store` integrates it in under 20 lines.

## Setup
```bash
pnpm install
(cd contracts && forge test)
pnpm test
scripts/e2e.sh                   # offline: pay, two refunds, refused third, early renewal refused
scripts/dev-stack.sh             # API on 3001 and web on 3202, prints a payment link
```
Live chain: set `CHAIN_ADAPTER=viem`, `RPC_URL=https://rpc.testnet.whitechain.io`, the four contract addresses and a funded `RELAYER_PRIVATE_KEY`.

## Current limitations
- The payer's first approval is sponsored through EIP-7702 (see Gasless payer). Payers on wallets that cannot delegate still need a smart account fallback.
- Single relayer key.
- Payments, refunds and subscriptions are covered by tests and the offline end-to-end script.

## Licenses and reuse
Reused (MIT or Apache-2.0): OpenZeppelin Contracts, Solady-style EIP-712 patterns, the Coinbase commerce-payments escrow design and spend-permissions period logic as models, viem, Next.js, Hono. UI direction informed by heydamir/unslop (CC BY 4.0, Damir Sokolovsky).

## Gasless payer (EIP-7702)
The payer's first USDT approval is also sponsored. The payer's address delegates to `SponsoredApprover` (`contracts/src/SponsoredApprover.sol`), signs one message, and the relayer submits a type 4 transaction, so a payer holding no WBT can approve and pay in one flow. Tests: 5 Foundry tests (replay, other spender, wrong signer, expired, happy path). Limitation: confirm the target network accepts type 4 transactions before relying on it.
