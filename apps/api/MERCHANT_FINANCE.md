# Merchant finance API

`GET /v1/fees/preview?maxGas=300000` accepts a merchant secret key, publishable key or authenticated merchant session. It is read-only and returns `Cache-Control: no-store`. The optional gas limit must be a positive integer within both API and Router limits. The response preserves money and block numbers as decimal strings.

The chain adapter reads Router token, conversion rate, minimum amount and gas ceilings at one block on chain 1874. The fee floor is `ceil((maxGas + 40000) * gasPriceWei * usdtPerWbtMinor / 1e18)`. This conversion rate is the Router administrator's billing configuration, not a market quote. Submission repeats policy validation; a preview neither reserves a nonce nor guarantees execution. Invalid limits return 422; unavailable chain reads return 503.

`GET /v1/dashboard` remains merchant-private. Its `balance` is the official six-decimal USDT balance of the bound merchant wallet, validated against both Router and escrow token bindings at a pinned block. It is distinct from sales or net revenue. An unavailable read reports `available: false` and null amount/block, never a fabricated zero. Wallet and gas-tank reads have independent 2.5-second deadlines.

Lifetime captured/refunded/fee totals, 14-day volume, today's activity and gas-runway spending use the confirmed accounting ledger. Payments and subscription charges both contribute to revenue. Day boundaries are UTC and use confirmed block timestamps. `accountingComplete` exposes historical coverage; incomplete history is not silently reconstructed from creation times. Payment status counts remain based on indexed payment rows. `metrics.financedInvoices` reflects existing indexed invoice state; it does not enable financing.

The SDK exposes `client.fees.preview(maxGas?)` and optional new dashboard fields for compatibility with older API versions. Current wallet balance is exact; runway is a display estimate based on today's indexed spend.

## Verification and remaining work

The full API suite passed 315 tests; core/node SDK tests passed 43. After switching lifetime totals to the accounting ledger, all 22 focused finance/dashboard regressions passed. Type checks and core/node builds also run before integration. The child-process ownership test suite now allows 15 seconds under concurrent worker load; its lock behavior and assertions are unchanged.

An isolated official-token fork check confirms that adapter reads return the merchant wallet balance separately from confirmed payment revenue and read the Router fee policy correctly. Approval and payment transactions in that check are local only; the payer retains zero WBT.

Browser authentication/balance binding, alternative payout addresses and live runtime rollout remain separate unfinished requirements. No live transaction, credential change or runtime activation is part of this change.
