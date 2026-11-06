# Settle contracts - Whitechain

Settle is a merchant checkout engine for USDT on Whitechain. Onchain stablecoin settlement lets a customer verify a payment or refund, lets a subscription payer verify a cap, and lets a merchant enforce a relayer gas budget without trusting a private service. A regular card or wire rail cannot expose those rules and receipts to every party in the same settlement transaction.

## Status

The suite includes a Router gas and reimbursement revision; its application activation is separate. These contracts are not proxies. Configure the API with each contract address (GasTank, Router, PaymentEscrow, SubscriptionManager) and the USDT settlement asset through environment variables or `<CONTRACT_ADDRESS>` placeholders. A freshly deployed tank is unfunded and has no merchant daily cap until one is set.

Chain ID: `1874`. Amounts use the assumed six USDT decimals. WBT means native gas token wei.

## Build and test

```sh
cd contracts
forge test
forge build
```

The project uses Solidity 0.8.26, Paris EVM, via-IR, OpenZeppelin Contracts 5.1 (MIT) and forge-std (Apache-2.0 / MIT). Dependencies are copied locally so no package installation is needed. `test/mocks/MockNoBoolUSDT.sol` deliberately omits return values from `transfer` and `transferFrom`; all production token transfers use `SafeERC20` except the subscription pull, which checks the optional return bytes directly so it can emit a durable refusal on token failure.

## Contracts and calls

- `InvestorRegistry` (invoice financing): officers `approve(investor, expiresAt, region)` or `revoke(investor)`, or sign an EIP-712 `Decision` that anyone submits with `decideWithSig` (so a relayer pays the gas). A `Decision` carries the officer's nonce and the investor's decision count, so one signed before a later decision about the same investor cannot run; `cancelNonce` (or a signed `Cancel` via `cancelNonceWithSig`) drops an unsent one. `isApproved` is approved and unexpired. The owner (two-step transfer; the officer role moves with ownership) appoints officers. Approvals last at most 400 days.
- `InvoiceReceivables` (invoice financing, beside the suite): a merchant `list`s an invoice as a claim with the customer's EIP-712 acknowledgement (domain "Pact Invoices": invoice id, merchant, customer, amount, due date), which the contract verifies; one open claim per invoice, one claim per acknowledgement, and an invoice sold or paid while listed stays pledged (`invoicePledged`) — both are freed only when a listing ends with nothing sold or paid. Constructor `predecessors` (prior deployments) are consulted too, so a redeploy cannot list what they pledged. Approved investors `buy(claimId, units)` (one unit is one micro-USDT of face value), or sign a `Purchase` (with an optional EIP-2612 USDT permit) that anyone submits with `buyWithSig`: in the same transaction the price is pulled, Pact's fee goes to the fee vault, a reserve stays in the contract and the rest goes to the merchant. `transfer` (or a signed `Transfer` via `transferWithSig`) moves units between approved investors until the record date; what they already received moves pro rata. Signed orders carry the signer's nonce and a deadline; `cancelNonce` (or a signed `Cancel` via `cancelNonceWithSig`) voids an unsent one. The customer `pay`s through the Router (the only allowlisted selector; `sponsorshipQuote` names the claim's merchant): while the listing is open only the acknowledging customer may pay, and each payment is at least the minimum share and leaves nothing or at least the minimum owed; the holders' share of each payment is paid to them pro rata in the same transaction, the merchant's kept part to the merchant. Paid in full: any late fee comes from the reserve and the rest returns to the merchant. After maturity plus the grace period anyone may `markDefault`: the reserve goes to the holders and the claim freezes; the merchant's `buyBack` pays the rest, and a later customer payment goes to the holders first. `closeListing` ends a listing at its record date. A payment a holder cannot receive is credited for `withdraw`. Signatures from EIP-7702-delegated EOAs are checked against their own key, other contracts through ERC-1271 (`Signatures.sol`). All rules are immutable constructor values; there is no admin. Tested in `test/InvoiceReceivables.t.sol`, including the Router path, signed orders and permits, a worst-case gas bound and a fuzzed balance invariant.
- `PaymentEscrow`: `authorize(id,merchant,amount,expiry,refundWindow)` locks payer USDT, `capture(id,amount)` settles to the merchant, `void(id)` releases uncaptured USDT, and `reclaim(id)` lets the payer recover after expiry. `charge(id,merchant,amount,refundWindow)` settles immediately. `refund(id,amount,reason)` pulls the merchant's USDT back to the payer while the refund window is open. A payment ID is single-use. Refund accounting enforces `refunded <= captured` and multiple partial refunds.
- `SubscriptionManager`: the payer signs an EIP-712 `Mandate` covering payer, merchant, plan ID, USDT amount cap, period length, maximum periods, end time, and nonce. Anyone submits it through `subscribe(mandate,signature)`. The merchant or keeper calls `charge(id,amount)`; policy refusals return `false` and emit `Refused(id,reason)`. The payer calls `cancel(id)` or atomically swaps mandates with `replace(oldId,newMandate,signature)`. A new billing period starts after each successful pull.
- `GasTank`: anyone can `deposit(merchant)`; only that merchant sets a daily WBT cap and withdraws unused balance. Only the bound Router can reimburse a relayer. Balances and daily spend are isolated by merchant.
- `Router`: the relayer calls `execute(intent,calldata,signature)`. The EIP-712 intent binds signer, merchant, target, calldata hash, quoted amount, actual USDT fee, nonce, deadline, and gas limit. The Router checks the target-selector allowlist, asks the target to quote the merchant and amount from calldata, checks the minimum amount, per-payer daily call cap, gas price and gas limit, merchant tank and daily WBT cap, and fee coverage at a configured USDT/WBT quote. It collects the committed USDT fee from the merchant before reimbursing the relayer in WBT. Policy refusals return `false` and emit `Refused` with a reason. For subscription renewal, the allowlist marks the bool return as a refusal when `false`.

The payer must approve the escrow or subscription manager to pull USDT. The merchant must approve the escrow for refunds and the Router for the USDT sponsorship fee. A merchant must fund its tank and set a nonzero daily cap before sponsored calls work. The target calls resolve the signed actor from Router context, so a relayer cannot substitute itself for the payer or merchant.

## Router gas and reimbursement semantics

`Intent.maxGas` is the target call allowance, not the outer transaction gas limit. The early check requires `gasleft() > maxGas + 80_000` after signature and selector validation. A smaller transaction can succeed at the EVM level while returning `(false, "")` and emitting `Refused(..., GasLimit)` (reason 7). A gas estimator can therefore find a cheap refusal path. Set an explicit outer gas limit, simulate with that same limit and relayer account, require the returned success flag, and inspect the Router's receipt events after submission. Increasing `maxGas` changes the signed intent and does not fix an insufficient outer limit.

The local Router also checks gas immediately before calling the target, after validation, storage writes and calldata copying. It reserves `maxGas / 63 + 120_000` beyond the target allowance to account for [EIP-150 forwarding](https://eips.ethereum.org/EIPS/eip-150) and settlement. Insufficient gas here reverts with `InsufficientExecutionGas()`, rolling back nonce, daily count and context. This is a conservative reserve for supported calls, not a guarantee for arbitrary token code, return data or relayer callbacks. Full-call simulation remains necessary.

The fee and tank preflight budget is `(maxGas + 40_000) * tx.gasprice`. In the local fix, reimbursement is the smaller of this budget and `(gasStart - gasleft() + 40_000) * tx.gasprice`. The existing deployed Router does **not** apply that cap: Router overhead plus a gas-heavy target can exceed the preflight budget, under-cover the debit with the quoted fee, or revert settlement at a tight tank/cap boundary. The cap protects the merchant; relayers bear any excess execution cost. The fixed USDT fee is still collected in full on success. Neither formula promises exact reimbursement of the transaction receipt's gas usage.

| Outcome | Nonce / payer daily count | Fee / reimbursement |
| --- | --- | --- |
| Early policy refusal, including reason 7 | Unchanged | None |
| Target revert or target out-of-gas (`TargetFailed`) | Consumed / incremented | None |
| Required bool is false (`TargetRefused`) | Consumed / incremented; successful target side effects are not rolled back | None |
| Outer revert, including late gas check or settlement failure | All transaction state rolled back | None |
| `Executed` | Consumed / incremented | Signed USDT fee and bounded WBT reimbursement |

An API-only explicit-gas and result-validation fix can preserve the original deployments for supported payment/refund flows. It does not install these source safeguards. GasTank's Router binding can only be set once, and sponsored targets store an immutable Router address; activating a new Router requires a coordinated new deployment/migration, fresh approvals and tank funding, and signatures for its new EIP-712 verifying contract. The updated Router contains the safeguards; the Router the API currently uses does not.

The deployed Router's `minAmount()` is `1_000_000`. That policy refuses a sponsored `500_000` (0.5-USDT) refund as `Dust`, independently of gas. Such a refund requires an explicitly authorized minimum-amount policy change or a direct merchant call to `PaymentEscrow.refund` with merchant-paid gas. Raising the signed amount to bypass the minimum fails quote matching. The contract regression demonstrates a 1-USDT charge, the half-USDT refusal, and a successful retry only after an explicit owner policy change; it does not change the default policy.

## Deployment script

`script/Deploy.s.sol` rejects every chain except `1874`. It reads `PRIVATE_KEY`, with optional `FEE_VAULT` and `KEEPER`, deploys all four contracts, binds GasTank to Router, and registers only the intended selectors. Run it only with a configured Whitechain RPC and funded deployer:

```sh
forge script script/Deploy.s.sol:Deploy --rpc-url "$WHITECHAIN_RPC_URL" --broadcast
```

No private key or RPC URL is stored in this repository. After deployment, set the Router's `usdtPerWBT` quote and limits to current values, configure each merchant's daily cap, and verify the contracts.

## Limits

The relayer must simulate before submitting, enforce its own per-minute circuit breaker, and avoid overfunding its hot wallet. WBT/USDT conversion is an owner-set quote, not an oracle; the owner must update it when gas economics change. A failed onchain policy call still consumes network gas from the relayer's own float, although Router refusals do not reimburse it from the merchant tank. EOA EIP-712 signatures are supported; ERC-1271 smart-account signatures and permit-based USDT pulls are future integrations. Keeper retry scheduling, webhooks, receipts UI, and CSV export are outside this contract package. No mainnet claims are made.

## Settlement asset

USDT with six decimals. The keeper and relayer share one account. Configure the asset and account addresses through environment variables. Not audited, testnet only.
