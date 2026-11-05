import type { Address, Hex, SignedAuthorization } from 'viem';
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
export interface FeePreview {
  chainId: number; blockNumber: string; targetGas: number; gasPriceWei: string;
  usdtPerWbtMinor: string; maximumReimbursementWei: string; minimumFeeMinor: string; minimumAmountMinor: string;
}
export interface ApiConfig {
  chainId: number; merchant: Address; router: Address; escrow: Address; subscription: Address;
  /** Absent on older APIs; never infer V2 from an address. */
  subscriptionVersion?: 1 | 2;
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
/** Transactions the merchant's own wallet sends, in order; then pass their hashes to `submitTransactions`. */
export interface PreparedFinancingTransactions {
  title: string;
  lines: Array<{ label: string; value: string }>;
  transactions: Array<{ to: Address; data: Hex; label: string }>;
}

export interface SubscriptionPlanRequest { name: string; amount: string; periodSeconds: number; maxPeriods?: number; trialDays?: number }
export interface SubscriptionPlan { trialDays?: number; id: string; name: string; amount: string; periodSeconds: number; maxPeriods: number | null }
/** V1 payer mandate only; use SubscriptionV2Request for V2 registration. */
export interface SubscriptionRequest { planId: string; mandate: Mandate; signature: Hex }
/** Merchant signature over SponsorshipConsent with the full V2 mandate digest. */
export interface MerchantConsentV2 { deadline: bigint; signature: Hex }
export interface SubscriptionV2Request extends SubscriptionRequest { merchantConsent: MerchantConsentV2 }
/** Payer-signed Cancel typed data, not a Router intent. Deadline is Unix seconds, <= now+300. */
export interface CancellationV2Request { deadline: bigint; signature: Hex }
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
export interface RenewalRequest { amount?: string }
export interface RenewalStatus { id: string; state: string; reason: string; operationId?: string; txHash?: Hex; automatic?: 'disabled' }
/** Current V1 cancellation uses a payer-signed Router Intent. */
export type CancellationRequest = IntentRequest;
export interface SubscriptionMutation { id: string; status: 'submitted'; txHash: Hex }
export interface MandateNonce { nonce: string }

export type ApprovalStatus = 'needs_funding' | 'needs_approval' | 'ready' | 'pending' | 'unavailable';
export interface ApprovalReadiness {
  paymentId: string; payer: Address; chainId: number; token: Address; spender: Address;
  /** Decimal base-unit strings (6 USDT decimals), unlike Payment.amount. */
  amount: string; balance: string | null; allowance: string | null;
  delegate: Address; delegateState: 'none' | 'expected' | 'unknown'; approvalNonce: string | null; authorizationNonce: string | null;
  deadline: string | null; message: Hex | null; authorizationRequired: boolean;
  status: ApprovalStatus; reason?: string; attemptId?: string; txHash?: Hex | null;
}
export interface ApprovalRequest {
  payer: Address; approvalNonce: bigint | string; deadline: bigint | string; signature: Hex;
  /** Only address/chainId/nonce/r/s/yParity are sent; viem's v is stripped. */
  authorization?: SignedAuthorization;
}
export interface RefusalAttempt { id: string; objectId: string; reason: string; txHash: Hex | null; createdAt: string }
export interface GasTank {
  merchant: Address; balanceWei: string; dailyCapWei: string; spentTodayWei: string; runwayDays: number | null;
  refusals: Array<{ reason: string; count: number }>;
}
export interface ExportRequest { from?: string; to?: string; format?: 'json' | 'csv' }
export interface ExportReport {
  rows: Array<Record<string, string>>;
  totals: { grossUSDT: string; discountsUSDT?: string; feesUSDT: string; netUSDT: string; gasWBT: string; tokenDeltaUSDT: string | null };
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
  gasTank: { available: boolean; balanceWei: string | null; dailyCapWei: string | null; spentTodayWei: string | null; runwayDays: number | null };
}
