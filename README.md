# Pact Pay

Merchant USDT commerce on Whitechain Sepolia: products, hosted checkout, orders,
customers, signed refunds, subscriptions, invoices, private receipts, agent payments
over x402 and confirmed-ledger CSV exports. This is testnet software. Test USDT and
WBT are not real-money payments.

- Live on Whitechain Sepolia: <https://pay.pactagent.app> (API `https://api.pactagent.app`), on the [verified contracts](#contracts-on-whitechain-sepolia) below, with [explorer links for every flow](#transactions-per-flow)
- Mock demo, no wallet needed: <https://demo.pactagent.app>
- How it is hosted and operated: [docs/deployment.md](docs/deployment.md); how to try it: [docs/live-mode.md](docs/live-mode.md)

## Repository layout

| Path | What |
| --- | --- |
| `apps/web` | Next.js app: merchant dashboard, hosted checkout, customer portal, playground |
| `apps/api` | Hono + SQLite API, relayer, indexer, keeper, x402 facilitator |
| `packages/` | SDK: `@pactagent/core`, `@pactagent/node`, `@pactagent/checkout-react`, `@pactagent/react-native` |
| `examples/` | Standalone merchant store and Expo store that integrate the SDK |
| `contracts/` | Foundry contracts and deployment records |
| `scripts/` | Preview, dev stack and live-flow scripts |
| `deploy/` | API host setup and release scripts |
| `docs/` | Integration, x402 and Privy docs; dated evidence in `docs/archive/2026-11-01` |

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

- [Demo script](docs/demo-script.md) and [wiring backlog](docs/wiring-backlog.md): which screens already call the API, and what each remaining one needs
- [SDK packages](packages/README.md) and [integration guide](docs/integration.md)
- [Acceptance evidence and open live gates (1 Nov)](docs/archive/2026-11-01/submission/acceptance.md)
- [Polar provenance and licenses](THIRD_PARTY_NOTICES.md)

## Current implementation

The commerce layer is implemented on the payment contracts, relayer, indexer and
accounting engine. It uses verified Privy identity and immutable server-priced
orders. See [the independent store example](docs/integration-example.md) and
[Polar provenance](docs/polar-port-manifest.md).

Pact's only income is a USDT fee taken out of each payment: the merchant receives
the amount less the fee, at terms it signed once in the `FeeSchedule` contract.
Version 1: checkout payments and subscription renewals 0.8% (at least 0.15 USDT),
invoice payments 0.5% (at least 0.15 USDT, at most 10 USDT). Nobody but Pact holds
WBT. Pact's relayer pays all gas; customers and merchants only sign, and USDT
approvals are EIP-2612 permits the relayer submits. Calls that move no money to the
merchant (subscribe, cancel, permits, terms acceptance, voids) are free, within a
daily sponsorship budget per merchant. A refund is the merchant's own signed call:
it pays the refund's gas in USDT on top of the refund.

This suite is **deployed on Whitechain Sepolia** (7 November 2026, with invoice financing
and passkey accounts), verified on Blockscout, and is what `https://pay.pactagent.app` runs:
see [Contracts on Whitechain Sepolia](#contracts-on-whitechain-sepolia) and
[Transactions per flow](#transactions-per-flow). It also runs on a local fork of the testnet
(`pnpm live`). Real Privy login and signing on live Sepolia are not yet accepted.

## Run the authenticated commerce UI

Keep API secrets server-side. Web configuration uses `NEXT_PUBLIC_PRIVY_APP_ID`
and optionally `NEXT_PUBLIC_PRIVY_CLIENT_ID`; API configuration uses
`PRIVY_APP_ID` and `PRIVY_APP_SECRET`. Set the web's `PACT_API_URL` to the API and
the API's `PUBLIC_BASE_URL` to the hosted web origin. Behind a proxy, set
server-only `PACT_PUBLIC_ORIGIN` to that exact web origin. Configure allowed
origins and embedded Ethereum wallets in your Privy app. Do not paste secrets
into chat or commit env files.

Sign in at `/login`; choose merchant onboarding explicitly. On `/dashboard/fees`,
sign the fee terms and the two refund permits; Pact submits each one, and the
merchant wallet needs no WBT. Set the business name/logo under
`/dashboard/settings`, create an active product, then copy its `/buy/:productId`
link. A separate customer signs in at checkout and can later open `/portal`. The
customer session does not register a merchant or gain merchant API access.

## Reuse and development history

Baseline before this plan: `7ae98afba4c6ec0b0b53e9731eda47ae59500eac`. Contracts,
relayer/indexer/accounting, subscription/x402 internals and the prior Pact UI were
already present. Commit `518f246` adds the scoped catalog/customer/order layer,
confirmed order outbox and standalone fulfillment example. New web work adapts
selected Polar layout/summary/form composition under Apache-2.0; see the manifest
for exact sources. It does not import Polar's backend, branding or telemetry.

The 1 November work is pre-event work, not claimed as work made during the
hackathon. AI assistance was used to implement and test the supplied plans;
the plans, evidence and provenance records remain in `docs/archive/2026-11-01`.
Track eligibility and the event-period changes must be documented honestly.

## Why this needs onchain stablecoin settlement on Whitechain
1. A refund is a public record. The merchant refunds, and the customer can verify the amount and the original payment on the explorer. There are no chargebacks to dispute.
2. Subscription limits live in a contract. The customer signs a cap and a period, a renewal that is too early or too large is refused with a reason, and anyone can read the refusal.
3. The fee is a contract rule. The merchant signs its fee terms once, the payment contract takes exactly that fee out of each payment, and nobody else, payer or Pact, can raise it. Pact pays every customer's and merchant's gas within limits enforced onchain: function allowlist, signature, nonce and deadline, per-payer daily cap, minimum amount and gas caps. A card network has no equivalent.
4. One second blocks and a 0.000105 WBT transfer make small payments and settlement in the same block practical, which wires and cards cannot do for global clients.

## Architecture
Customers, merchants and agents only sign messages. Pact's relayer turns signatures into transactions and pays their gas. Contracts check every rule and move USDT.
- `contracts/` Foundry: `FeeSchedule` (versioned fee terms the merchant signs, fee recipient, bounded WBT price), `Router` (sponsored execute: signature, nonce, deadline, function allowlist, per-payer daily cap, gas caps; charges gas in USDT only on merchant-signed refunds and buy-backs), `PaymentEscrow` (authorize, capture, charge, chargeInvoice, void, reclaim, refund; takes the fee out of each payment), `SubscriptionManagerV2` (payer-signed EIP-712 mandates, signed cancellation, refusal events), `InvoiceReceivables` and `InvestorRegistry` (invoice financing), x402 agent account and factory. Includes a fuzz test that refunds never exceed captures and fee security tests. See [contracts/README.md](contracts/README.md).
- `apps/api` Hono and SQLite: payments, refunds, invoices, plans, intents, fees and permits, export, signed webhooks with retry, indexer, relayer (simulate before send, gas caps, fee-covers-gas check, circuit breaker, sponsorship budget), keeper, treasury (keeps the relayer in gas from its fees), x402 facilitator. Offline fake chain by default; viem adapter for the live chain. `pnpm --filter @pact/api drain-attack` runs the attacker intents. See [apps/api/README.md](apps/api/README.md).
- `apps/web` Next.js: landing, merchant dashboard (including Fees), hosted checkout, customer portal, playground for theming the checkout, CSV export.
- `packages/` TypeScript: `@pactagent/core`, `@pactagent/node`, `@pactagent/checkout-react`, `@pactagent/react-native` (Expo) with a shared theme API; `examples/expo-store` integrates it in under 20 lines.

## Setup
```bash
pnpm install
(cd contracts && forge test)
pnpm test                        # API, SDK and React Native tests
bash scripts/e2e.sh              # offline: pay, two refunds, refused third, early renewal refused
scripts/dev-stack.sh             # API on 3001 and web on 3202, prints a payment link
pnpm live                        # local fork, fresh suite, API and production web build
pnpm live:check                  # browser checks of every flow against pnpm live
```
Live chain: set `CHAIN_ADAPTER=viem`, `RPC_URL=https://rpc.testnet.whitechain.io`, `FEE_SCHEDULE_ADDRESS`, `ROUTER_ADDRESS`, `ESCROW_ADDRESS`, `SUBSCRIPTION_ADDRESS` and a funded `RELAYER_PRIVATE_KEY` (`apps/api/scripts/testnet/api-env.ts` writes them from a deployment record).

## Current limitations
- Single relayer key. Every fee goes to it until `FeeSchedule.recipient` points at a fee vault, so fee USDT accumulates in a hot wallet; the treasury job warns when it should be swept.
- Payments, refunds and subscriptions are covered by tests, the offline end to end script and the local fork browser checks; the dashboard write actions were not exercised by touch on a device.
- Time warp is not used; all dates are real.
- A customer wallet that carries an EIP-7702 delegation to a contract without ERC-1271 cannot pay: USDT then checks the signature through ERC-1271, so its authorizations and permits are refused (`TetherToken: invalid signature`). The Privy test account used by `pnpm live:check` on the testnet is in this state.
- Until the relayer has measured passkey charges, it budgets their 600,000 gas ceiling and requires the fee to cover 1.2 times that gas, so a first passkey payment on the testnet must be about 33 USDT or more (at 0.8% and 5 gwei).

## Built at the event and reused
Reused (MIT or Apache-2.0): OpenZeppelin Contracts, Solady-style EIP-712 patterns, the Coinbase commerce-payments escrow design and spend-permissions period logic as models, viem, Next.js, Hono. UI direction informed by heydamir/unslop (CC BY 4.0, Damir Sokolovsky) and public product references in `docs/archive/2026-11-01/references/`.
Whitechain feedback: [WHITECHAIN_FEEDBACK.md](WHITECHAIN_FEEDBACK.md).

## Contracts on Whitechain Sepolia

Deployed on 7 November 2026 (chain `1874`) and run by `https://pay.pactagent.app`. Every
contract is verified on Blockscout with an exact match (Solidity 0.8.26, via-IR, 200 optimizer
runs) against `contracts/src`; the source hashes and every deployment transaction are in
[deployment-testnet-2026-11-07.json](contracts/deployment-testnet-2026-11-07.json) and
[deployment-financing-testnet-2026-11-07.json](contracts/deployment-financing-testnet-2026-11-07.json).

| Contract | What it does | Address (verified source) |
| --- | --- | --- |
| FeeSchedule | Fee terms each merchant signs, fee recipient, WBT price for gas charged in USDT | [0x27B0a40D183DaFA57C6Db92B45a3425AD0A86678](https://explorer.testnet.whitechain.io/address/0x27B0a40D183DaFA57C6Db92B45a3425AD0A86678?tab=contract) |
| Router | Runs signed intents: signature, nonce, deadline, allowlist, daily cap, gas caps | [0x0304236C3625c8c1045463b732f259dC3f341776](https://explorer.testnet.whitechain.io/address/0x0304236C3625c8c1045463b732f259dC3f341776?tab=contract) |
| PaymentEscrow | Checkout and invoice charges (one signature), captures, refunds | [0x8c896e59a2fa432c8d0C11e35aEC05123fE63EC6](https://explorer.testnet.whitechain.io/address/0x8c896e59a2fa432c8d0C11e35aEC05123fE63EC6?tab=contract) |
| SubscriptionManagerV2 | Signed mandates, renewals, onchain refusals, signed cancellation, plan change | [0x63ca9B71D14Df9768231a5D1B49595ce598f8A9E](https://explorer.testnet.whitechain.io/address/0x63ca9B71D14Df9768231a5D1B49595ce598f8A9E?tab=contract) |
| PasskeyAccountFactory | Creates a customer's passkey account (an ERC-1167 clone of the template below) | [0x6a1557b7B453791cc5D8b7570007AD0a8bbc976F](https://explorer.testnet.whitechain.io/address/0x6a1557b7B453791cc5D8b7570007AD0a8bbc976F?tab=contract) |
| PasskeyAccount (template) | WebAuthn P-256 account that pays through Permit2 | [0xE3fd2c3Fd5EFBf16C6403E426131DD06eD09De08](https://explorer.testnet.whitechain.io/address/0xE3fd2c3Fd5EFBf16C6403E426131DD06eD09De08?tab=contract) |
| X402AccountFactory | Creates a customer's x402 agent account | [0x884092fB1A6b0f00FA868B9025CcB1ab7Ca04E0A](https://explorer.testnet.whitechain.io/address/0x884092fB1A6b0f00FA868B9025CcB1ab7Ca04E0A?tab=contract) |
| InvestorRegistry | Approved invoice investors (testnet stand-in for KYC) | [0xd2be6e03B9A0ecd2dFD45A0f9d9c64E8B5DAc7Bf](https://explorer.testnet.whitechain.io/address/0xd2be6e03B9A0ecd2dFD45A0f9d9c64E8B5DAc7Bf?tab=contract) |
| InvoiceReceivables | Invoice financing: listings, purchases, transfers, payments to holders | [0xb4e038800c7a9782C09750Dcda20eAB90d624D53](https://explorer.testnet.whitechain.io/address/0xb4e038800c7a9782C09750Dcda20eAB90d624D53?tab=contract) |

Accounts the factories created in the runs below are verified too: the agent account
[0x7afB06EF25cD2a1Ca98F4F3237c65cF943d6E938](https://explorer.testnet.whitechain.io/address/0x7afB06EF25cD2a1Ca98F4F3237c65cF943d6E938?tab=contract)
and the passkey account
[0x0908A8D378a300B8D75436FbA79EBC81f95A86fA](https://explorer.testnet.whitechain.io/address/0x0908A8D378a300B8D75436FbA79EBC81f95A86fA?tab=contract),
which Blockscout links to the template.

Used, not deployed by Pact: USDT [0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7](https://explorer.testnet.whitechain.io/address/0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7)
(six decimals, EIP-2612 permit, EIP-3009), Uniswap's Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3`, the
canonical x402 Permit2 proxies (exact `0x402085c248EeA27D92E8b30b2C58ed07f9E20001`, upto
`0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002`) and Multicall3 `0xcA11bde05977b3631167028862bE2a173976CA11`.
Owner of FeeSchedule, Router, SubscriptionManagerV2 and InvestorRegistry (and the registry's first
compliance officer): `0xC0DFd2a61DF78dF2e8b491a90e3765Fbf480689a`. Relayer, keeper, price keeper and fee
recipient: `0x59Ca3DA1771d19d27724a713F3363eFbF0a714A3`.

## Transactions per flow

Run on 7 November 2026 against the contracts above with
[`apps/api/scripts/testnet/flows.ts`](apps/api/scripts/testnet/flows.ts). Every transaction, its decoded
events and the wallets are in [contracts/flows-testnet-2026-11-07.json](contracts/flows-testnet-2026-11-07.json).
The merchant, customers and investors were fresh wallets that only signed: during the flows none of them
held WBT or sent a transaction. Pact's deployer gave them test USDT and afterwards took back what was left,
each wallet signing an EIP-3009 authorization the deployer submitted. Only the owner's own transaction can
withdraw an agent account, so for the agent account's last 0.9 USDT the deployer then sent the customer
the WBT for that one call and took the unused part back. These transfers are in the record.

- **API**: sent through `https://api.pactagent.app`, as the web app does. Pact's relayer
  `0x59Ca3DA1771d19d27724a713F3363eFbF0a714A3` submitted every transaction and paid its gas.
- **Direct**: the API asks for an email-verified (Privy) customer before it shows an invoice, which a
  script cannot sign in as. The merchant, customer and investors signed the same orders the API relays,
  and Pact's deployer `0xC0DFd2a61DF78dF2e8b491a90e3765Fbf480689a` submitted them to the contracts. As
  the registry's compliance officer, the deployer also approved the two investors itself.

### Merchant onboarding (API)

| Step | Result | Transaction |
| --- | --- | --- |
| Merchant signs fee terms version 1 (`FeeSchedule.acceptWithSig`) | `TermsAccepted` | [0x268585…e049](https://explorer.testnet.whitechain.io/tx/0x26858587812d874a3c19252eb0bc8558522c00f0010c899fc8f6045d48dfe049) |
| Merchant signs a USDT permit to the escrow, which sends its refunds | Allowance set | [0x857581…785d](https://explorer.testnet.whitechain.io/tx/0x85758118bfb5a6104ed42e5eeecf4f63cd27a6e230c993661383c6910bb2785d) |
| Merchant signs a USDT permit to the Router, which takes a refund's gas in USDT | Allowance set | [0x035fc7…f657](https://explorer.testnet.whitechain.io/tx/0x035fc731dddfff0c7dd7b17a3214a512138ee4103e5f02253b15facc7730f657) |

### Checkout and refunds (API)

| Step | Result | Transaction |
| --- | --- | --- |
| Customer pays 5 USDT with one signature (`PaymentEscrow.chargeWithAuthorization`, EIP-3009) | `Charged`: 4.85 USDT to the merchant, 0.15 USDT fee | [0x377d7b…4a63](https://explorer.testnet.whitechain.io/tx/0x377d7b5fb31fea9a80848bbafe7dc5a39351d452b809e72720aeff912a1a4a63) |
| Merchant refunds 1 USDT (`Router.execute` → `PaymentEscrow.refund`) | `Refunded` 1 USDT; the merchant paid 0.074829 USDT of gas | [0xf303e1…86ad](https://explorer.testnet.whitechain.io/tx/0xf303e1660628cdf951f774e38136cd838bbd443c88a8877cb69b494fc97586ad) |
| Merchant refunds 2 USDT more | `Refunded` 2 USDT; 0.056054 USDT of gas | [0x79feda…133a](https://explorer.testnet.whitechain.io/tx/0x79feda5e7ab60ae5c2e644c37eceeb8854b4c4141ed8a2a3de040a592530133a) |
| Merchant tries to refund 3 USDT when 2 USDT remain | Refused before broadcast (`refund_limit`) | none |

### Passkey account (API)

| Step | Result | Transaction |
| --- | --- | --- |
| Customer registers a passkey; its account address is funded with 40 test USDT before the account exists | Counterfactual address `0x0908…86fA` | none |
| Customer pays 40 USDT with one passkey confirmation; the account is created in the same transaction (Multicall3: `createAccount`, then `PaymentEscrow.chargeWithPermit2` with the account's ERC-1271 signature) | `AccountCreated`, `Charged` 40 USDT, 0.32 USDT fee | [0x85e70e…0292](https://explorer.testnet.whitechain.io/tx/0x85e70ec193ed279932df6eef0573ac45dd193e42682ad2d740c5ae6113f10292) |

### Subscriptions (API)

| Step | Result | Transaction |
| --- | --- | --- |
| Customer subscribes to 2 USDT every 2 minutes: signed mandate and USDT permit in one transaction (`subscribeWithPermit`) | `Subscribed` | [0xc8742c…ff82](https://explorer.testnet.whitechain.io/tx/0xc8742cf30ad4b3974623c3893d5807d71b61d8e44098cb01f5dc10af9f18ff82) |
| Keeper charges the first period (`charge`) | `Charged` 2 USDT, 0.15 USDT fee | [0xc278bd…db4a](https://explorer.testnet.whitechain.io/tx/0xc278bd78c1d5f95b2bb2c3240aa0624faa3741d3da2991a3293bccc22aaddb4a) |
| Merchant runs a renewal early | `Refused`: TooEarly | [0xaf1ed9…c7a3](https://explorer.testnet.whitechain.io/tx/0xaf1ed9f8bf71970182a742f063865465b44362197ea611f4839337a2b88cc7a3) |
| Keeper renews when the period ends | `Charged` 2 USDT, 0.15 USDT fee | [0x1bdd29…5ef8](https://explorer.testnet.whitechain.io/tx/0x1bdd29d314d9827dc935c7991879450b25e623c6d22dc85785e90d728de35ef8) |
| Customer switches to the 3 USDT plan: a USDT permit, then a signed `replace` through the Router | `Subscribed`, `Cancelled`, `Replaced` | [0x335b96…1bbc](https://explorer.testnet.whitechain.io/tx/0x335b96563bb60099c1531f4e737cbf108b1cdca424472bda0abd89d6009b1bbc), [0x245ebc…cf84](https://explorer.testnet.whitechain.io/tx/0x245ebc65024bff37f26947ab80644b7c3df1c3a68c61eebefa33a9085b7ccf84) |
| Keeper charges the new plan's first period | `Charged` 3 USDT, 0.15 USDT fee | [0x12ca7d…1c50](https://explorer.testnet.whitechain.io/tx/0x12ca7d777aa1bcf9400277a149aeacbe7351165010323880fde34961159f1c50) |
| Customer cancels by signature (`cancelWithSignature`) | `Cancelled` | [0x48965f…1735](https://explorer.testnet.whitechain.io/tx/0x48965f6915ab32fd00fc91cd9827cbc630f28807932958e192b9abca85611735) |
| Merchant runs a renewal after the cancellation | `Refused`: Cancelled | [0xf5a381…d0e2](https://explorer.testnet.whitechain.io/tx/0xf5a38153b0595192c5e60f38569d64f7f81f9863cb3e86d12a755d7b9391d0e2) |

### Agents over x402 (API)

| Step | Result | Transaction |
| --- | --- | --- |
| Customer creates an agent account (`X402AccountFactory.createAccount`) | `AccountCreated` `0x7afB…E938` | [0x79b69d…a36e](https://explorer.testnet.whitechain.io/tx/0x79b69d7e049a68b743b55df583f5040450a2276037f527dd142ef6ec6d79a36e) |
| Customer signs the session caps, 0.01 USDT a call and 0.10 USDT a day (`configureSessionWithSig`) | `SessionChanged` | [0xbf0a32…e553](https://explorer.testnet.whitechain.io/tx/0xbf0a32428bb48a2b4aca80d00d8b752198be9d75e6ac4749b13a6f55209de553) |
| Customer signs the account's USDT allowance to Permit2, capped at the daily limit (`bootstrap`) | `Bootstrapped` 0.10 USDT | [0x67e393…7763](https://explorer.testnet.whitechain.io/tx/0x67e393bc3e0d7d98ea33ac945a07e2c52e7f3836d21b15f9a62db38d6e767763) |
| The agent pays the merchant's API 10 times: the account reserves each call (`reserve`)… | `Reserved` ×10 | [1](https://explorer.testnet.whitechain.io/tx/0x5dfe048036a5f30d8610d11053b02c44ac41ead6fc292f5c93338a6e46baed3f) [2](https://explorer.testnet.whitechain.io/tx/0xb4421568a7d05758670d1c249084b74c9a6f1c7cab5b784466010e80e3660ae0) [3](https://explorer.testnet.whitechain.io/tx/0x627b73dcb65ec306c7a0728f6dab714355b767dad856863f362ee8ce649b2a93) [4](https://explorer.testnet.whitechain.io/tx/0x54ec71a486488b6dbc72ce42b258b5ff6bbedde689a4cbb4322f0e381d485352) [5](https://explorer.testnet.whitechain.io/tx/0x915a1368cb42acc7c2f8fcfb763b83db993d135dd478a6e79bac5c9b4eb36973) [6](https://explorer.testnet.whitechain.io/tx/0xe4b7eab33b83c00c4f6d1f6c8c3c52d4e0f3e50eb979b8e7f9132df236eb060f) [7](https://explorer.testnet.whitechain.io/tx/0x2f02cd37b9334c12ef61fbe59d519441432810007b9286fb740ffb79d0e084e7) [8](https://explorer.testnet.whitechain.io/tx/0x979c460e5733eccad70be1d81ce2a6dc24a591fdf4ec8c500ed93637dce25404) [9](https://explorer.testnet.whitechain.io/tx/0x3408f03ce338d2b92c866fe32c552563f75bfc9dfb7c30e7b36dee067015e3e6) [10](https://explorer.testnet.whitechain.io/tx/0xea29f2c21cd2c828ec1849b9684d29c7be086f607a39b1f59060e37d75e218d7) |
| …and the facilitator settles it (`x402ExactPermit2Proxy.settle`) | 10 calls settled | [1](https://explorer.testnet.whitechain.io/tx/0x3019f9ef7514bcb3e40a4e4a73284b55e9334f5da9da057abffb3acda01344ac) [2](https://explorer.testnet.whitechain.io/tx/0xdc54e48ce1ba373428a5bb37baaae477d11061a28b248d8deda77b56c0a0f51c) [3](https://explorer.testnet.whitechain.io/tx/0xca780a7c3c6d7fb6a0b9ea61d665efc34e4bcb85518e808a429f614dba0b4307) [4](https://explorer.testnet.whitechain.io/tx/0xdbb5e6af064a069eaf1a25376b7e020bca7ebba918b0efb764925428005ec1c9) [5](https://explorer.testnet.whitechain.io/tx/0xd0126a96f51c96806ff701dc5589b3bfc85ecd0eca9ea53a0764fe1a712742fc) [6](https://explorer.testnet.whitechain.io/tx/0x2c9b6c3dc7414d22cddcbc67bb622a905027b7f7a6415b1e3458db898eaf6585) [7](https://explorer.testnet.whitechain.io/tx/0x3592c6a049818161a4bd26810f1ae9b7d992e39ee5bfeff3481bee51f1ea194c) [8](https://explorer.testnet.whitechain.io/tx/0x49543dd32bc4ec3a77a57a1fba75ec0c7147a8751237c606c18aa684715cbc08) [9](https://explorer.testnet.whitechain.io/tx/0x4b638ab580c51b90c854631db714c8305a34907cd0e5f203581e7950676f14d8) [10](https://explorer.testnet.whitechain.io/tx/0xe235f5c4fdc100062467d649ef7441666825bc6a919a974886682d164fb17f6f) |
| The 11th call | Refused before broadcast (`DailyCap`) | none |
| Customer revokes the agent by signature (`revokeSessionWithSig`) | `SessionChanged` | [0xe84b0e…35af](https://explorer.testnet.whitechain.io/tx/0xe84b0e70e63b32a69f170ad83be4961320f275a6a3d6f55f54f8a25a41e035af) |

### Drain run (API)

| Step | Result | Transaction |
| --- | --- | --- |
| 56 attacker attempts against the merchant: 50 refunds the merchant never signed, 2 with arbitrary calldata, a replay, a dust payment, an expired deadline and a call over the gas cap | All 56 refused before broadcast; the merchant held 48.049117 USDT before and after | none |

### Invoices (direct)

| Step | Result | Transaction |
| --- | --- | --- |
| Customer pays a 4 USDT invoice with one signature at the invoice rate (`PaymentEscrow.chargeWithAuthorization`, invoice product) | `Charged` 4 USDT, 0.15 USDT fee (the 0.5% rate's floor) | [0x7880b4…490c](https://explorer.testnet.whitechain.io/tx/0x7880b4419c6f1bfef90e809ed966a3f3e559dfc52bc25403d567bca18e4c490c) |

### Invoice financing (direct)

| Step | Result | Transaction |
| --- | --- | --- |
| Merchant lists invoice INV-MW5KK70S (10 USDT due in 20 days, 2% discount) with the customer's signed acknowledgement (`listWithSig`) | `Listed` | [0x0fa9c4…ddff](https://explorer.testnet.whitechain.io/tx/0x0fa9c4ab3720bf733bf33384b1426bdbc1c2a8fbf41bd10c683caae3c76dddff) |
| Compliance officer approves investor A (`InvestorRegistry.approve`) | `InvestorApproved` | [0xd1d26f…d477](https://explorer.testnet.whitechain.io/tx/0xd1d26f042dc84e96f7a0bdda86e0be03ccda53d055c4eaad4c3710167c60d477) |
| Compliance officer approves investor B | `InvestorApproved` | [0xfdcd91…e87b](https://explorer.testnet.whitechain.io/tx/0xfdcd91b98292260f921af53989a7350ee3ec33cb9721ad7edc48115732b2e87b) |
| Investor A buys 6 USDT of face value for 5.88 USDT: a signed purchase with a USDT permit (`buyWithSig`) | `Purchased`: 0.03 USDT Pact fee, 0.60 USDT reserve, 5.25 USDT to the merchant at once | [0x7a25a5…a982](https://explorer.testnet.whitechain.io/tx/0x7a25a5ae5e29f5d4de3403dea6cb5204e61686dae427ac2c7f3ac2968c00a982) |
| Investor B buys the remaining 4 USDT for 3.92 USDT | `Purchased` (0.02 fee, 0.40 reserve, 3.50 to the merchant), `ListingClosed` | [0x64f7cd…aa30](https://explorer.testnet.whitechain.io/tx/0x64f7cd1db77ba63d86c0858f17737fd7f7fb8b45e757a46417b205d36334aa30) |
| Investor A transfers 1 USDT of face value to investor B (`transferWithSig`) | `Transferred` | [0x97c1f9…8538](https://explorer.testnet.whitechain.io/tx/0x97c1f9e176c6dbfdb960379f65859b38ef71b793e447f59a958a1cf695838538) |
| Customer pays the 10 USDT invoice with one signature (`payWithAuthorization`) | `HolderPaid` 5 USDT to each holder, 1 USDT reserve back to the merchant, no fee | [0x4da5b7…c80b](https://explorer.testnet.whitechain.io/tx/0x4da5b72c05b53d56d627b489667efe397fe8bfde9ba229f36c79afb5e30bc80b) |
| Investor A cancels an unsent signed order (`cancelNonceWithSig`) | `NonceCancelled` | [0x399320…46a2](https://explorer.testnet.whitechain.io/tx/0x399320973fe3b2dd858fc09b828ae0acb8d3faba3eed0511f561dbfcd32246a2) |

A default and the merchant's buy-back need the invoice's maturity plus the 7-day grace period to pass, so
they were not run on the testnet. They run on the local fork with
`scripts/live/financing-flow.ts --time-travel` and in `contracts/test/InvoiceReceivables.t.sol`.
