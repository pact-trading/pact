# Live mode (Operate and Scale)

Every screen of the mock UI runs against the real API and contracts, on a local fork of Whitechain
and on the testnet at `https://pay.pactagent.app` (see [deployment.md](deployment.md)).
Tokenize (invoice financing, the investor portal and the compliance registry) runs live on the local
fork, where `pnpm live` deploys the receivables contracts beside the suite. They are not on the testnet
yet, so `https://pay.pactagent.app` still links those screens to the demo at `https://demo.pactagent.app`.

## Run it locally

```sh
pnpm install
pnpm live            # fork + fresh contracts + API + production web build → http://localhost:3000
pnpm live:check      # browser checks of every flow, against the running stack
pnpm live --reset    # wipe the fork state, contracts and database, then start fresh
```

`pnpm live` forks Whitechain with Anvil (chain 1874, Prague, 1-second blocks), deploys a
fresh suite with Anvil's development keys (GasTank, Router, PaymentEscrow, SubscriptionManager, the
canonical x402 upto proxy and the agent account factory), starts the API (relayer, keeper, indexer,
webhooks, x402 facilitator) and serves a production build of the web app. State is kept in
`.runtime/live` between runs. Privy credentials, when present, are read from `apps/api/.env.local`.

Try it by hand:

1. `/login` → **Use a local test wallet** (or **Connect wallet** with a browser wallet whose
   chain 1874 RPC points at `http://127.0.0.1:8545`).
2. Overview → **Set up live payments**: test WBT, deposit into the tank, daily cap, approvals for
   fees and refunds, a little USDT for fees.
3. `/login` → **Use a test customer** (or **Continue with email** through Privy). The bar at the top
   switches between the business and the customer.
4. As the business: create a product, plan (2-minute test periods), invoice, payment link or manual
   order. As the customer: buy, subscribe, acknowledge and pay invoices, create an agent and run it.

## On the testnet

`https://pay.pactagent.app` runs the same flows against the deployed suite and `https://api.pactagent.app`.

1. `/login` → **Connect wallet** with a browser wallet (the app adds Whitechain, chain 1874).
   Claim WBT from `https://faucet.testnet.whitechain.io`.
2. Overview → **Set up live payments**: deposit 0.2 WBT into your gas tank, set the daily cap, approve
   fees and refunds, and swap 0.01 WBT for fee USDT on the testnet DEX.
3. `/login` → **Continue with email** (Privy). The setup card then offers **Swap 0.1 WBT to them**, about
   8 USDT for your test customer.
4. Agents: on an agent's page, **Swap 0.02 WBT into it** funds the agent account from the business wallet
   connected in the same browser (or send USDT to the account address shown).

`pnpm live:check` runs against it with `PACT_LIVE_URL=https://pay.pactagent.app` and
`PACT_LIVE_API=https://api.pactagent.app` ([`tests/live/testnet.mjs`](../apps/web/tests/live/testnet.mjs)):
one merchant wallet kept in `.runtime/testnet/live-check.json` and injected as `window.ethereum` (its key
stays in the test process), the Privy app's test account as the customer, and top-ups from the deployer in
`.env.testnet` (merchant WBT, customer USDT by a DEX swap, only what a flow needs).

## Model

- **Merchant = connected wallet.** Sign-In with Ethereum (EIP-4361); the address is the merchant,
  with its own data, `GasTank` balance and daily cap. The merchant sends its own setup transactions.
- **Customer = email sign-in (Privy embedded wallet).** Only signs messages: the one-time USDT
  approval is relayed through EIP-7702 (`SponsoredApprover`), payments and cancellations through the
  Router. No gas, no wallet popup, no network name. On a local fork, a browser-held test customer
  replaces Privy when it is not configured.
- **One relayer, per-merchant limits.** Spend per minute and the circuit breaker count per merchant
  under a global ceiling, so one tester cannot block the others. Every pre-broadcast refusal is
  stored with its source and signer.
- **Funds.** On the testnet, testers claim WBT from `https://faucet.testnet.whitechain.io` (one
  drip per GitHub account) and swap some for USDT on the testnet DEX (SwapRouter02
  `<SWAP_ROUTER_ADDRESS>`, WWBT/USDT 0.3% pool); the setup card can pay the
  swap straight to the test customer. On the local fork the test faucet sets balances instead.
- **Time.** A real chain cannot be moved forward, so test plans offer 2- and 10-minute periods and the
  keeper runs every 15 seconds. "Run renewal now" goes to the contract even when early or cancelled,
  so those refusals are onchain events.

## What each part does

| Area | How it works live |
| --- | --- |
| Checkout | One confirmation: the relayed USDT approval (first payment), then the signed charge. |
| Refunds | Merchant-signed refund intent; the escrow refuses anything above what was captured. |
| Subscriptions | Approval for 12 periods at most, a signed mandate, keeper renewals (SubscriptionManager V1 lets the keeper call `charge`), customer cancel and plan change (`replace`) through the Router. |
| Invoices | Numbered per merchant, reminder schedule and written reminders, an EIP-712 acknowledgement stored with its signature, paid through hosted checkout. |
| Payment links, manual orders | Hosted payments owned by the payer; they list with product orders and can be refunded. |
| Agents (x402) | Customer-owned `X402AgentAccount` with session caps (owner-signed `configureSessionWithSig`, relayed), our Permit2 facilitator, each merchant's paid `risk-score` API behind `@x402/hono`, the agent runs `@x402/fetch`. Reservations are simulated first, so refusals cost no gas. |
| Drain run | Fresh attacker keys against the merchant's own tank, through a relayer preflight that can never sign or send. |
| Gas tank | Balance, cap, runway, 14-day history and a labelled ledger from the Router's `Executed` events. |
| Invoice financing | `InvoiceReceivables` and `InvestorRegistry` (see below). The merchant lists an acknowledged invoice from its wallet; the contract checks the customer's signed acknowledgement. Approved investors buy and transfer by signature (with a USDT permit), and compliance officers approve and revoke investors by signature: Pact's relayer submits these orders and pays their gas. The customer pays the invoice through the usual link: the relayed approval and the Router payment go to the receivables contract, which pays the holders in the same transaction. The keeper closes listings at the record date and marks defaults after the grace period. |

## Invoice financing

Two contracts sit beside the suite; nothing else is redeployed. The Router gains one allowlist entry,
`InvoiceReceivables.pay`, so a financed invoice's payment is sponsored like any other (the merchant's
tank pays the gas, the merchant pays the Router fee).

- **Rules, fixed at deployment** (`apps/api/src/financing/terms.ts`): Pact's fee 0.5% of face value
  sold, a 10% reserve, a 1% late fee from the reserve, a 7-day grace period, a 24-hour record date,
  a 1 USDT minimum share and at most 8 holders per invoice (which bounds a payment's gas). The API
  prices a listing at 0.1% a day to maturity, plus 1% when the customer has paid this merchant late;
  the contract caps the discount at 20%.
- **The customer's acknowledgement, checked onchain.** `list` takes the invoice id, the customer's
  address and its EIP-712 "I owe this invoice" signature (domain "Pact Invoices"), and verifies it
  against the face value, due date and merchant. One acknowledgement backs one claim, and an invoice
  that was sold to investors or paid while listed stays pledged for good: neither can be listed again.
  Both are freed only when a listing ends with nothing sold and nothing paid. A later deployment can
  name prior deployments as `predecessors` and refuses what they pledged. While a listing is open only that
  customer can pay into it, so nobody else can cut a sale short; once it closes anyone may pay toward it.
- **Who sends what.** The merchant's wallet sends its own transactions (list, cancel, buy back).
  Investors and compliance officers sign in with a wallet (`pact_investor`, `pact_compliance`) but
  only sign: an EIP-712 `Purchase` (plus, the first time, an EIP-2612 USDT permit for the price), a
  `Transfer`, or a registry `Decision`. Pact's relayer submits them and pays the gas, up to 20 orders
  per wallet an hour and within its spend limit; each call is simulated first, so a refusal costs no
  gas. A signed order is valid for 10 minutes and carries the signer's nonce; a `Decision` also
  carries the investor's decision count, so an approval signed before a revocation can never undo it.
  An order that was signed but not sent can be cancelled with one more signature ("Cancel unsent
  orders" on the portfolio and registry pages; `POST /v1/investor/orders/cancel` and
  `/v1/compliance/orders/cancel`, then `/relay`), which moves the nonce on. Signatures from EIP-7702-delegated accounts count (their own key), and smart accounts sign
  through ERC-1271. The API checks the contract's rules before preparing (and records a refusal for
  compliance when a purchase or transfer would revert), then applies the receipt's events at once.
  The indexer applies the same events later; each is applied once.
- **Routing.** While a claim is open (listed, funded or defaulted) the API sends the invoice's
  payments to the contract, never the escrow: the relayer refuses an escrow charge for it, and the
  API asks the chain too in case its index is behind. Such payments are not refundable through the
  escrow; the money went to the holders. A payment is at least 1 USDT and leaves nothing or at least
  1 USDT owed, so a sponsored payment can always finish the claim.
- **On the local fork**, the login page offers test wallets for an investor and a compliance officer.
  The marketplace gives a test investor USDT (no WBT: it never needs gas); the registry page appoints
  a test officer (the faucet impersonates the registry owner).
- **SDK.** `client.financing` (`@pactagent/core`, `@pactagent/node`) reads the overview and an
  invoice, prepares the merchant's listing, cancellation and buy-back transactions, and submits their
  hashes.

Scripted checks:

```sh
pnpm live:check financing    # browser: list, apply, approve, buy, the customer pays, repaid, cancel orders
# API and contracts, including default and buy-back. It moves the fork's clock for good, so give it
# its own stack:
LIVE_RUNTIME_DIR=.runtime/financing-e2e LIVE_CHAIN_PORT=8645 LIVE_API_PORT=3101 LIVE_WEB_PORT=3100 \
  pnpm live --reset --no-web
cd apps/api && API=http://127.0.0.1:3101 RPC=http://127.0.0.1:8645 \
  pnpm exec tsx scripts/live/financing-flow.ts --time-travel
```

## Limitations

- Testnet only. Development keys on the local fork; the relayer holds one hot key.
- Keeper renewals, x402 settlements, approvals and agent setup are paid by the relayer, not
  reimbursed from the merchant's tank (only Router calls are).
- Merchant-side subscription cancellation is not offered: on SubscriptionManager V1 only the payer
  can cancel. Card, bank and own-wallet payments, demo scenarios and the demo clock stay mock-only.
- The contract checks that the customer signed for this invoice, amount and due date; it cannot
  check that the customer is a real, separate business. Investors rely on Pact's checks and on the
  merchant's buy-back.
- Invoice financing is not deployed on the testnet yet. A merchant that lists through the contract
  directly, bypassing the API, could still take an escrow payment for that invoice that the API had
  already signed; the API refuses to list while a payment on the invoice is in flight.
- Outside financing, unchanged: the Router checks only a lower bound on a signed intent's USDT fee,
  so a signer can make a merchant pay a larger fee (to Pact's fee vault) up to its Router allowance.
  This applies to escrow payments too; fixing it needs a new Router, which this work does not deploy.
- The investor registry is a testnet stand-in for KYC: an address, a region and an expiry.
- On the testnet the "fund your test customer" step swaps WBT for USDT; the amount the faucet gives
  is set by Whitechain.
- Chain-bound steps wait for confirmations (two on the testnet), so a relayed approval or payment can
  take ten seconds or more; the web app waits up to 30 s for the API. The public testnet RPC also
  stalls now and then: the API makes one attempt per call (10 s timeout), so an action caught by a
  stall shows "Something went wrong" and succeeds when tried again.
