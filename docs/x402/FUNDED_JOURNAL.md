# Funded production journal integration (inactive)

This slice connects the payment-only gateway from `b6fe475` to the existing production x402 facilitator, SQLite coordinator and ViemChain signer. It is not M7/M8 completion or runtime activation. There is no Privy signing implementation, merchant app-secret authority, live deployment or sponsored account administration in this slice. Existing Router, GasTank, SponsoredApprover, AccountWriter, chain/types and app/server/indexer are unchanged.

## Explicit integration ports

Root supplies the existing SQLite connection, **same ViemChain instance/writer** used by all relayer features, its read-only public client, reviewed deployment hashes, a mandatory merchant policy, and two genuine authorization ports:

```ts
const ports = new ViemFundedX402WritePorts(existingViemChain, publicClient);
const coordinator = new X402WriteCoordinator({
  db, writer: existingViemChain.writer, ports,
  sponsorship: inactiveM7SponsorshipPolicy, // keep until reviewed activation
  maxSpendPerMinuteWei: sharedBudget,
  confirmations: reviewedSuccessorDepth,
  funded: {
    route: { router, gasTank, feeVault, factory, gateway, runtimeHashes },
    outerGas, maxTargetGas, maxFeeUSDT,
    terms: merchantIntentTermsSource,
    authorizer: exactMerchantIntentAuthorizer,
  },
});
const journal = new SqliteFundedX402Journal(coordinator);
// Pass journal to the existing Permit2Facilitator; await initialize() before support.
// Schedule journal.reconcile() on startup and periodically, independent of HTTP.
```

`MerchantIntentTermsSource.reserve(operationId, payment, route)` must durably allocate **merchant Router intent nonce**, fee, deadline and target gas across keeper and every other caller of that merchant's Router nonce domain. It must be idempotent for this exact operation and fail closed on ambiguity. It runs inside the existing writer queue; it must not recursively wait for another operation in that same queue. The journal's local unique `(router,merchant,merchant_nonce)` constraint is defense in depth, not a replacement for the shared allocator. A payer Permit2 nonce is a separate domain and cannot serve as the production merchant nonce allocator.

`ExactMerchantIntentAuthorizer.signExactIntent(router, frozenIntent)` must return an actual 65-byte EIP-712 merchant signature for the exact Router domain and fields. Recovery must equal both intent.signer and intent.merchant. The gateway data hash binds account, official proxy, token, recipient, payer signature, nonce, deadline, ceiling and actual amount. Genuine approved Privy delegation remains a separate root-owned implementation. API authentication/app secrets do not satisfy this port. No permissive production provider or policy is exported.

`MerchantSponsorshipPolicy.authorize` receives `variant: 'funded'` and the **already-authorized Router envelope**, not the inner proxy call. Its grant bounds legacy gasPrice, merchant daily maximum-cost budget and daily calls. Policy rejection prevents relayer signing. Because this policy sees the final signed merchant envelope, the authorizer itself must enforce merchant consent before producing that signature. Policy is not inferred from USDT/WBT balances, Router simulation or a syntactically valid signature. The existing inactive policy still refuses every send.

`ViemFundedX402WritePorts` extends the existing exact-envelope transport. It calls existing `chain.simulate` for the precise Router request and uses a read-only receipt port to add actual gasUsed/effectiveGasPrice. Chain ID, transaction hash, block, status and every raw log must agree with `chain.x402Receipt`; missing/inconsistent/error reads retain uncertainty. It adds no wallet, key, RPC write client or nonce queue. No shared-file changes are required for these ports. Root must pass the same trusted public client and retain its single-host ownership guard.

## Identity, persistence and recovery

- Both direct and funded payments retain kind `x402`, the same canonical operation key and the existing **global `(chain_id,payer,permit_nonce)` unique index**, independent of merchant, variant and relayer. Changing direct/funded variant, route fingerprint, amount or payment fingerprint cannot reuse a claim. An additive `variant DEFAULT 'direct'` migration leaves existing identity JSON/results unchanged.
- `x402_funded_operations` stores immutable draft/settings hash, reserved merchant terms, exact merchant signature/request, canonical Router envelope and hashes, then frozen fee/gas envelope and receipt proof. Every recovered binding is reconstructed and signature-verified before use. It never silently wraps inside prepare. Upto must be newly signed with **gateway** as facilitator; the signed Permit2 spender remains the canonical official proxy. `settlementCaller` advertises/simulates the gateway while `journal.address` remains the existing relayer.
- The existing AccountWriter queue covers terms allocation, authorization and send. If an HTTP callback abandons an in-flight authorization/send, the coordinator still awaits that tracked task before releasing the queue. Concurrent identical settlements reuse one result/authorization/write.
- Authorization is marked `authorizing` **before** invoking external terms/provider ports. An interrupted or failed response is conservatively held as `merchant_authorization_pending`; no automatic second terms/signature request occurs after restart. An already persisted authorized request can continue before the first relayer prepare without reauthorizing. Provider lookup/adoption for an unknown authorization is deliberately **not implemented**; root must add reviewed recovery, not clear the row or invent a new nonce.
- In one SQLite transaction the coordinator reserves the existing writer operation, calls **AccountWriter.reserveSpend** across all relayer kinds, reserves merchant daily maximum cost/calls, and freezes the funded gas envelope. These commit before relayer signing. Merchant limits count pending operations even across day boundaries. Maximum-cost reservations are conservative; reimbursement does not net them down. No duplicate budget or nonce queue exists.
- Existing prepare validates the actual signed bytes, signer, nonce, exact calldata/target, zero value, legacy gasPrice, gas and local hash. AccountWriter persists the hash, never raw signed bytes. `broadcasting` is durable before transport; accepted-but-timeout preserves that hash/nonce. Neither restart nor HTTP timeout causes a resend. Missing receipts never release higher nonce holds. Pre-broadcast interrupted preparation becomes `not_sent`, and this payment remains a durable terminal failure rather than being silently re-signed.
- Reconciliation requires the stored transaction hash and the recorded number of **successor blocks**, then `fundedReceipt` evidence: gateway PaymentSettled, official proxy Settled, official USDT payer payment and merchant fee, Router Executed and GasTank Reimbursed to the existing relayer. Reimbursement must match both Router and tank and fit `(maxGas+40000)*gasPrice`. Actual gas metadata must match the frozen legacy price/outer gas bound. Proof persists actual receipt cost and signed net relayer cost. HTTP failure cannot overwrite confirmed chain success.
- Native success with a genuine matching Router Refused event becomes a terminal failed payment. Native success with incomplete/conflicting payment evidence remains `reconciliation_required`; chain nonce confirmation never fabricates application success. Reverted writes are terminal failures. No unrelated nonce/receipt is inferred.

## Reproducible local proof

```sh
forge build --root contracts
pnpm --dir apps/api run typecheck
pnpm --dir apps/api exec vitest run
pnpm --dir apps/api exec tsx scripts/x402/fork-funded-journal.ts
```

The script starts loopback Anvil at a pinned Whitechain archive block. Remote RPC is read-only fork data. It preserves official USDT bytecode/storage and transfers existing tokens from a locally impersonated holder. The absent canonical upto proxy is deployed **locally only** from pinned official CREATE2 initcode; exact runtime is compared with the pinned official initcode. Actual root Router/GasTank/account/factory/gateway artifacts are used. Source and artifact hashes, all route addresses, official runtimes, raw receipts, signed envelope metadata, budgets, production journal rows and authorization proofs are recorded for the run.

Unmodified official `@x402/fetch`, core, EVM and Hono **2.29.0** clients/server run real HTTP exact (10,000 base units) and upto (4,000 actual / 10,000 signed ceiling) payments through **Permit2Facilitator → SqliteFundedX402Journal → X402WriteCoordinator → existing AccountWriter → ViemFundedX402WritePorts**. This is not a script-specific journal. Real synthetic merchant EIP-712 signatures authorize the unchanged Router. Merchant fee, tank debit, relayer native balance change and official token deltas are independently compared with receipt proof. Concurrent retries send once. A third real exact payment is accepted, then the transport deliberately loses its response; SQLite is captured in `broadcasting`, reopened with fresh production objects, held before two successor blocks, and independently reconciled. HTTP/concurrent retries return the original hash with no new terms, merchant signature, sponsorship call, prepare or broadcast. A direct replay of that funded Permit2 nonce is rejected.

Bootstrap and per-payment account reservation are **UNSPONSORED fixture administration** by a separate synthetic owner. These calls are explicitly excluded from payment reimbursements and do not debit merchant tank/fee balances; the payer has zero native WBT. They do not prove a gasless onboarding service. Synthetic fixture merchant signing, nonce selection and sponsorship are not exported or represented as Privy authority. No production journal or receipt is replaced with a fake. Unit tests explicitly mock transport while using disk SQLite, the shared AccountWriter and genuine synthetic merchant/relayer signatures.

## Reimbursement limits and remaining activation gates

Existing Router/GasTank reimbursement is not full receipt-cost coverage. Whether a payment is fully reimbursed is not determined by **exact versus upto alone**: storage transitions, calldata, gas accounting/refunds and the Router's unchanged measurement/clamp all matter. The USDT service fee goes to feeVault, not directly to the relayer's native balance. No guaranteed reimbursement or fee conversion is inferred.

Remaining gates: genuine merchant consent/delegated Privy signing; shared durable merchant Router terms/nonce authority and unknown-authorization recovery; reviewed funded sponsorship/economics policy including refusal/OOG/underpayment risk; merchant WBT deposits/daily caps and USDT fee allowance; separately authorized deployment of missing proxy/factory/gateway with independently pinned codehashes; factory account provenance and owner/session onboarding; reviewed selector/minimum/amount/call/gas limits; root app/server authentication/support wiring, process ownership, reconciliation/indexer and operational monitoring. Runtime must remain inactive until these are satisfied. Bootstrap/reservation sponsorship needs a separate bounded admin-grant design and proof; it remains disabled. SponsoredApprover stays escrow-only. No contract semantics changed in this integration slice.

No package/dependency/license changes: existing official 2.29.0 Apache-2.0 packages and pinned MIT/Apache-2.0 sources remain as recorded in `SOURCES.md`/`package-licenses.json`; no GPL/LGPL/AGPL code was introduced. The existing permissive transitive and development-license inventory qualifications in those files still apply.
