# Viem transport integration and funded M7 gateway design

Design notes and direct-transport integration. The payment-only gateway is implemented in `FUNDED_GATEWAY.md`, and its explicit production SQLite/ports integration is described in `FUNDED_JOURNAL.md`. The administrative selectors proposed below are **not implemented**: bootstrap/reservation sponsorship is disabled and requires separate bounded admin grants. Production remains inactive.

Status: prepared transport and isolated local proof. Production sponsorship remains INACTIVE. This is one integration step toward PRD 5.2-5.9, not completion of M8 or p2-checkout. No runtime activation or live sends are part of this change.

## Transport integration

`ViemX402WritePorts(existingViemChain)` accepts the existing chain instance only. It has no key, wallet, RPC URL or nonce queue of its own. Pass `ports.writer` (the exact same object as `existingViemChain.writer`) to `X402WriteCoordinator`, with the root SQLite connection, mandatory sponsorship policy, shared per-minute budget and reviewed successor-block depth. The coordinator rejects a different writer object, even for the same address. Root must enforce its single-host process ownership before constructing writers.

```ts
const ports = new ViemX402WritePorts(existingViemChain);
const coordinator = new X402WriteCoordinator({
  db, writer: ports.writer, ports,
  sponsorship: inactiveM7SponsorshipPolicy,
  maxSpendPerMinuteWei: sharedRelayerBudget,
  confirmations: reviewedSuccessorDepth,
});
const journal = new SqliteX402Journal(coordinator);
const reservations = new SqliteAccountReservationAdapter(coordinator, reservationGas);
// Root schedules journal.reconcile(), including after restart and HTTP timeouts.
```

The inactive policy always refuses with `m7_funded_gateway_required`. The coordinator maps gate rejection to `sponsorship_not_authorized`. Do not replace it with a balance check. Direct calls to the official proxies/account do not reimburse the relayer from GasTank.

Narrow additions to ViemChain:

- `prepareX402Transaction(envelope, nonce)`: sign exactly the supplied zero-value call on chain 1874, using its existing account. No calldata wrapping, gas estimation, nonce allocation or send. Legacy gasPrice equals the authorized `maxFeePerGas`, capped at 100 gwei; gas is at most 1,000,000. Maximum cost is exactly gas multiplied by this ceiling.
- `x402Receipt(hash)`: actual transaction hash, block, status and unfiltered logs. Only a real receipt-not-found maps to null; other errors propagate and retain holds.
- `x402BlockNumber()`: current uncached head for confirmation depth.
- `x402ReservationValid(account,digest,signature)`: actual ERC-1271 read. Revert/transport failure is not approval.

The adapter independently parses signed bytes, recovers the signer and checks chain, nonce, target, full calldata, value, gas, gasPrice and local hash. A future prepare function that changes or wraps the call is rejected before broadcasting. The journal separately binds canonical settlement or account reservation calldata and commits shared writer/merchant budgets before signing. Raw bytes remain ephemeral; AccountWriter persists only their hash. Reconciliation checks actual transfer/reservation events, independently of HTTP success/failure. Existing durable journal tests cover missing receipts and higher nonce holds.

Root still owns API/server wiring, process ownership, authentication, merchant policy, deployment authorization, account enrollment and recovery scheduling. No new ChainAdapter requirement forces unrelated fake adapters to implement x402 reads.

## Reproducible local proof

From the repository root, build the actual root artifacts, then run:

```sh
forge build --root contracts
pnpm --dir apps/api typecheck
pnpm --dir apps/api exec vitest run
pnpm --dir apps/api exec tsx scripts/x402/fork-journal.ts
```

The script starts its own loopback Anvil at a pinned Whitechain archive block, verifies official runtime hashes, and locally deploys the absent upto proxy from pinned official initcode. It uses separate hard-coded synthetic owner, session, merchant and relayer accounts. Only the existing ViemChain signs/broadcasts the journal's relayer writes. Fixture administration uses a distinct synthetic owner. No dotenv, wallet file or runtime secrets are read. Existing official USDT is transferred from a locally impersonated holder; token code/storage is not replaced and no tokens are minted. The payer has zero native WBT.

`SYNTHETIC_LOCAL_ANVIL_NO_M7_REIMBURSEMENT` is a script-local policy backed solely by Anvil-funded relayer WBT. It is not exported to production and does not reimburse gas. The run records fork metadata, runtime hashes, the root account artifact hash, signed-envelope fields, receipts, writer records, official-client exact/upto results and restart checks.

The script requires two actual successor blocks. Reservation signatures remain unavailable before depth, then the same reservation is retried without a new transaction. The accepted-timeout case sends a real transaction and snapshots SQLite in `broadcasting` before throwing a synthetic transport timeout. It reopens that crash image with a fresh ViemChain instance and the same synthetic signer, confirms the hold before depth, mines successors and reconciles concurrent retries without any resend. No fabricated receipt is used. Unit tests use mock RPC explicitly, with real synthetic transaction signatures.

## Concrete funded gateway design - proposal only

No contract implementation or activation is authorized by this design. It is based on the root Router/GasTank and the pinned official proxy sources in `contracts/x402-reference` (see SOURCES.md for upstream commits/licenses).

### Caller and signature constraints

| Boundary | Required identity |
| --- | --- |
| Permit2 signature domain | chain 1874, canonical Permit2 |
| Permit2 signed spender | canonical exact or upto proxy, never Router/gateway |
| Exact witness | immutable merchant `to` and `validAfter`; no facilitator field |
| Upto witness | immutable merchant `to`, `validAfter`, and `facilitator` equal to the immediate caller of the canonical upto proxy |
| Existing Router intent | EIP-712 ECDSA EOA signer, exact target/dataHash/amount/fee/nonce/deadline/maxGas |
| GasTank reimbursement | only the already-bound Router may debit merchant funds |

Consequently, `relayer -> Router -> gateway -> upto proxy` requires a newly signed official upto witness with `facilitator = gateway`. Existing EOA-facilitator permits cannot be routed through it. The Permit2 spender remains the official upto proxy because that proxy calls Permit2. Exact can be forwarded without changing its official witness. Gateway cannot be substituted as the Permit2 spender.

The current facilitator advertises/checks the relayer as facilitator and the journal binds direct targets. A funded integration must explicitly distinguish the advertised settlement caller (gateway) from the transaction signer (existing relayer), construct and authorize Router calldata BEFORE journal fingerprinting/budget reservation, and update semantic receipt binding. Signing prepare must remain byte-for-byte neutral. Official package simulation must call the proxy with the advertised gateway identity; actual settlement must use the reviewed Router envelope. Re-run unmodified official-client tests against that final route.

### Initial authorization route using the existing Router

Use a merchant EOA co-signed Router intent for each exact, upto, reservation or bootstrap operation. The merchant signs with its own existing wallet or service; the backend does not acquire another transaction signer. `intent.signer = intent.merchant`; the gateway requires Router's active signer and merchant to equal that merchant. This explicitly authorizes spending that merchant's WBT tank and USDT service fee on the exact account/action. An authenticated API call or payer's Permit2 signature alone does not authorize merchant sponsorship. Autonomous delegation of merchant sponsorship requires a separately reviewed bounded authorization mechanism; it is not assumed here.

This avoids pretending Router currently supports contract-account EIP-1271 intents. The payer's session authorization remains separately enforced by X402AgentAccount and Permit2. Router's existing daily counter would count merchant intents, not agent accounts in this route. The gateway therefore needs explicit per-account, per-merchant and global daily call/gas ceilings across all its selectors, in addition to account USDT per-call/daily/merchant limits and root's cross-feature durable relayer budget. Configure Router's merchant-intent daily cap deliberately; do not describe it as a payer cap for this route.

### Gateway surface and funds

A proposed immutable gateway binds Router, official USDT, Permit2, both canonical proxies and the reviewed account implementation. Only Router may invoke fixed selectors:

1. `settleExact(...)`: validate USDT, payer account, witness merchant, deadline and exact amount; invoke canonical exact proxy and require successful completion; emit a gateway event binding permit digest, payer, merchant and exact amount.
2. `settleUpto(...,actualAmount,...)`: additionally require witness.facilitator equals gateway and `0 < actualAmount <= signed ceiling`; invoke canonical upto proxy. The merchant's Router dataHash binds the chosen actual amount. Account accounting continues reserving the full ceiling.
3. `reserveAccount(account,payment,signature)`: require an attested account, matching merchant and supported official spender (upto facilitator must be this gateway, exact facilitator must be zero); call the existing account reservation method. Authenticate the session signature and charge the full ceiling exactly once using the account's existing rules.
4. `bootstrapAccount(account,amount,deadline,ownerSignature)`: require attested account, fixed USDT-to-Permit2 approval, existing bounded owner signature/nonce/deadline, per-account/merchant onboarding gas quota and no arbitrary approval target. Keep SponsoredApprover escrow-only. The gateway cannot extend the account's current 100-USDT allowance cap or ten-minute bootstrap deadline.

Implement `sponsorshipQuote(data)` for each precise selector. Settlement quotes use actual settled amount; reservation quotes use authorized ceiling; bootstrap quotes use the explicitly merchant-authorized approval ceiling. Reservation/bootstrap quotes are admission amounts, never evidence of USDT payment. Classify their events separately in reconciliation/accounting. Zero-allowance revocation needs a separate reviewed sponsorship policy because Router rejects zero quote amounts. No generic arbitrary-call selector is allowed.

Merchant deposits native WBT into GasTank, sets a nonzero daily cap, and separately supplies actual USDT balance/allowance to Router for its service fee. GasTank remains bound only to Router; gateway gets no independent tank-withdraw permission. Owner allowlists the exact gateway selectors with `mustReturnTrue=true`; each selector returns true only after its intended action succeeds. Router's existing nonzero minimum amount must be deliberately configured for micropayments (default 1 USDT rejects the tested 0.01/0.004 USDT). Fee and target gas allowances must include gateway/proxy/account paths and Router's execution overhead; use actual measured gas and the existing cap, never claim full gas reimbursement beyond Router's clamp.

### Atomic success and failure evidence

The target action, merchant USDT fee debit and GasTank reimbursement must execute in one Router transaction. For funded success require matching Router Executed, GasTank Reimbursed to the existing relayer, merchant fee transfer and gateway action event, plus official proxy Settled and USDT payer-to-merchant Transfer for a payment, or matching account Reserved/bootstrap event for administration. A native successful receipt alone is insufficient: Router can return false and emit Refused while consuming its intent nonce. A target failure can leave relayer gas unreimbursed; conservative budgets retain these attempts. Do not issue a new Permit2 nonce or Router intent automatically after ambiguity.

If reimbursement/fee transfer reverts, the whole transaction must roll back the target action. If canonical exact was settled independently by another caller first, treat the frozen Router transaction and the payment outcome separately; do not claim the merchant tank paid for that unrelated transaction. Replay, beneficiary substitution, arbitrary target/token, forged merchant context, depleted tank, missing fee allowance, excessive gas/fees, same-account multi-merchant aggregate caps, delayed receipt, restart and session revocation require fork tests on the final contracts.

### Activation requirements

Review/implement/audit the explicit gateway and final envelope/receipt adapters; establish merchant intent signing and funded GasTank/service-fee setup; verify proxy runtimes and separately authorize any missing canonical upto deployment; attest account implementation; configure selector/minimum/call/gas caps; validate final route against pinned official clients; connect root process ownership, authentication and reconciliation. Keep `inactiveM7SponsorshipPolicy` until all these are satisfied. A transport-only local success does not meet these requirements.
