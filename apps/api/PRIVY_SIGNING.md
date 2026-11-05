# Privy merchant signing adapter

`PrivyRenewalSigner` implements the existing sign-only keeper port using the pinned `@privy-io/node@0.37.0` SDK. It does not enable automatic renewal or turn a synthetic grant into a production grant. Runtime remains inactive until verified owner enrollment and deployment configuration are integrated and accepted.

## Required authority

Supply an explicit `PrivySigningConfig`: application ID/server secret, configured signer quorum ID, its P-256 public key in base64 SPKI form, and an external `authorize(payload)` callback returning a base64 DER P-256 signature. The callback can use a separately operated authorization service/KMS. This is a request-authorization credential, not the merchant's Ethereum wallet private key. There is no environment switch that substitutes the app secret or a login JWT for this callback.

The merchant must explicitly add that signer to the primary embedded Ethereum wallet with exactly one override policy. `merchantIntentPolicy(scope)` generates the expected rule definition. Policy ownership must be the wallet's user-only quorum, containing only the bound Privy user with threshold one; the worker's signer quorum must contain only the configured authorization public key with threshold one. More complex quorum arrangements are rejected rather than assumed equivalent.

Before and after obtaining a signature, the adapter reads the actual Privy user, wallet, policy, signer quorum and owner quorum. It checks the existing app/user/merchant DB binding, primary wallet ID/address, signer membership and exact policy semantics/hash. Policy names and generated rule IDs are not authority; method, conditions, owner and schema are. A removed signer, changed wallet, changed key, extra permissive rule or worker-owned policy prevents return of a usable signature.

The policy grants only `eth_signTypedData_v4` for chain 1874, the exact Router, merchant signer/merchant, target, calldata hash, payment amount and bounded fee/gas/deadline. Other methods have no ALLOW rule. The adapter additionally checks the full Settle Router domain/type, a fresh deadline of at most 120 seconds, the exact persisted signing revision and an active local grant. Due-state, semantic attempt uniqueness, daily/lifetime budgets and writer reservations remain the renewal service's responsibility. No claim is made that those business limits are implemented by the provider policy engine.

## Durable request and response

Only an existing preparing `renew` operation with the matching immutable grant and typed data can request a signature. The adapter records the digest, deterministic idempotency key and expiry before calling Privy, and records a locally recovered merchant signature before the final authority recheck. These audit tables reject update/delete. A lost provider response does not trigger SDK retries or a blockchain send. The caller still reconciles the AccountWriter and applies the existing short-deadline/revision rules.

The SDK's high-level method does not expose a server request ID. The returned `providerRequestId` port field is explicitly a `privy-idempotency:<caller-key>` correlation reference, not proof of consent or a fabricated Privy request ID. An exposed signature cannot be revoked offchain retroactively; it remains bounded by the signed deadline and onchain mandate checks. Local/provider revocation prevents subsequent local submission.

## Verification and integration remaining

Seventeen tests run the real SDK against an intercepted synthetic HTTP provider. They verify the P-256 signature over the actual canonical request body/headers, decimal bigint serialization, exact Ethereum merchant signature, persistence before POST, default-deny policy comparison, owner/key/wallet checks, pre/post-signing revocation and no automatic resend on a lost response. No provider credentials, real wallet or network calls are used. Full integrated API suite passed 401 tests before the batch-policy extension; all 17 focused signing tests and TypeScript pass after that extension.

One provider override policy can contain up to 100 exact subscription rules for the same merchant and Router. Every rule must match an unrevoked locally enrolled grant, and all grants using that wallet/signer/policy must agree on the provider policy hash. Rule/condition ordering and generated labels do not change authority; duplicate actions, cross-merchant scopes, stale grant hashes and extra allow rules are rejected. Policy changes therefore require coordinated owner approval and atomic grant replacement. Authenticated owner enrollment/policy installation, verified grant installation and production service wiring are still required. The frontend must obtain actual owner consent using Privy's signer flow; this module never creates a policy, adds a signer, changes ownership, exports keys or broadcasts. Validate the policy's enforcement against a real test application before activation. x402's dynamic payment grant is a separate integration; it must not silently reuse an opaque renewal calldata scope.

References checked against current official documentation and the installed SDK:
- [Additional signers and one override policy](https://docs.privy.io/wallets/using-wallets/signers/add-signers)
- [Server authorization contexts and external signing callbacks](https://docs.privy.io/controls/authorization-keys/using-owners/sign/signing-on-the-server)
- [Policy rule evaluation and typed-data field sources](https://docs.privy.io/controls/policies/overview)

## Original subscription terms

New API registrations and replacements retain the verified payer mandate and merchant consent in the append-only `subscription_mandates` table, atomically with the subscription/writer reservation and before submission. The stored domain version, manager, nonce, expiry, caps and signatures survive restart and changes to the plan template. This is evidence of the signed request, not evidence of confirmed onchain registration or permission for background signing.

Merchant-private `GET /v1/subscriptions/:id/mandate` returns the original terms, mandate hash, manager/version and current subscription status with `Cache-Control: no-store`. It does not return either signature. Another merchant receives 404; publishable keys receive 403; legacy rows without the original signed request receive 409 `mandate_snapshot_unavailable`. No historical nonce, expiry or consent is inferred. The enrollment flow must still check confirmed chain state and explicit Privy owner approval before installing a grant.
