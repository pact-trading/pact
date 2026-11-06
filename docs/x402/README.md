# M8 x402 - local completion and activation gates

The explicit funded payment variant now has [production journal/ports integration and recovery](FUNDED_JOURNAL.md), with official-client local-fork evidence through the existing AccountWriter. Production remains inactive pending genuine merchant authority, shared merchant Router nonce allocation, deployment/configuration and the other documented gates. Bootstrap/reservation sponsorship remains disabled.

This branch implements official x402 v2 Permit2 exact and upto settlement and an isolated account policy. It has not activated a live facilitator or deployed/transferred funds on Whitechain. The SQLite journal and reservation adapters are now implemented; see [SQLite integration ports and recovery](SQLITE_JOURNAL.md). The optional `createApp({ x402 })` injection leaves the existing runtime closed until root supplies the journal and authentication adapters. `/health` includes x402 readiness; `/supported` advertises both schemes only after runtime attestation. The inactive API preserves its existing 501 settlement response.

## Reproduce

From repository root, with Node 22, pnpm 11 and Foundry installed:

```sh
pnpm --dir apps/api install --frozen-lockfile
forge build --root contracts/x402-reference
forge build --root contracts
pnpm --dir apps/api typecheck
pnpm --dir apps/api test
forge test --root contracts
pnpm --dir apps/api run test:x402-fork
```

`test:x402-fork` starts and cleans up its own Anvil process on an ephemeral loopback port, forks public Whitechain at a pinned archive block, and validates Anvil identity before any writes. It reads no dotenv, wallet file or runtime secret. Public synthetic keys exist only in this script. Native balances are local Anvil funding. An existing USDT holder is impersonated locally to transfer 1 USDT from its existing balance. No token code, token balances or storage are overridden; no minting or mock token is used. Account unit tests exercise policy separately.

The harness deploys the missing canonical upto proxy using the actual CREATE2 deployer and official initcode, and deploys an exact copy solely to compare the canonical exact runtime against pinned upstream initcode. It uses ordinary official `@x402/hono` payment middleware with a configured `HTTPFacilitatorClient`, and ordinary official `@x402/fetch` with exact/upto schemes. Whitechain USDT is an explicit `spendControls.allowedAssets` entry, as required by 2.29.0. The account signer is an ordinary signer adapter, not a fork of the client or protocol.

The local public client polls real receipts by hash because the block-driven viem waiter can intermittently time out after Anvil has already mined a successful receipt. The production adapter uses the provided public client's receipt waiter. Any transaction hashes the harness prints are local fork hashes, **not live explorer links**. Random official Permit2 nonces and wall-clock deadlines change them each run. Network access to the pinned archive state is required. Reservations intentionally refuse deadlines that cross UTC midnight; do not start the two-minute demo immediately before midnight.

To refresh read-only deployment inspection and unsigned calldata:

```sh
pnpm --dir apps/api run x402:prepare
```

This reads public Whitechain and Ethereum RPCs; it never constructs a wallet. Commit/review refreshed runtime manifests before activation; never learn trusted runtime hashes from the deployment RPC at startup.

## Canonical runtime verification

Before any settlement path is used, the harness and the read-only inspection check each canonical
component on Whitechain against independently pinned official values:

| Component | Expectation |
| --- | --- |
| Official USDT | present; 6 decimals |
| Canonical Permit2 | present; runtime matches canonical Ethereum Permit2 except the two constructor immutables |
| Canonical exact proxy | present; local deployment of official initcode yields an identical runtime |
| Canonical upto proxy | absent until a separately authorized deployment |
| CREATE2 deployer | present |

Permit2's runtime differs from Ethereum's only in the two constructor immutables from the pinned [Uniswap EIP712 source](https://github.com/Uniswap/permit2/blob/cc56ad0f3439c502c246fc5cfcc3db92bb8b7219/src/EIP712.sol): the chain ID and the domain separator. The inspection validates their expected values for each chain, then compares every remaining byte. This is stronger than checking nonempty code or the Permit2 getter alone. The expected runtime keccak256 hashes for Permit2 and the exact and upto proxies are pinned in the reference manifests.

The isolated reference project uses solc **0.8.28**, Cancun, optimizer 200, no IR, no CBOR or bytecode hash, exactly matching upstream upto. The application contracts retain **0.8.26 / Paris / via-IR**. Do not compile the canonical proxy under the application settings: that changes its CREATE2 address. The reference source subset and dependency pins are in `THIRD_PARTY.md`. The deployment artifact includes the upto proxy's salt and complete unsigned calldata.

Permit2 is already present, so this task does not include a replacement Permit2 deployment. If it becomes absent on another network, halt activation and prepare the official deterministic Permit2 deployment separately. Noncanonical addresses are not a substitute: these pinned clients use canonical constants.

## Account policy and bootstrap

`X402AgentAccount` is a separate MIT local artifact, not a change to the existing payer account or `SponsoredApprover`. Its owner configures a session key, per-call ceiling, UTC-day ceiling, expiry and at most 32 merchants. Session rotation preserves the day's spending. Revocation invalidates already-reserved signatures. Only fixed Whitechain USDT and the canonical exact/upto witness formats are signable.

ERC-1271 is read-only, so it cannot atomically increment spending during signature validation. The account first reserves the **full signed ceiling** using `reserve(payment, signature)`, callable by a gas-paying relayer. Reservations count even if unused or upto settles less. They cannot be refunded or reused, and their deadlines cannot cross the current day or session expiry. The official proxy and Permit2 then enforce one-use transfer nonces. This deliberately conservative accounting prevents concurrent signatures from overspending a daily budget without changing official proxy behavior.

The session signs an account-domain `Reservation(permitDigest, epoch)` message. Both the account address and epoch are bound in addition to Permit2's digest, which itself does not include the owner account. This prevents the same session key's signature being reused across accounts. `createX402AccountSigner` hashes the standard official typed data, requests that account-domain signature, waits for a journaled reservation confirmation, then returns the signature through the standard client signer interface. An EOA session key is the tested local signer. Passkey owner/session enrollment remains root's account integration responsibility.

`bootstrap(amount, deadline, ownerSignature)` permits only `USDT.approve(canonical Permit2, amount)`, uses SafeERC20 `forceApprove`, caps approval at **100 USDT**, limits signature validity to ten minutes at execution, and consumes an owner nonce. Amount zero revokes allowance. ERC-20 allowance has no time expiry; the session policy and short-lived payment signatures restrict its use, and the owner can revoke it. There is no arbitrary target, spender, selector or calldata path. Owner-only USDT withdrawal supports recovery.

For M7 sponsorship, root must add a dedicated account bootstrap/reservation action that authenticates an onboarded account and binds merchant tank, account, method, amount, nonce and deadline in the Router intent. It must simulate, apply target gas limits, rate limits, per-payer counts and merchant daily budgets, and reimburse only the bound merchant's tank. Deployment/configuration of the new account must be equally bounded. **Do not broaden the existing escrow-only SponsoredApprover.** The local harness proves a relayer can pay native gas while the payer has zero WBT; it does not claim Router reimbursement is wired. Cap refusals in the fork are EVM simulation/revert results, not durable onchain refusal events.

## Root integration contract

`api/src/x402/journal.ts` defines the production boundary. `SqliteX402Journal` and `SqliteAccountReservationAdapter` now implement persistence through the existing AccountWriter. Root must connect the explicit prepare/read/broadcast ports and M7 policy; no separate production signer is supplied.

- `runOnce(operation, execute)` uses the single shared AccountWriter owner, persists results and reconciles uncertain sends without resending. Identity is chain + payer + Permit2 nonce, shared across both schemes. A different payload/requirements fingerprint on the same identity must be refused. Return the original receipt for identical completed retries.
- `submit(operation, transaction)` must use the shared durable relayer journal and shared nonce allocator. AccountWriter persists hash/nonce/phase before broadcast, not raw bytes. Never re-sign or resend ambiguous writes. Enforce fee ceilings, merchant tank funding, daily gas budgets and counts before signing. Never recycle unknown nonces. The module fixes chain 1874, value zero, target to one of the two proxies, selector `settle`, no data suffix, and bounded gas (maximum configuration 1,000,000).
- `pending` uses the SQLite implementation of the official `PendingSettlementStore` within the single-writer deployment. It supplements the durable writer; it does not replace atomic operation ownership or signing/broadcast journaling.
- `SqliteAccountReservationAdapter.reserve` uses that shared journal, deduplicate by account + digest, and wait for a successful receipt before exposing the signature. Bootstrap and account deployment/configuration are additional journaled operations owned by root.
- `X402Service.authorize(request, payTo)` must authenticate a merchant secret and compare its registered address to `payTo`. Configure the official resource-server facilitator client with its standard auth-header callback. Do not expose settlement as an unauthenticated free-gas relay.

`Permit2Facilitator` requires explicit merchant addresses, amount/gas limits and trusted runtime hashes. Call `initialize()` before injecting it into `createApp`. It fails closed on chain/runtime/Permit2/USDT-decimal mismatch. It rejects other assets, networks, schemes, arbitrary transactions, all sponsorship extensions and unbounded deadlines. The production module cannot deploy wallets, use EIP-6492 factories or sign from an environment key. Metrics are process-local counters, not a durable billing ledger.

## Remaining activation requirements

1. Root reviews/integrates this branch and the separate shared-journal worker. Connect the implemented SQLite adapters to the real chain ports and authenticated merchant binding. The tests exercise restart, timeout and shared-writer budgets; root must enforce single-process ownership and validate the real transport/reconciliation integration.
2. Obtain explicit authorization for the **live** canonical upto deployment. Recheck current runtimes, CREATE2 calldata/hash and chain Cancun opcode support read-only. After approved deployment, verify source/runtime and `PERMIT2()` and rerun the runtime gate. Nothing here authorizes that broadcast.
3. Review and integrate the isolated account artifact with the intended passkey/account product; owner/configuration/revocation enrollment and sponsored account deployment are not connected to M6. Add the bounded M7 bootstrap/reservation route and reimbursement wiring described above, then prove merchant tank accounting.
4. Configure merchant auth, gas budgets, fee ceilings, confirmed receipt/finality policy, durable refusal/audit records, operational rate limits and monitored RPC retries. The current test uses one-confirmation local receipts, not a production finality claim.
5. Only after authorization, run live official-USDT exact/upto and ten-call/cap demo and audit with root. A local fork cannot substitute for live acceptance. Plain-wallet `erc20ApprovalGasSponsoring` remains P2 and is intentionally not advertised.
