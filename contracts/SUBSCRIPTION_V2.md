# Subscription V2 development status

`SubscriptionManagerV2.sol` is a new deployment target. It has **not** been deployed live or connected to the running API process. The backend supports explicit `SUBSCRIPTION_VERSION=2` with a V2 address and correctly bound database. The existing `SubscriptionManager.sol`, deployment manifests and old signatures are unchanged.

## Signed authorization

The domain is `Settle Subscription`, version `2`, actual chain ID and the new verifying-contract address. All signatures currently use ECDSA, matching the deployed EOA/7702 signing path; this is not an ERC-1271 or WebAuthn enrollment implementation.

- The payer signs the existing eight-field `Mandate` in the V2 domain.
- The merchant signs `SponsorshipConsent(bytes32 mandateHash,uint64 deadline)`, where `mandateHash` is the full V2 EIP-712 mandate digest. The deadline is inclusive, must not exceed the mandate end time, and is independently signed.
- `subscribe(mandate, payerSignature, consentDeadline, merchantSignature)` requires both signatures. `replace(oldId, mandate, payerSignature, consentDeadline, merchantSignature)` additionally requires the old payer as actor and unchanged payer/merchant identities. Failure leaves the old subscription active and the payer nonce unchanged.
- `revokeConsent(mandateHash)` permanently invalidates that merchant's unused authorization. It does not cancel an existing customer subscription. Payer nonce consumption prevents registration replay.
- `sponsorshipQuote` verifies merchant consent for registration/replacement before Router nonce consumption and reimbursement checks. The target verifies it again. API authentication alone is never treated as an onchain authorization.

## Cancellation and renewal

The payer signs `Cancel(bytes32 id,uint64 deadline)` in the V2 domain. Anyone can submit `cancelWithSignature(id, deadline, signature)` directly. It makes no token transfer, charges no merchant fee, and reads no merchant tank. The relayer still pays network gas and the backend must budget that spend. A subscription cannot be reactivated; its unique ID and cancelled flag make the authorization one-shot. Existing actor-based `cancel(id)` remains available.

Renewal semantics remain capped token pulls. Direct keeper renewal has no merchant reimbursement. A real merchant-signed Router intent for `charge` does reimburse gas and collect the configured fee; tests verify that path. The backend must provision those actual signed intents rather than treating a keeper key as merchant authority. Confirmed insufficient-funds failures now receive three daily retries after the initial failure; infrastructure errors use a separate durable backoff.

## Verification and next integration

`forge test --summary` passed **59 tests**, including **12 V2 tests** and 256 fuzz cases binding every mandate field to merchant consent. The opt-in V1 Whitechain fork test was skipped because `FORK_RPC` was not set. These are local Solidity tests, not live deployment evidence.

V2 tests cover missing/wrong/revoked/expired consent, domain and deadline changes, replay, atomic replacement, empty-tank/zero-native payer cancellation, cancellation replay and expiry, renewal caps/periods/allowance, and Router fees/tank accounting. Test tokens model no-return USDT; the official-token V2 fork integration is described below.

## API integration check

`pnpm exec tsx scripts/check-subscription-v2.ts` from `api` runs against an isolated local Anvil fork. The script deploys V2 only locally, registers through the API/Viem adapter using both signatures, renews 2 USDT with a merchant-signed Router intent (fee and tank reimbursement), atomically replaces the mandate through a payer-signed Router intent with fresh merchant consent, withdraws the local merchant's remaining tank, then cancels the replacement through the API using only the payer cancellation signature. The database and contract both end cancelled, the payer retains zero WBT, and four durable gas reservations are present. Local output is written to a JSON file in the system temp directory.

The finite subscription allowance is a local zero-fee fixture. This does **not** prove hosted subscription approval onboarding. No token mint/storage override, live transaction, live key, or runtime database is used.

`POST /v1/subscriptions` in V2 additionally requires `merchantConsent: { deadline, signature }`. `POST /v1/subscriptions/:id/cancel` accepts `{ deadline, signature }`, using the typed data above and a maximum five-minute cancellation deadline. V1 keeps its signed Router cancellation format. Database binding refuses to reinterpret existing rows under another contract/version. Direct sends have a one-million gas ceiling, 100 gwei fee ceiling, and share the durable 0.01 WBT/minute relayer budget with intents and approvals.

Before deployment: implement merchant authorization provisioning for automatic keeper renewal, full subscription allowance onboarding; prepare target allowlist migration and old-mandate servicing. Never repoint a V1 subscription row to V2 without a newly signed mandate. The backend completion checklist remains open.

## Atomic replacement API and SDK

`POST /v1/subscriptions/:id/replace` accepts `{ planId, intent, data, signature }`: the old API subscription ID is in the URL; `data` is ABI-encoded `replace(oldChainId, newMandate, payerMandateSignature, consentDeadline, merchantConsentSignature)` for V2 (V1 retains its original three-argument call). The outer Router intent is signed by the old payer, names the same merchant/target and commits to the new mandate amount and exact calldata. The new plan belongs to the authenticated merchant. Publishable keys may submit this independently signed request. Generic `/v1/intents` rejects replacement calls to prevent bypassing domain reservations. SDK `subscriptions.replace(id, request)` exposes the same signed request without generating signatures or retrying sends.

The writer reserves both rows and one immutable intent identity before network awaits. Both rows hold the same transaction hash, including after an accepted-but-timed-out send and restart. A full confirmed receipt must match Router `Executed`, `Subscribed` with the new mandate identity, `Cancelled` for the old chain ID, and `Replaced` linking both. Only then are the new row active and the old row cancelled. Missing evidence retains both hashes for reconciliation. A reverted or refused transaction fails the replacement and preserves the original subscription; an independently observed cancellation always remains terminal. Exact retries return the recorded replacement instead of broadcasting again. API tests cover all four missing-event cases, refused/reverted/preparation failures, cross-merchant/plan mismatch, concurrent calls and accepted-timeout restart recovery. The local official-token fork exercises the actual deployed bytecode and API path.
