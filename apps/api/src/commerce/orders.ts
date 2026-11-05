import { createHash } from 'node:crypto';
import type { CheckoutSession, Order, OrderStatus } from '@pactagent/core/commerce-types';
import { id, now, type Db } from '../db.js';
import { IdentityError, type VerifiedIdentity } from '../identity.js';
import { createOpenPayment } from '../payment-creation.js';
import { priceWithDiscount, redeemDiscount, discountView } from '../discounts.js';
import { answersFor, storedMetadata } from '../metadata.js';
import { product, invalid, missing } from './products.js';

export type OrderRow = { id: string; merchant_id: string; customer_id: string; product_id: string; product_revision: number; product_name: string; amount_minor: string; currency: 'USDT' | 'USD'; rail: 'whitechain' | 'stripe'; payment_id: string | null; provider_session_id: string | null; created_at: string; discount_code?: string | null; amount_gross_minor?: string | null; amount_discount_minor?: string | null; metadata?: string | null };
export function orderView(db: Db, row: OrderRow): Order {
  const p = row.payment_id ? db.prepare('SELECT status,captured_minor,refunded_minor,expires_at FROM payments WHERE id=? AND merchant_id=?').get(row.payment_id, row.merchant_id) as { status: string; captured_minor: string; refunded_minor: string; expires_at: string | null } | undefined : undefined;
  let status: OrderStatus = 'open';
  const captured = BigInt(p?.captured_minor ?? '0'), refunded = BigInt(p?.refunded_minor ?? '0');
  // Only the existing confirmed-event indexer writes these monetary totals.
  if (captured > 0n) status = refunded >= captured ? 'refunded' : refunded > 0n ? 'partially_refunded' : captured >= BigInt(row.amount_minor) ? 'paid' : 'pending';
  else if (row.payment_id && db.prepare("SELECT 1 FROM intents i JOIN relayer_operations o ON o.operation_id=i.id WHERE i.merchant_id=? AND o.kind='intent' AND o.object_id=? AND i.status IN ('submitted','reconciliation_required') LIMIT 1").get(row.merchant_id, row.payment_id)) status = 'pending';
  else if (p?.status === 'reconciliation_required' || p?.status === 'authorized') status = 'pending';
  else if (p?.status === 'expired' || (p?.expires_at && new Date(p.expires_at).getTime() <= Date.now())) status = 'expired';
  else if (p?.status === 'failed' || p?.status === 'voided') status = 'failed';
  return { id: row.id, merchantId: row.merchant_id, customerId: row.customer_id, productId: row.product_id, productRevision: row.product_revision, productName: row.product_name, total: { currency: row.currency, amountMinor: row.amount_minor }, refundedMinor: refunded.toString(), status, rail: row.rail, paymentId: row.payment_id, providerSessionId: row.provider_session_id, createdAt: row.created_at, ...discountView(row.amount_gross_minor ?? null, row.amount_discount_minor ?? null, row.discount_code ?? null), metadata: storedMetadata(row.metadata) };
}
export function sessionView(db: Db, sessionId: string, appUrl: string) {
  const s = db.prepare('SELECT * FROM commerce_checkout_sessions WHERE id=?').get(sessionId) as { id: string; order_id: string; expires_at: string } | undefined;
  if (!s) return missing();
  const row = db.prepare('SELECT * FROM commerce_orders WHERE id=?').get(s.order_id) as OrderRow;
  const order = orderView(db, row);
  const session: CheckoutSession = { id: s.id, orderId: order.id, rail: order.rail, status: ['paid', 'partially_refunded', 'refunded'].includes(order.status) ? 'complete' : order.status === 'expired' ? 'expired' : order.status === 'pending' ? 'pending' : 'open', checkoutUrl: `${appUrl}/checkout/${s.id}`, expiresAt: s.expires_at };
  return { session, order };
}
export function createCheckout(db: Db, identity: VerifiedIdentity, input: Record<string, unknown>, key: string | undefined, appUrl: string, minimumAmount: bigint) {
  if (Object.keys(input).some(k => !['productId', 'rail', 'discountCode', 'metadata'].includes(k)) || typeof input.productId !== 'string' || !['whitechain', 'stripe'].includes(String(input.rail))) invalid('invalid_checkout_request');
  if (!key || key.length > 200 || /[\u0000-\u001f]/.test(key)) invalid('idempotency_key_required');
  const requestHash = createHash('sha256').update(JSON.stringify([input.productId, input.rail, input.discountCode ?? null, Object.entries(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}).sort(([a], [b]) => a.localeCompare(b))])).digest('hex');
  return db.transaction(() => {
    const p = product(db, input.productId as string); if (!p) return missing();
    const existing = db.prepare('SELECT id,request_hash FROM commerce_checkout_sessions WHERE merchant_id=? AND subject_id=? AND idempotency_key=?').get(p.merchantId, identity.userId, key) as { id: string; request_hash: string } | undefined;
    if (existing) { if (existing.request_hash !== requestHash) throw new IdentityError('idempotency_conflict', 409); return sessionView(db, existing.id, appUrl); }
    if (p.status !== 'active') throw new IdentityError('product_unavailable', 409);
    if (input.rail !== 'whitechain') throw new IdentityError('payment_method_unavailable', 409);
    const price = p.prices.find(x => x.currency === 'USDT');
    if (!price || BigInt(price.amountMinor) < minimumAmount) throw new IdentityError('price_unavailable', 409);
    const answers = answersFor(p.checkoutFields ?? [], input.metadata);
    const discounted = priceWithDiscount(db, p.merchantId, input.discountCode, BigInt(price.amountMinor), p.id, minimumAmount);
    let customer = db.prepare('SELECT id,wallet FROM commerce_customers WHERE merchant_id=? AND subject_id=?').get(p.merchantId, identity.userId) as { id: string; wallet: string } | undefined;
    if (customer && customer.wallet.toLowerCase() !== identity.wallet.address.toLowerCase()) throw new IdentityError('customer_wallet_changed', 409);
    if (!customer) {
      customer = { id: id('cus'), wallet: identity.wallet.address.toLowerCase() };
      db.prepare('INSERT INTO commerce_customers VALUES (?,?,?,?,?,?,?)').run(customer.id, p.merchantId, identity.userId, customer.wallet, identity.email, null, now());
    }
    const orderId = id('ord'), sessionId = id('cs'), expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const paymentId = createOpenPayment(db, { merchantId: p.merchantId, amount: discounted.net, description: p.name, email: identity.email, payer: identity.wallet.address, expiresAt, metadata: { orderId, productId: p.id, productRevision: p.revision }, customMetadata: answers });
    db.prepare('INSERT INTO commerce_orders(id,merchant_id,customer_id,product_id,product_revision,product_name,amount_minor,currency,rail,payment_id,provider_session_id,created_at,discount_code,amount_gross_minor,amount_discount_minor,metadata) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(orderId, p.merchantId, customer.id, p.id, p.revision, p.name, discounted.net.toString(), price.currency, 'whitechain', paymentId, null, now(), discounted.code, discounted.gross.toString(), discounted.discount.toString(), JSON.stringify(answers));
    redeemDiscount(db, p.merchantId, discounted.code);
    db.prepare('INSERT INTO commerce_checkout_sessions VALUES (?,?,?,?,?,?,?,?)').run(sessionId, orderId, p.merchantId, identity.userId, key, requestHash, expiresAt, now());
    db.prepare('INSERT INTO commerce_payment_attempts VALUES (?,?,?,?,?,?)').run(id('attempt'), orderId, 'whitechain', paymentId, null, now());
    return sessionView(db, sessionId, appUrl);
  })();
}
export function ownedOrder(db: Db, orderId: string, scope: { merchantId: string } | { subjectId: string; wallet: string }) {
  const merchant = 'merchantId' in scope;
  const row = db.prepare(`SELECT o.* FROM commerce_orders o JOIN commerce_customers c ON c.id=o.customer_id WHERE o.id=? AND ${merchant ? 'o.merchant_id=?' : 'c.subject_id=? AND lower(c.wallet)=lower(?)'}`).get(orderId, ...(merchant ? [scope.merchantId] : [scope.subjectId, scope.wallet])) as OrderRow | undefined;
  return row ?? missing();
}
export function listOrders(db: Db, scope: { merchantId: string } | { subjectId: string; wallet: string }, limit: number, after = '', customerId?: string) {
  const merchant = 'merchantId' in scope;
  const rows = db.prepare(`SELECT o.* FROM commerce_orders o JOIN commerce_customers c ON c.id=o.customer_id WHERE ${merchant ? 'o.merchant_id=?' : 'c.subject_id=? AND lower(c.wallet)=lower(?)'} AND o.id>? ${customerId ? 'AND c.id=?' : ''} ORDER BY o.id LIMIT ?`).all(...(merchant ? [scope.merchantId] : [scope.subjectId, scope.wallet]), after, ...(customerId ? [customerId] : []), limit + 1) as OrderRow[];
  return { data: rows.slice(0, limit).map(row => orderView(db, row)), next: rows.length > limit ? rows[limit - 1].id : null };
}
