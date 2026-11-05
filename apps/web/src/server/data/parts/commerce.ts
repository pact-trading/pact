/**
 * Commerce extras: payment links, manual orders, the refunds list and plan management.
 * Implemented by `mock/commerce-extras.ts` and `api/commerce-extras.ts`.
 */
import type { CheckoutField, CheckoutMetadata } from '@pactagent/core/checkout-fields';
import type { OrderListItem, PlanSummary } from '@pactagent/core/platform-types';
import type { CheckoutBrand, ListFilter } from '../types';

// ---------------------------------------------------------- payment links

/** The API's link kinds: a fixed price, a recurring price, or an amount the payer chooses. */
export type PaymentLinkKind = 'product' | 'subscription' | 'tip';

/** Whether a payer can use the link right now. */
export type PaymentLinkState = 'active' | 'inactive' | 'expired' | 'used';

/**
 * A shareable link that takes payments without an invoice. The first block of fields is the
 * API's `/v1/payment-links` shape; the rest are kept by the demo store only and are null
 * (or false) when the API does not record them.
 */
export interface PaymentLink {
  id: string;
  kind: PaymentLinkKind;
  name: string;
  /** Fixed price in USDT base units; null when the payer chooses the amount. */
  amountMinor: string | null;
  /** Billing period of a subscription link. */
  periodSeconds: number | null;
  status: 'active' | 'inactive';
  visits: number;
  createdAt: string;
  /** Absolute URL of the public pay page. */
  url: string;

  description: string | null;
  /** Stops taking payments after the first one. */
  singleUse: boolean;
  expiresAt: string | null;
  /** Completed payments through the link; null when the source cannot count them. */
  payments: number | null;
  /** What those payments brought in after refunds, in base units; null when unknown. */
  collectedMinor: string | null;
  state: PaymentLinkState;
}

export interface PaymentLinkInput {
  kind: 'product' | 'tip';
  name: string;
  /** Required for `product` links. */
  amountMinor?: string;
  description?: string;
  singleUse?: boolean;
  /** Last day the link works, `YYYY-MM-DD` (UTC). */
  expiresOn?: string | null;
  checkoutFields?: CheckoutField[];
}

export interface PaymentLinkDetail {
  link: PaymentLink;
  /** Orders paid or started through the link, newest first; null when the source cannot list them. */
  payments: OrderListItem[] | null;
}

/** What a payer sees on `/l/[id]`. Never includes anyone else's payment. */
export interface PublicPaymentLink {
  id: string;
  kind: PaymentLinkKind;
  name: string;
  description: string | null;
  amountMinor: string | null;
  state: PaymentLinkState;
  expiresAt: string | null;
  singleUse: boolean;
  brand: CheckoutBrand;
  /** Questions to ask before payment. */
  checkoutFields?: CheckoutField[];
  /** Bounds for an amount the payer enters. */
  minimumMinor: string;
  maximumMinor: string;
  /** Quick picks for a payer-chosen amount. */
  suggestionsMinor: string[];
  /** The signed-in payer's own latest payment through this link. */
  yourPayment: { orderId: string; amountMinor: string; paidAt: string } | null;
}

// ---------------------------------------------------------- manual orders

export interface OrderLine {
  /** Catalog product, or null for a custom item. */
  productId: string | null;
  description: string;
  quantity: number;
  unitMinor: string;
  amountMinor: string;
}

/** A line as typed in the editor. Catalog lines take their name and price from the catalog. */
export interface OrderLineInput {
  productId: string | null;
  description: string;
  quantity: string;
  /** Decimal dollars, e.g. "150" or "12.50". Ignored for catalog lines. */
  unitAmount: string;
}

export interface ManualOrderInput {
  customer: { kind: 'existing'; id: string } | { kind: 'new'; name: string; email: string };
  lines: OrderLineInput[];
  note: string;
}

/**
 * The server's reading of the editor. Error keys: `customer`, `name`, `email`, `lines`, `note`,
 * and `line.<index>.<product|description|quantity|price>`.
 */
export interface OrderQuote {
  lines: Array<OrderLine | null>;
  totalMinor: string;
  errors: Record<string, string>;
}

export interface ManualOrderOptions {
  customers: Array<{ id: string; name: string | null; email: string | null; company: string | null }>;
  products: Array<{ id: string; name: string; priceMinor: string }>;
  /** The smallest order total that can be charged. */
  minimumMinor: string;
}

export interface ManualOrderCreated {
  orderId: string;
  /** Absolute URL of `/pay/[orderId]`. */
  payUrl: string;
  totalMinor: string;
  customerName: string;
  customerEmail: string;
}

/** Where an order came from, for orders that did not start on a product page. */
export type OrderSource =
  | { kind: 'link'; label: string; linkId: string }
  | { kind: 'manual'; label: string; payUrl: string; lines: OrderLine[]; note: string };

/** What `/pay/[orderId]` may show. Details appear only to the customer the order is for. */
export interface PayableOrder {
  brand: CheckoutBrand;
  access: 'payer' | 'sign_in' | 'other';
  order: {
    id: string;
    status: OrderListItem['status'];
    description: string;
    totalMinor: string;
    lines: OrderLine[];
    note: string;
    createdAt: string;
    paidAt: string | null;
  } | null;
}

// ---------------------------------------------------------------- refunds

export interface RefundListItem {
  id: string;
  amountMinor: string;
  status: 'pending' | 'succeeded' | 'failed';
  reason: string | null;
  createdAt: string;
  txHash: string | null;
  /** Null when the source only knows the payment. */
  orderId: string | null;
  paymentId: string | null;
  description: string | null;
  customerId: string | null;
  customerName: string | null;
  customerEmail: string | null;
}

// ------------------------------------------------------------------ plans

export interface ManagedPlan extends PlanSummary {
  /** Archived plans keep their subscribers but take no new signups. */
  status: 'active' | 'archived';
  archivedAt: string | null;
  createdAt: string | null;
}

export interface CommerceExtrasData {
  discounts(): Promise<Discount[]>;
  createDiscount(input: DiscountInput): Promise<Discount>;
  archiveDiscount(id: string): Promise<Discount>;
  paymentLinks(filter?: ListFilter): Promise<PaymentLink[]>;
  paymentLink(id: string): Promise<PaymentLinkDetail>;
  createPaymentLink(input: PaymentLinkInput): Promise<PaymentLink>;
  deactivatePaymentLink(id: string): Promise<PaymentLink>;
  reactivatePaymentLink(id: string): Promise<PaymentLink>;
  /** Public. Counts a visit. */
  publicPaymentLink(id: string): Promise<PublicPaymentLink>;
  /** Creates the order and a `link` checkout; `amountMinor` is required for tip links. */
  startLinkCheckout(id: string, amountMinor?: string, discountCode?: string, metadata?: CheckoutMetadata): Promise<{ sessionId: string }>;

  manualOrderOptions(): Promise<ManualOrderOptions>;
  quoteOrder(input: ManualOrderInput): Promise<OrderQuote>;
  createManualOrder(input: ManualOrderInput): Promise<ManualOrderCreated>;
  /** Keyed by order id; orders from product checkouts are absent. */
  orderSources(): Promise<Record<string, OrderSource>>;
  payableOrder(orderId: string): Promise<PayableOrder>;
  /** Creates (or resumes) an `order` checkout for the signed-in customer. */
  startOrderCheckout(orderId: string): Promise<{ sessionId: string }>;

  refunds(filter?: ListFilter): Promise<RefundListItem[]>;

  plans(): Promise<ManagedPlan[]>;
  archivePlan(id: string): Promise<ManagedPlan>;
  restorePlan(id: string): Promise<ManagedPlan>;
}

export interface Discount {
  id: string; code: string; kind: 'percent' | 'fixed'; value: string;
  duration: 'once' | 'repeating' | 'forever'; periods: number | null;
  maxRedemptions: number | null; redemptions: number; startsAt: string | null;
  expiresAt: string | null; productIds: string[] | null; status: 'active' | 'archived'; createdAt: string;
}
export type DiscountInput = Pick<Discount, 'code' | 'kind' | 'value' | 'duration' | 'periods' | 'maxRedemptions' | 'startsAt' | 'expiresAt' | 'productIds'>;
