import type { Address, Hex } from 'viem';
import type { Intent, Mandate } from './typed-data.js';

export interface ListResponse<T> { data: T[] }
export interface IdentitySession {
  userId: string; sessionId: string; expiresAt: number;
  wallet: { address: Address; id: string | null }; email: string | null;
}
export interface MerchantRegistration { merchantId: string; address: Address; created: boolean }
export interface CheckoutSettings { brandName: string; logoUrl: string | null; refundWindowSeconds: number }
export type MerchantSettingsUpdate = Partial<CheckoutSettings>;
export interface MerchantSettings extends CheckoutSettings {
  payoutAddress: Address; payoutMode: 'merchant_wallet'; webhook: { url: string | null; configured: boolean };
}
/**
 * Read-only gas quote. Pact's fee comes out of each payment (see FeesDetail); this only says what the
 * network fee of a merchant-paid call (a refund, a buy-back) can cost at most, in USDT.
 */
export interface FeePreview {
  chainId: number; blockNumber: string; targetGas: number; gasPriceWei: string;
  /** USDT base units per 1 WBT, as the FeeSchedule converts gas. */
  usdtPerWbtMinor: string;
  /** The most a merchant-paid call of `targetGas` can cost in USDT base units. */
  maximumGasFeeMinor: string;
  minimumAmountMinor: string;
}
export interface ApiConfig {
  chainId: number; merchant: Address; router: Address; escrow: Address; subscription: Address;
  /** The FeeSchedule the merchant signs its fee terms with. */
  fees: Address;
  checkout?: CheckoutSettings;
}
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'refunded';
export type FinancialStatus = 'open' | 'authorized' | 'captured' | 'partially_refunded' | 'refunded' | 'failed' | 'voided' | 'expired' | 'reconciliation_required';
export interface PaymentRequest {
  /** Decimal USDT, not base units. */
  amount: string;
  currency?: 'USDT';
  email?: string;
  description?: string;
  expires_in?: number;
  /** Retained for existing checkout adapters; the current API does not consume it. */
  returnUrl?: string;
  metadata?: Record<string, string | number | boolean>;
}
/** Common create/detail shape retained for existing checkout consumers. */
export interface Payment {
  id: string; amount: string; currency: 'USDT'; status: PaymentStatus;
  checkoutUrl?: string; financialStatus?: FinancialStatus;
  /** Snapshot for new payments; null on legacy rows without a recorded policy. */
  refundWindowSeconds?: number | null;
}
export interface PaymentCreated extends Payment { status: 'pending'; financialStatus: 'open'; checkoutUrl: string }
export interface PaymentDetails extends Payment {
  financialStatus: FinancialStatus; description: string | null; customer: string | null;
  payer: Address | null; merchant: Address; createdAt: string;
  /** Your data and the customer's answers. Returned only to a secret key or dashboard session. */
  metadata?: Record<string, string | number | boolean>;
  /** Decimal USDT strings; never infer capture from a submitted transaction. */
  captured: string; refunded: string; txHash: Hex | null;
  refundDeadline?: string | null;
  refundDeadlineUnix?: string | null;
  onchainRefundWindowSeconds?: string | null;
  checkout?: CheckoutSettings;
}
/** The list endpoint returns raw financial status, not PaymentStatus. */
export interface PaymentListItem {
  id: string; amount: string; currency: 'USDT'; description: string | null; customer: string | null;
  payer: Address | null; status: FinancialStatus; txHash: Hex | null; createdAt: string;
  metadata?: Record<string, string | number | boolean>;
}
export interface IntentRequest { intent: Intent; signature: Hex; data: Hex }
export type IntentStatus = 'submitted' | 'confirmed' | 'failed' | 'refused' | 'reconciliation_required';
export interface IntentSubmission { id: string; status: IntentStatus; txHash: Hex | null }
/** A merchant-signed Router refund call is mandatory, including when amount is omitted. */
export interface RefundRequest extends IntentRequest { amount?: string; reason?: string }
export type RefundStatus = 'pending' | 'succeeded' | 'failed';
export interface Refund { id: string; paymentId: string; status: RefundStatus; txHash?: Hex | null }
export interface RefundSubmission extends Refund { status: 'pending'; txHash: Hex }
export interface RefundDetails extends Refund { amount: string; reason: string | null; customer: string | null; txHash: Hex | null; createdAt: string }

export interface InvoiceLineRequest { description: string; quantity?: number; unitAmount: string }
export interface InvoiceRequest {
  customerEmail: string; amount?: string; lines?: InvoiceLineRequest[]; dueAt?: string;
  allowPartial?: boolean; status?: 'draft' | 'sent'; memo?: string; metadata?: Record<string, string>;
}
export type InvoiceStatus = 'draft' | 'sent' | 'acknowledged' | 'partially_paid' | 'paid' | 'overdue';
export interface Invoice {
  id: string; status: InvoiceStatus; hostedUrl: string; customerEmail: string; amount: string; paid: string;
  remaining: string; allowPartial: boolean; dueAt: string | null; memo: string; metadata: Record<string, unknown>; createdAt: string;
  lines: Array<InvoiceLineRequest & { id: string; quantity: number; amount: string }>;
}
export interface InvoicePayment extends PaymentCreated { invoiceId: string }

/**
 * Invoice financing. `eligible`: can be listed; `requested`: listed for investors; `funded`: investors
 * hold it; `overdue`: past maturity and unpaid; `defaulted`: the grace period ended unpaid; `repaid`;
 * `bought_back`. Null on an invoice that cannot be financed now (see `ineligibleReason`).
 */
export type FinancingStatus = 'eligible' | 'requested' | 'funded' | 'overdue' | 'defaulted' | 'repaid' | 'bought_back';
/** One invoice in financing, as the merchant sees it. Amounts are in USDT minor units (six decimals). */
export interface FinancedInvoice {
  invoiceId: string; number: string; status: FinancingStatus | null; ineligibleReason: string | null;
  terms: { faceMinor: string; discountBps: number; priceMinor: string; feeMinor: string; reserveMinor: string; upfrontMinor: string; netAdvanceMinor: string; maturityAt: string; graceEndsAt: string; recordDateAt: string };
  funding: { soldMinor: string; unsoldMinor: string; open: boolean; upfrontMinor: string };
  holders: Array<{ id: string; organization: string; faceMinor: string; receivedMinor: string; owedMinor: string }>;
  reserve: { heldMinor: string; releasedMinor: string; toInvestorsMinor: string };
  buyBackMinor: string; receivedMinor: string; outstandingMinor: string; late: boolean; frozen: boolean;
  timeline: Array<{ id: string; at: string; kind: string; title: string; detail: string; amountMinor: string | null; txHash: string | null }>;
  [field: string]: unknown;
}
export interface FinancingOverview {
  invoices: FinancedInvoice[];
  totals: Record<FinancingStatus, { count: number; faceMinor: string }>;
  advancedMinor: string; reserveHeldMinor: string; forwardedMinor: string; buyBackOwedMinor: string; ineligibleCount: number;
}
/**
 * EIP-712 messages the merchant signs, in order (any USDT permits first), and the order to send back
 * with the signatures to the matching relay method. Pact's relayer submits it: the merchant needs no WBT.
 */
export interface PreparedFinancingSignature {
  title: string;
  lines: Array<{ label: string; value: string }>;
  typedData: Array<Record<string, unknown>>;
  order: Record<string, string>;
}
/** The prepared order and the signatures of its typedData, in the same order. */
export interface SignedFinancingOrder { order: Record<string, string>; signatures: Hex[] }

export interface SubscriptionPlanRequest { name: string; amount: string; periodSeconds: number; maxPeriods?: number; trialDays?: number }
export interface SubscriptionPlan { trialDays?: number; id: string; name: string; amount: string; periodSeconds: number; maxPeriods: number | null }
/** The payer's signed mandate. Registering costs neither side anything: Pact's relayer pays the gas. */
export interface SubscriptionRequest { planId: string; mandate: Mandate; signature: Hex; discountCode?: string }
/** Payer-signed Cancel typed data (see `cancellationTypedData`). Deadline is Unix seconds, <= now+300. */
export interface CancellationRequest { deadline: bigint; signature: Hex }
/** A merchant's own cancellation: off chain, effective at once; no payer signature. */
export interface MerchantCancellationRequest { by: 'merchant' }
export interface SubscriptionReplacementRequest extends IntentRequest { planId: string }
export interface SubscriptionReplacement { id: string; chainId: Hex; replaces: string; status: string; txHash: Hex | null }
export interface SubscriptionCreated { id: string; chainId: Hex; status: 'pending' | 'trialing' | 'active'; trialEndsAt?: string | null; txHash: Hex }
export type SubscriptionStatus = 'trialing' | 'pending' | 'active' | 'past_due' | 'paused' | 'cancelled' | 'failed' | 'reconciliation_required';
export interface Subscription {
  id: string;
  /** On-chain subscription identifier (bytes32), NOT network chain ID 1874. */
  chainId: Hex | null;
  payer: Address | null; planId: string; plan: string; amount: string; periodSeconds: number; maxPeriods: number | null;
  status: SubscriptionStatus; trialEndsAt?: string | null; nextChargeAt: string; createdAt: string;
}
export interface RenewalStatus { id: string; state: string; reason: string; operationId?: string; txHash?: Hex }
/** "Run renewal now": the keeper sends the charge and the contract decides. A refusal names its reason. */
export interface RenewalResult { id: string; status: 'charged' | 'refused' | 'submitted'; txHash: Hex; refusal: string | null; subscription: Subscription }
export interface SubscriptionMutation { id: string; status: 'submitted'; txHash: Hex }
export interface MerchantCancellation { id: string; status: 'cancelled'; cancelledAt: string; cancelledBy: 'merchant' }
export interface MandateNonce { nonce: string }

export type ApprovalStatus = 'needs_funding' | 'needs_approval' | 'ready' | 'pending' | 'unavailable';
/**
 * Whether the owner's USDT can be pulled, and when not, the EIP-2612 permit to sign (`typedData`):
 * Pact's relayer submits it and pays the gas.
 */
export interface ApprovalReadiness {
  paymentId: string; payer: Address; chainId: number; token: Address; spender: Address;
  /** Decimal base-unit strings (6 USDT decimals), unlike Payment.amount. */
  amount: string; balance: string | null; allowance: string | null;
  permitNonce: string | null; deadline: string | null;
  /** JSON-safe EIP-712 permit typed data (bigints as strings); present when status is needs_approval. */
  typedData: Record<string, unknown> | null;
  status: ApprovalStatus; reason?: string; attemptId?: string; txHash?: Hex | null;
}
/** The signed permit. `nonce` is optional; the API checks it against the token when given. */
export interface ApprovalRequest { payer: Address; deadline: bigint | string; signature: Hex; nonce?: bigint | string }
export interface PermitSignature { deadline: bigint | string; signature: Hex; nonce?: bigint | string }
export interface RefusalAttempt { id: string; objectId: string; reason: string; txHash: Hex | null; createdAt: string }
/**
 * Refusal codes specific to fees. `fee_terms_required`: the merchant has not signed Pact's fee terms.
 * `fee_below_gas`: the minimum fee no longer covers the gas (a stale WBT price). `gas_fee_unavailable`:
 * the merchant cannot cover a refund's network fee. `signer_not_merchant`: a call that spends the
 * merchant's money was signed by someone else. `amount_below_fee`: the payment is smaller than the
 * minimum fee. `sponsorship_budget`: Pact covered all the free activity it can for this merchant today.
 */
export type FeeRefusalCode = 'fee_terms_required' | 'fee_below_gas' | 'gas_fee_unavailable' | 'signer_not_merchant' | 'amount_below_fee' | 'sponsorship_budget';

/** One product's rate, for display: `bps` of the amount, at least `minimumUsdt`, at most `capUsdt`. */
export interface FeeRateView { bps: number; percent: string; minimumUsdt: string; capUsdt: string | null }
/** Checkout covers payments, captures and subscription renewals; invoice covers invoices the merchant sent. */
export interface FeeTermsView { checkout: FeeRateView; invoice: FeeRateView }
export interface FeeTermsStatus {
  /** 0 until the merchant signs: Pact cannot take its payments before then. */
  acceptedVersion: number; latestVersion: number;
  accepted: FeeTermsView | null; latest: FeeTermsView;
  needsAcceptance: boolean; newerTermsAvailable: boolean;
}
/** The standing USDT allowances a merchant signs once as permits. Each is spent only on calls it signs. */
export type MerchantSpender = 'escrow' | 'router';
export interface MerchantPermit { spender: MerchantSpender; label: string; address: Address; status: ApprovalStatus; reason: string | null }
export interface FeeLedgerEntry {
  id: string; at: string; kind: 'Payment' | 'Subscription' | 'Fee' | string; label: string; objectId: string;
  /** Decimal USDT. A refund's network fee has no gross. */
  grossUsdt: string; feeUsdt: string; netUsdt: string; txHash: Hex;
}
export interface FeesDetail {
  terms: FeeTermsStatus;
  permits: MerchantPermit[];
  /** Terms signed and every permit in place: refunds can be sent. */
  ready: boolean;
  totals: { days: number; grossUsdt: string; feesUsdt: string; netUsdt: string; payments: number; effectiveRateBps: number | null };
  ledger: FeeLedgerEntry[];
}
/** The latest terms and the EIP-712 `AcceptTerms` typed data to sign for them. */
export interface FeeTermsOffer { version: number; terms: FeeTermsView; deadline: string; nonce: string; typedData: Record<string, unknown> }
export interface AcceptTermsRequest { version: number; deadline: bigint | string; signature: Hex }
export type AcceptedTerms = FeeTermsStatus & { txHash?: Hex };

export interface ExportRequest { from?: string; to?: string; format?: 'json' | 'csv' }
export interface ExportReport {
  rows: Array<Record<string, string>>;
  totals: { grossUSDT: string; discountsUSDT?: string; feesUSDT: string; netUSDT: string; tokenDeltaUSDT: string | null };
  accountingBasis: string;
}

export type PaymentLinkRequest =
  | { kind: 'product'; name: string; amount: string }
  | { kind: 'tip'; name: string };
export interface PaymentLink {
  id: string; kind: PaymentLinkRequest['kind']; name: string; amount: string | null; periodSeconds: number | null;
  status: 'active' | 'inactive'; visits: number; createdAt: string; url: string;
}
/** These administrative endpoints use snake_case in their actual responses. */
export interface WebhookEvent { id: string; type: string; object_id: string; created_at: string }
export interface WebhookDelivery {
  id: string; event_id: string; attempt: number; status: 'pending' | 'delivered' | 'failed'; next_at: string;
  last_http_status: number | null; last_error: string | null; delivered_at: string | null;
}
export interface ApiKeyCreated { id: string; kind: 'publishable' | 'secret'; key: string }
export interface DashboardSummary {
  generatedAt: string; timeZone: 'UTC';
  accountingComplete?: boolean;
  balance?: { available: boolean; address: Address; token: Address; amountUsdt: string | null; blockNumber: string | null };
  today?: { capturedUsdt: string; refundedUsdt: string; feesUsdt: string; payments: number; refunds: number; subscriptionCharges: number };
  metrics: { capturedUsdt: string; refundedUsdt: string; netUsdt: string; feesUsdt: string; totalPayments: number; successfulPayments: number; authorizedPayments: number; activeSubscriptions: number; financedInvoices?: number };
  volume: Array<{ date: string; amount: string }>;
  recentActivity: Array<{ id: string; type: string; objectId: string; createdAt: string; txHash: string | null; reason: string | null }>;
  /** Whether the merchant signed Pact's fee terms. Null when it could not be read. */
  feeTerms: { accepted: boolean | null; acceptedVersion: number | null; latestVersion: number | null };
}

/** The `payment.captured` webhook: Pact's fee came out of the payment, and `net` reached the merchant. */
export interface PaymentCapturedWebhook {
  id: string; api_version: string; type: 'payment.captured'; object_id: string; occurred_at: string; idempotency_key: string;
  tx_hash: Hex; block_number: string;
  /** USDT base units. */
  amount_minor: string; fee_minor: string; net_minor: string;
  metadata: Record<string, string | number | boolean>;
  data: { amount: string; fee: string; net: string; currency: 'USDT'; customer: string | null; tx_hash: Hex; metadata: Record<string, string | number | boolean>; financed?: true };
}
