# Invoice API

These endpoints require the merchant secret API key. Publishable keys cannot read customer email/memo/line items or reserve invoice amounts. Hosted checkout must call them through its server boundary.

| Method | Path | Result |
| --- | --- | --- |
| POST | `/v1/invoices` | Create draft or sent invoice |
| GET | `/v1/invoices` | Latest 100 invoices belonging to this merchant |
| GET | `/v1/invoices/:id` | Invoice, line items, paid and outstanding amounts |
| POST | `/v1/invoices/:id/send` | Publish a draft; repeated send on a sent invoice is harmless |
| POST | `/v1/invoices/:id/payments` | Reserve a checkout payment against the outstanding invoice balance |

Creation accepts `customerEmail`, `amount` or `lines`, optional `dueAt`, `allowPartial`, `memo`, `metadata`, and `status` (`draft` or `sent`; default `sent` for existing clients). Each line has `description`, positive integer `quantity` (default 1), and `unitAmount`. USDT values are decimal strings with up to six decimal places. When both total and lines are supplied they must agree exactly. The existing `payer_email`, `due_date`, `allow_partial`, and `unit_amount` aliases remain supported.

Drafts cannot be paid and do not generate due reminders. `send` publishes the invoice and queues `invoice.sent`; it does not claim that an email provider delivered mail. The keeper continues to record due reminders and queue reminder/overdue webhooks.

Payment creation accepts `{ "amount": "2.00" }` for a partial payment when enabled, or `{}` for the full outstanding balance. Open/unsettled checkouts reserve their amounts immediately, before yielding to another request. Generic `/v1/payments` with `metadata.invoiceId` uses the same policy and requires a secret key. Overbooking and partial payments on a full-payment-only invoice are refused. Reuse an `Idempotency-Key` when retrying creation; do not create another checkout for a pending payment.

Only confirmed chain events update `paid` and the financial status; a checkout URL is not evidence of receipt. Duplicate indexed events do not count twice. Refunds remain a separate financial record and do not silently reopen a paid invoice. Uncertain attempts, and attempts whose link has passed its `expires_at`, keep their reservation until their payment is definitively closed. Elapsed time alone never proves that a signed transaction was not sent.

## Payer checkout on the hosted invoice page

`POST /v1/commerce/me/invoices/:id/payments` is the payer's Pay button. A payer can leave checkout and come back as often as they like:

- If the payer already has an `open` attempt for the same amount, the API returns it with `200`. Any new attempt is created with `201`. The escrow accepts each payment id only once, so reusing an attempt can never charge twice.
- The payer's other unpaid attempts (`open` or `failed`, nothing captured) get status `expired` and stop reserving the balance once nothing signed for them can still execute. That requires no submitted charge still unsettled, and every charge signed for the attempt, or offered for signing (`hosted_intent_offers`), past its Router deadline plus 60 seconds of clock skew. The Router refuses a charge after its deadline, so this relies on the signed deadline, not on elapsed time.
- An attempt that might still execute keeps its reservation. If it is what blocks the new amount, the refusal is `invoice_payment_in_progress`. Offered charges are signable for 5 minutes, so this clears within minutes unless a charge was actually submitted.
- An attempt whose sponsored approval failed is never reused, because an approval cannot be retried for the same payment.

The merchant routes above are unchanged: they never reuse or expire attempts.

The server SDK exposes `invoices.create`, `get`, `list`, `send`, and `createPayment`. `hostedUrl` retains the existing `/invoices/:id` URL contract; the hosted invoice page is a separate integration deliverable and is not established by these backend tests. Onchain acknowledgement/financing belongs to the receivables integration and is not implemented by marking an invoice sent.
