import type { CheckoutField, CheckoutMetadata } from './checkout-fields.js';

export type Money = { currency: 'USDT' | 'USD'; amountMinor: string };
export type Rail = 'whitechain' | 'stripe';
export type OrderStatus = 'open' | 'pending' | 'paid' | 'failed' | 'expired' | 'partially_refunded' | 'refunded';
export interface Product {
  id: string; merchantId: string; name: string; description: string; imageUrl: string | null;
  status: 'draft' | 'active' | 'archived'; revision: number; prices: Money[];
  checkoutFields?: CheckoutField[];
}
export interface Customer { id: string; merchantId: string; subjectId: string; email: string | null; name: string | null }
export interface Order {
  id: string; merchantId: string; customerId: string; productId: string; productRevision: number;
  productName: string; total: Money; refundedMinor: string; status: OrderStatus; rail: Rail;
  paymentId: string | null; providerSessionId: string | null; createdAt: string;
  discountCode?: string | null; amountGross?: string | null; amountDiscount?: string | null;
  /** The customer's checkout answers. */
  metadata?: CheckoutMetadata;
}
export interface CheckoutSession {
  id: string; orderId: string; rail: Rail; status: 'open' | 'pending' | 'complete' | 'expired';
  checkoutUrl: string | null; clientSecret?: string; expiresAt: string;
}
