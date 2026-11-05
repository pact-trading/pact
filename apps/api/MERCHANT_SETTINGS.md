# Merchant checkout settings and refund terms

`GET /v1/settings` and `POST /v1/settings` require a merchant session or secret API key. Publishable keys cannot read private settings or modify them. Updates accept `Idempotency-Key` and only these fields:

```json
{
  "brandName": "Northstar Studio",
  "logoUrl": "https://assets.example/logo.png",
  "refundWindowSeconds": 2592000
}
```

Fields can be omitted to retain their values. Brand names are plain text, at most 200 characters without control characters. Logo URLs must use HTTPS without embedded credentials; null clears a logo. The API stores the URL and never fetches it. Refund windows are integer seconds from 1 through 31,536,000 (365 days), defaulting to 2,592,000 (30 days).

Private settings also report the actual bound `payoutAddress`, `payoutMode: "merchant_wallet"`, and webhook URL/configured status. They never return the webhook signing secret. Use the existing `/v1/webhooks/config` endpoint to configure/rotate that secret. Payout changes are not accepted: the current PaymentEscrow pays the merchant address itself. A separate payout destination and fee-preview settings remain M1 work; neither is falsely represented as active by this endpoint.

`GET /v1/config` and payment details expose only the public `checkout` projection (brand name, logo URL and current default refund window). Rendering names as text and loading the merchant logo are the checkout client's responsibility; browser branding UI integration remains separate.

## Payment policy snapshots

Regular payment creation and both invoice-payment entry points write a refund-window snapshot inside the same database transaction as the payment. Creation and detail responses return `refundWindowSeconds`. A later settings update affects future payments only. When signing a new `charge` or `authorize`, use this payment field, not the current `/v1/config` default. The API decodes the calldata and rejects `refund_window_mismatch` before reserving or broadcasting a transaction.

Legacy payments without a snapshot return null. Existing signed requests remain usable; the migration does not invent historical promises. The hosted server charge encoder uses the snapshot when present, retaining its former 30-day fallback only for legacy rows/API versions.

## Confirmed contract terms

For escrow Authorized, Charged and Captured events, the Viem adapter reads `payments(id)` from the configured contract at the event's block. The indexer records the actual `refundWindow` and `refundDeadline`. It does not derive a deadline from local indexing time or today's settings.

Payment detail fields:

- `refundWindowSeconds`: original API policy snapshot, number or null.
- `onchainRefundWindowSeconds`: confirmed contract window as an exact integer string, or null before indexing.
- `refundDeadlineUnix`: confirmed Unix deadline as an exact integer string, or null before indexing; zero means the refund window has not opened.
- `refundDeadline`: ISO representation when the nonzero deadline fits JavaScript Date, otherwise null. Exact uint64 values remain available in `refundDeadlineUnix`.

The refund endpoint uses the confirmed Unix value when available and preserves the contract's inclusive boundary: the deadline second is still allowed; the following second is refused. Contract execution/simulation remains the final authority. Subsequent captures do not restart the contract's window; settings updates and duplicate indexing cannot extend it.

Changing a local API setting cannot prevent a user from calling a public contract directly with different calldata. The separate confirmed fields report what actually happened onchain instead of rewriting the original API snapshot.

## SDK

```ts
const settings = await client.settings.get();
await client.settings.update({ brandName: 'Northstar', refundWindowSeconds: 604800 });
const payment = await client.payments.create({ amount: '2' });
// Encode charge(..., BigInt(payment.refundWindowSeconds)) for this payment.
```

Local regression tests cover merchant isolation, public-key restrictions, unsafe values, persistence/idempotency, regular/invoice snapshots, signed-policy mismatch, actual deadlines, legacy rows, duplicate captures and exact timestamp boundaries. `scripts/check-checkout-approval.ts` additionally checks a seven-day snapshot against block-pinned escrow state on an isolated official-token fork after changing the default back to 30 days. It never sends to the remote chain.
