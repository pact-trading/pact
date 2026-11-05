# Confirmed accounting export

`GET /v1/export?from=<YYYY-MM-DD>&to=<YYYY-MM-DD>&format=json` uses inclusive UTC calendar dates. `format=csv` returns the same entries and totals. Invalid/reversed dates and unknown formats are rejected. Merchant secret authentication is required.

The additive `accounting_entries` ledger records verified PaymentEscrow captures/charges/refunds, SubscriptionManager charges, and Router fees/reimbursements. Every entry uses its confirmed block timestamp and unique event identity. A payment created in October and captured in November belongs to November's cash report. Multiple captures remain separate entries. Subscription revenue and fees for non-payment operations are no longer omitted. Duplicate indexing is harmless.

Fees have their own rows so one transaction's fee and reimbursement cannot be counted twice across multiple related objects. Refund rows are negative and retain the original payment ID. Invoice rows are informational; issuing an invoice is not cash receipt and does not inflate cash totals. All USDT and wei aggregation uses integers. CSV escapes potentially executable spreadsheet text. Optional WBT/USD values are labeled estimates and are not used in reconciliation.

`netUSDT` is gross less the quoted fee. `tokenDeltaUSDT` is the known token movement for these indexed suite operations; self-transfers, including a merchant paying its own fee vault, contribute zero movement. Unknown payer/fee-recipient evidence yields `null`, not an invented zero. External wallet transfers are outside this ledger, so a complete wallet reconciliation must also account for those. Gas WBT is the amount reimbursed from the merchant tank, not the relayer's entire transaction fee.

## Existing database upgrade

Keep a consistent SQLite backup before starting the upgraded API. A database containing historical chain events starts with incomplete accounting coverage; exports return `409 accounting_backfill_required` until the accepted events are recovered. Neither payment creation timestamps nor accumulated current balances are substituted for missing event history.

Run from `apps/api`, with `DATABASE_PATH`, `RPC_URL`, `ROUTER_ADDRESS`, `ESCROW_ADDRESS`, `SUBSCRIPTION_ADDRESS`, `GAS_TANK_ADDRESS` and optional `CONFIRMATIONS=2`:

```sh
node --env-file=/path/to/accounting-read-config.env --import tsx scripts/backfill-accounting.ts
```

The configuration needs no private key. The helper uses only chain ID/block/receipt reads and writes the additive accounting tables. It leaves payment/refund/subscription state and indexer cursors unchanged. Only event identities already accepted by the original indexer are eligible. Missing, unconfirmed, mismatched, or incomplete receipts remain unresolved; repeated runs do not duplicate entries. If the existing financial totals still disagree with recovered captures/refunds, exports remain closed for reconciliation.
