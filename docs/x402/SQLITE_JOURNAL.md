# SQLite journal integration - required root ports

This adds production persistence/recovery adapters for M8. It does not activate the facilitator, connect a live signing transport, implement M7 reimbursement or complete x402 acceptance. It consumes root's `AccountWriter.reserveSpend` from `def06d1`; that root commit must already be present.

## Ownership and construction

Use the **existing bound `chain.writer` and API database**. Every x402 adapter and every other relayer writer must use the same AccountWriter instance. Do not construct another wallet, account nonce manager, queue or writer in runtime. AccountWriter assumes one process owns the relayer; this implementation does not add a multi-process lease. Root must enforce that deployment constraint. Separate SQLite connections/processes must not each run a writer for this account.

```ts
import { X402WriteCoordinator } from './x402/write-coordinator.js';
import { SqliteX402Journal } from './x402/sqlite-journal.js';
import { SqliteAccountReservationAdapter } from './x402/sqlite-reservations.js';

// All arguments are root-owned dependencies; no key/environment loading occurs here.
const coordinator = new X402WriteCoordinator({
  db,
  writer: chain.writer,
  ports,                  // X402WritePorts, described below
  sponsorship,            // REQUIRED MerchantSponsorshipPolicy, fail closed until M7
  maxSpendPerMinuteWei,    // same global relayer limit used by other AccountWriter callers
  confirmations: 2n,
});
const journal = new SqliteX402Journal(coordinator);
const accountReservations = new SqliteAccountReservationAdapter(coordinator, 300_000n);
// Give journal to Permit2Facilitator and accountReservations to createX402AccountSigner.
// Root must schedule read-only reconciliation even when no HTTP request is active:
await coordinator.reconcile();
```

Constructor binding is idempotent for the same writer/database. Root's startup `AccountWriter.bind` retires only `preparing` and `signed` operations, for which the writer proves no broadcast was entered. It never clears `broadcasting`, `submitted` or `uncertain` operations. The x402 reconciler maps a proven `not_sent` operation to terminal failure; it does not automatically try that payment again.

`SqlitePendingSettlementStore` implements the official package interface. It is namespaced by chain and relayer and has no TTL. An existing key cannot be changed to another transaction hash. An upstream `delete` removes only the retry hint: the domain journal and writer still retain transaction ownership. No pending-cache operation clears writer nonce holds or budgets.

## Ports to implement in root

`api/src/x402/write-ports.ts` is the exact TypeScript contract:

| Port | Required behavior |
| --- | --- |
| `chainId()` | Read the connected chain ID; only 1874 is accepted. |
| `transactionCount()` | Read pending count for the existing relayer. AccountWriter applies its durable nonce floor even when this RPC is stale. |
| `prepare(request, nonce)` | Use the existing chain signing facility to prepare exactly the supplied chain/to/data/value/gas/maximum-fee envelope and nonce. Return `{ raw, hash }`. Never broadcast or allocate a nonce here. |
| `broadcast(raw)` | Submit the supplied bytes once. Use bounded transport timeouts. Throw on ambiguous RPC failure; AccountWriter persists uncertainty and returns the locally computed hash. No retries that create a new transaction. |
| `latestBlock()` | Return the current chain head for confirmation checks. |
| `receipt(hash)` | Return null if unknown, or the actual normalized `{ txHash, block, status, logs }`. Preserve raw log emitter, topics and data. Do not synthesize logs from HTTP responses. |
| `reservationValid(account, digest, signature)` | Read the account's current ERC-1271 response and compare with `0x1626ba7e`. Revocation, expiry, rotated sessions and RPC failures must not return true. |

Raw transaction bytes remain only in AccountWriter.execute's stack. SQLite stores the hash, nonce, phase, call envelope and fingerprints; **it does not store raw signed Ethereum transactions**. A restarted process reads the receipt for the stored hash. It never reconstructs, re-signs, resubmits or fee-bumps an ambiguous operation. The existing offline AccountWriter/operator recovery design remains the authority for exceptional recovery.

The coordinator validates fixed chain/value/gas bounds and canonical proxy settlement calldata against payer, USDT, nonce, merchant, actual amount and upto facilitator. Reservation calldata must target its account, contain the same official Permit2 digest/ceiling/merchant/nonce and use only `reserve`. Both use pinned official ABIs/types. Transaction envelopes and grants are copied/frozen before asynchronous ports run. Calldata fingerprints refuse a changed call on the same identity.

## Identity, results and recovery

Settlement identity is canonical `eip155:1874:permit2:<lowercase payer>:<decimal nonce>`. A unique SQLite index covers chain + payer + Permit2 nonce across exact and upto, regardless of merchant or HTTP caller. The stored immutable identity also binds amount, merchant, fingerprint and writer address. Altered fingerprints, different payloads or another relayer attempting to adopt that identity are refused. Even `not_sent` retains its payment identity; a new authorization must use a new Permit2 nonce.

Account reservations use chain + account + the official Permit2 witness digest. Their fingerprint also binds the account signature. Address casing and JSON key order are normalized where appropriate. The account's own domain/epoch signature and onchain logic remain authoritative; the adapter does not invent a payment signature scheme.

`runOnce` admits execution through AccountWriter.run. Concurrent identical requests reload the durable row after queue admission and execute only once. A callback that times out or abandons an awaited submit cannot release the writer queue while its submit is still in flight. No second nonce queue is introduced.

HTTP results are stored separately in `http_result_json`. They do not decide confirmed payment success. A callback that throws or returns `settlement_pending` after the chain accepted the transaction can still reconcile to success. Conversely, an HTTP success before the configured depth remains pending. Terminal results are durable and returned on later identical requests without calling the official scheme again.

Confirmation depth follows AccountWriter's existing convention: receipt block must satisfy **block <= head - confirmations**. Depth 2 means two successor blocks, not an inclusive two-block count. Each operation persists the depth at creation; restarting with a lower configured value cannot lower that operation's requirement. Receipt evidence is persisted even before it is deep enough.

After depth is satisfied, the exact writer hash is resolved independently of business evidence. Successful settlement additionally requires a `Settled()` event from its bound canonical proxy and exactly one matching official-USDT Transfer for the payer, merchant and actual amount. A successful account reservation additionally requires its account's matching Reserved event. Missing/mismatched business events remain `reconciliation_required`, never resendable. Confirmed reverts are terminal failures. A reservation returns successfully only after a current ERC-1271 read; cached historic success alone cannot authorize a revoked/expired session.

`coordinator.reconcile()` scans unfinished x402 domain operations even if another root reader already marked the writer row confirmed. It can repair business state after an HTTP crash or absent HTTP result. Wrong network, missing receipt, wrong hash, read errors and shallow receipts never imply a dropped transaction. There is no logic that releases higher nonce holds merely because a lower nonce was confirmed. Every hash needs its own receipt. Writer rows retain confirmed nonces as the floor against stale pending counts.

The reservation adapter throws `ReservationPendingError` with operationId, transaction and reason until confirmation/readback succeeds. Client orchestration should retain the **same payment and signature** for recovery. A fresh official client attempt can generate a fresh Permit2 nonce and thus consume another conservative account reservation; the adapter cannot transparently substitute an old signature into new typed data. Signature delivery/resumable client orchestration remains root's integration responsibility.

## Durable budgets and the M7 gate

`MerchantSponsorshipPolicy.authorize` is mandatory. No permissive production implementation is provided. It must bind merchant/account/action/calldata/gas and return a policy ID, maximum fee, merchant daily gas ceiling and merchant daily call count **only once actual sponsorship has been authorized and integrated**. A rejected gate never reaches prepare/broadcast. Balance preflight is not reimbursement.

Admission atomically reserves the writer operation, shared minute budget via **AccountWriter.reserveSpend**, merchant daily budget and domain state before preparing a transaction. The shared minute reservation sums other writer kinds under root's existing implementation; no duplicate x402 minute-budget table exists.

These merchant counters cover x402 settlements and reservations, not unrelated domains' daily records; M7 must enforce the unified execution-time merchant limits. The merchant reservation charges `gas * maxFeePerGas` and one call for both settlements and account reservations. Pending prior-day reservations carry forward into the current admission check. Confirmed success/revert keeps the full conservative charge for its admission day; there is no optimistic gas refund. Only the writer's proven `not_sent` phase is excluded. These are durable offchain admission budgets, not claims about the actual execution-day gas tank or reimbursement. Root's M7 contracts remain responsible for execution-time caps and reimbursement.

The currently prepared calls still target the canonical proxy/account directly. A sponsorship policy returning a grant cannot make those calls reimburse gas. Root must implement and validate an actual M7 route or explicitly approved reimbursement mechanism, preserving Permit2 caller/witness rules, before supplying a permissive live policy. Do not silently wrap/change the transaction in `prepare`: its envelope is already bound. Any future routed calldata change needs a reviewed adapter/contract change and corresponding tests. The escrow-only SponsoredApprover remains untouched.

## Owned schema and tests

`sqlite-store.ts` initializes only these new tables/indexes:

- `x402_operations`: unique payment/reservation identity, fingerprints, depth, HTTP result, receipt and terminal result.
- `x402_pending_settlements`: durable upstream retry hints.
- `x402_sponsorship_reservations`: merchant daily admission charges tied to AccountWriter operations.

AccountWriter changes in this task add only `x402` and `x402_reservation` kind names. Existing main/runtime/app/chain/types/server/SDK/web files are not changed by this subtask.

Tests use on-disk SQLite databases, actual AccountWriter and adapters, plus mocked prepare/read/broadcast ports. Mock prepared bytes test durable transaction identity without creating external keys; these tests do not claim actual onchain execution. Crash snapshots are real SQLite serialization at prepare and broadcasting boundaries, reopened with a fresh writer. The actual-USDT Anvil fork harness is separate from these recovery tests.

Run `pnpm --dir apps/api typecheck` and `pnpm --dir apps/api test`. The new `test/x402-journal.test.ts` exercises shared budgets, atomic rejection, accepted timeouts, before-signing crashes, independent writer/business confirmation, confirmations across restart, malformed/substituted calls, missing receipts and higher nonce holds, concurrent settlement/reservation requests, pending-store persistence, event validation and current reservation signature validity.

## Still required before activation

Root must connect these ports to the existing real chain signer/reader, schedule reconciliation, enforce single-process writer ownership, provide merchant authentication and actual M7 sponsorship/reimbursement, and test the final routed operation paths. Canonical upto must still be deployed under separate authorization. Account enrollment/passkeys, gasless bootstrap routing, confirmed refusal/audit UX, operational finality policy and live acceptance remain separate gates. This persistence integration is a necessary step toward the full PRD goal, not completion of M8 or of p2-checkout.

## Verification

Based on main `def06d1`. `forge build --root contracts` regenerates the existing V2 ABI artifacts required by root's API tests without changing contract source. `pnpm --dir apps/api typecheck` and `pnpm --dir apps/api test` cover this subtask, including the SQLite journal tests, and `git diff --check` is clean. No live or local-fork transaction is sent by this journal subtask; transport is mocked in the recovery tests.
