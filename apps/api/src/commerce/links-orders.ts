import { randomBytes } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { id, now, type Db } from '../db.js';
import { IdentityError, type VerifiedIdentity } from '../identity.js';
import { checkoutSettings, snapshotPaymentPolicy } from '../merchant-settings.js';
import { priceWithDiscount, redeemDiscount } from '../discounts.js';
import { answersFor, storedCheckoutFields, storedMetadata, type Metadata } from '../metadata.js';

type Row = Record<string, string | number | null>;
const bad = (code: string, status: 400 | 403 | 404 | 409 | 410 = 400): never => { throw new IdentityError(code, status as 400); };
const MIN = 1_000_000n, MAX = 10_000_000_000n;

export function initLinksOrders(db: Db) {
  const cols = (db.pragma('table_info(payment_links)') as Array<{ name: string }>).map(c => c.name);
  if (!cols.includes('description')) db.exec('ALTER TABLE payment_links ADD COLUMN description TEXT');
  if (!cols.includes('single_use')) db.exec('ALTER TABLE payment_links ADD COLUMN single_use INTEGER NOT NULL DEFAULT 0');
  if (!cols.includes('expires_at')) db.exec('ALTER TABLE payment_links ADD COLUMN expires_at TEXT');
}

const metadataOf = (p: Row) => JSON.parse(String(p.metadata ?? '{}')) as { linkId?: string; manualOrder?: ManualOrder };
type ManualOrder = { customerName: string; customerEmail: string; customerId: string | null; lines: Array<{ productId: string | null; description: string; quantity: number; unitMinor: string; amountMinor: string }>; note: string };
const linkPayments = (db: Db, merchantId: string, linkId: string) =>
  (db.prepare("SELECT * FROM payments WHERE merchant_id=? AND metadata LIKE ?").all(merchantId, `%"linkId":"${linkId}"%`) as Row[]).filter(p => metadataOf(p).linkId === linkId);

/** Link fields the API now keeps, plus payments counted from the payments table. */
export function linkExtras(db: Db, link: Row) {
  const payments = linkPayments(db, String(link.merchant_id), String(link.id)).filter(p => ['captured', 'partially_refunded', 'refunded'].includes(String(p.status)));
  const collected = payments.reduce((t, p) => t + BigInt(String(p.captured_minor)) - BigInt(String(p.refunded_minor ?? '0')), 0n);
  const expired = !!link.expires_at && new Date(String(link.expires_at)).getTime() < Date.now();
  const used = !!link.single_use && payments.length > 0;
  return { description: link.description ?? null, singleUse: !!link.single_use, expiresAt: link.expires_at ?? null, checkoutFields: storedCheckoutFields(link.checkout_fields), payments: payments.length, collectedMinor: collected.toString(),
    state: link.status !== 'active' ? 'inactive' : expired ? 'expired' : used ? 'used' : 'active' };
}

/** Hosted payment created for a payer from a link or a manual order. */
function hostedPayment(db: Db, merchantId: string, amount: bigint, description: string, payer: string | null, email: string | null, metadata: Record<string, unknown>, customMetadata: Metadata = {}) {
  const paymentId = `0x${randomBytes(32).toString('hex')}`;
  db.prepare('INSERT INTO payments(id,merchant_id,amount_minor,description,customer,metadata,custom_metadata,status,created_at,payer,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(paymentId, merchantId, amount.toString(), description, email, JSON.stringify(metadata), JSON.stringify(customMetadata), 'open', now(), payer, new Date(Date.now() + 30 * 60_000).toISOString());
  snapshotPaymentPolicy(db, paymentId, merchantId);
  return paymentId;
}
const ensureCustomer = (db: Db, merchantId: string, user: VerifiedIdentity) => {
  const existing = db.prepare('SELECT id FROM commerce_customers WHERE merchant_id=? AND subject_id=?').get(merchantId, user.userId) as { id: string } | undefined;
  if (existing) return existing.id;
  const customerId = id('cus');
  db.prepare('INSERT INTO commerce_customers VALUES (?,?,?,?,?,?,?)').run(customerId, merchantId, user.userId, user.wallet.address.toLowerCase(), user.email, null, now());
  return customerId;
};

/** A link payment shown as an order: one line, the link's name, and the payer as its customer. */
function linkOrder(db: Db, p: Row): ManualOrder {
  const customer = db.prepare('SELECT id,name,email FROM commerce_customers WHERE merchant_id=? AND lower(wallet)=lower(?) LIMIT 1').get(p.merchant_id, p.payer ?? '') as { id: string; name: string | null; email: string | null } | undefined;
  return { customerName: customer?.name ?? customer?.email ?? 'Customer', customerEmail: customer?.email ?? String(p.customer ?? ''), customerId: customer?.id ?? null,
    lines: [{ productId: null, description: String(p.description ?? 'Payment'), quantity: 1, unitMinor: String(p.amount_minor), amountMinor: String(p.amount_minor) }], note: '' };
}
const hostedOrder = (db: Db, p: Row) => metadataOf(p).manualOrder ?? (metadataOf(p).linkId ? linkOrder(db, p) : undefined);
function manualOrderView(p: Row, db?: Db) {
  const order = metadataOf(p).manualOrder ?? linkOrder(db!, p);
  const status = p.status === 'captured' ? 'paid' : p.status === 'partially_refunded' ? 'partially_refunded' : p.status === 'refunded' ? 'refunded' : p.status === 'failed' ? 'failed' : 'open';
  return { id: String(p.id), merchantId: String(p.merchant_id), customerId: order.customerId ?? '', productId: '', productRevision: 0, productName: order.lines.map(l => l.description).join(', ').slice(0, 120) || 'Order',
    total: { currency: 'USDT', amountMinor: String(p.amount_minor) }, refundedMinor: String(p.refunded_minor ?? '0'), status, rail: 'whitechain', paymentId: String(p.id), providerSessionId: null, createdAt: String(p.created_at),
    customerName: order.customerName, customerEmail: order.customerEmail, lines: order.lines, note: order.note, txHash: p.tx_hash ?? null,
    source: metadataOf(p).manualOrder ? 'manual' as const : 'link' as const, linkId: metadataOf(p).linkId ?? null, metadata: storedMetadata(p.custom_metadata) };
}

/** Merchant routes, mounted under the authenticated /v1 middleware. */
export function mountMerchantLinksOrders(app: Hono, db: Db, baseUrl: string, auth: (c: Context) => { merchantId: string }) {
  app.post('/v1/payment-links/:id/reactivate', c => {
    const changed = db.prepare("UPDATE payment_links SET status='active' WHERE id=? AND merchant_id=? AND kind IN ('product','tip')").run(c.req.param('id'), auth(c).merchantId);
    return changed.changes ? c.json({ ok: true }) : c.json({ error: { code: 'link_not_found' } }, 404);
  });
  app.get('/v1/payment-links/extras', c => {
    const rows = db.prepare("SELECT * FROM payment_links WHERE merchant_id=? AND kind IN ('product','tip')").all(auth(c).merchantId) as Row[];
    return c.json({ data: Object.fromEntries(rows.map(r => [String(r.id), linkExtras(db, r)])) });
  });
  app.get('/v1/manual-orders', c => {
    // Manual orders, and link payments once started (open link payments a payer abandoned are left out).
    const rows = (db.prepare("SELECT * FROM payments WHERE merchant_id=? AND (metadata LIKE '%\"manualOrder\"%' OR (metadata LIKE '%\"linkId\"%' AND status!='open')) ORDER BY created_at DESC LIMIT 200").all(auth(c).merchantId) as Row[]).filter(p => hostedOrder(db, p));
    return c.json({ data: rows.map(p => ({ ...manualOrderView(p, db), payUrl: `${baseUrl}/pay/${p.id}` })) });
  });
  app.get('/v1/manual-orders/:id', c => {
    const p = db.prepare('SELECT * FROM payments WHERE id=? AND merchant_id=?').get(c.req.param('id'), auth(c).merchantId) as Row | undefined;
    if (!p || !hostedOrder(db, p)) return c.json({ error: { code: 'order_not_found' } }, 404);
    const refunds = db.prepare('SELECT id,amount_minor AS amountMinor,reason,status,tx_hash AS txHash,created_at AS createdAt FROM refunds WHERE payment_id=? ORDER BY created_at').all(p.id);
    return c.json({ ...manualOrderView(p, db), payUrl: `${baseUrl}/pay/${p.id}`, refunds, refundDeadline: p.refund_deadline ?? null });
  });
  app.post('/v1/manual-orders', async c => {
    const merchantId = auth(c).merchantId;
    let b: Record<string, unknown>;
    try { b = await c.req.json(); } catch { return c.json({ error: { code: 'invalid_json' } }, 400); }
    const customer = b.customer as { kind: string; id?: string; name?: string; email?: string } | undefined;
    let customerName = '', customerEmail = '', customerId: string | null = null;
    if (customer?.kind === 'existing') {
      const row = db.prepare('SELECT id,name,email FROM commerce_customers WHERE id=? AND merchant_id=?').get(String(customer.id), merchantId) as { id: string; name: string | null; email: string | null } | undefined;
      if (!row?.email) return c.json({ error: { code: 'invalid_customer', message: 'Choose a customer with an email.' } }, 400);
      customerId = row.id; customerName = row.name ?? row.email; customerEmail = row.email;
    } else if (customer?.kind === 'new' && typeof customer.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer.email)) {
      customerName = String(customer.name ?? '').trim() || customer.email; customerEmail = customer.email.toLowerCase();
    } else return c.json({ error: { code: 'invalid_customer', message: 'Add the customer’s name and email.' } }, 400);
    const lines = (Array.isArray(b.lines) ? b.lines : []).slice(0, 50).map(raw => {
      const l = raw as Record<string, unknown>;
      const quantity = Number(l.quantity), unit = BigInt(String(l.unitMinor ?? '0'));
      if (!Number.isSafeInteger(quantity) || quantity <= 0 || unit <= 0n || typeof l.description !== 'string' || !l.description.trim()) throw new IdentityError('invalid_lines', 400);
      return { productId: typeof l.productId === 'string' ? l.productId : null, description: l.description.trim().slice(0, 200), quantity, unitMinor: unit.toString(), amountMinor: (unit * BigInt(quantity)).toString() };
    });
    const total = lines.reduce((t, l) => t + BigInt(l.amountMinor), 0n);
    if (!lines.length || total < MIN || total > MAX) return c.json({ error: { code: 'invalid_total', message: 'The order total must be between $1 and $10,000.' } }, 400);
    const note = typeof b.note === 'string' ? b.note.slice(0, 1000) : '';
    const paymentId = hostedPayment(db, merchantId, total, lines[0].description, null, customerEmail, { manualOrder: { customerName, customerEmail, customerId, lines, note } });
    return c.json({ orderId: paymentId, payUrl: `${baseUrl}/pay/${paymentId}`, totalMinor: total.toString(), customerName, customerEmail }, 201);
  });
}

/** Payer routes, mounted in the commerce router. Links are public; manual orders are for their customer only. */
export function mountPayerLinksOrders(app: Hono, db: Db, payer: (c: Context) => Promise<VerifiedIdentity>) {
  const body = async (c: Context) => { try { return await c.req.json() as Record<string, unknown>; } catch { return {}; } };
  const link = (linkId: string) => db.prepare('SELECT * FROM payment_links WHERE id=?').get(linkId) as Row | undefined;
  app.get('/links/:id', async c => {
    const l = link(c.req.param('id'));
    if (!l || l.kind === 'subscription') return bad('link_not_found', 404);
    db.prepare('UPDATE payment_links SET visits=visits+1 WHERE id=?').run(l.id);
    const extras = linkExtras(db, l);
    const token = c.req.header('authorization');
    let yourPayment = null;
    if (token) {
      const user = await payer(c).catch(() => null);
      const mine = user && linkPayments(db, String(l.merchant_id), String(l.id)).filter(p => String(p.payer ?? '').toLowerCase() === user.wallet.address.toLowerCase() && p.status === 'captured').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
      if (mine) yourPayment = { orderId: String(mine.id), amountMinor: String(mine.captured_minor), paidAt: String(mine.created_at) };
    }
    const brand = checkoutSettings(db, String(l.merchant_id));
    return c.json({ id: l.id, kind: l.kind, name: l.name, description: extras.description, amountMinor: l.amount_minor, state: extras.state, expiresAt: extras.expiresAt, singleUse: extras.singleUse, checkoutFields: extras.checkoutFields,
      brand: { brandName: brand.brandName, logoUrl: brand.logoUrl }, minimumMinor: MIN.toString(), maximumMinor: MAX.toString(), suggestionsMinor: ['5000000', '10000000', '25000000'], yourPayment });
  });
  app.post('/me/links/:id/payments', async c => {
    const user = await payer(c), l = link(c.req.param('id')), b = await body(c);
    if (!l || l.kind === 'subscription') return bad('link_not_found', 404);
    if (linkExtras(db, l).state !== 'active') return bad('link_unavailable', 409);
    const amount = l.amount_minor ? BigInt(String(l.amount_minor)) : BigInt(String(b.amountMinor ?? '0'));
    if (amount < MIN || amount > MAX) return bad('invalid_amount');
    const answers = answersFor(storedCheckoutFields(l.checkout_fields), b.metadata);
    const price = priceWithDiscount(db, String(l.merchant_id), b.discountCode, amount, String(l.id));
    const paymentId = db.transaction(() => {
      ensureCustomer(db, String(l.merchant_id), user);
      const created = hostedPayment(db, String(l.merchant_id), price.net, String(l.name), user.wallet.address.toLowerCase(), user.email,
        { linkId: l.id, discountCode: price.code, amountGrossMinor: price.gross.toString(), amountDiscountMinor: price.discount.toString() }, answers);
      redeemDiscount(db, String(l.merchant_id), price.code);
      return created;
    })();
    return c.json({ paymentId, amountMinor: price.net.toString(), discountCode: price.code }, 201);
  });
  const order = (orderId: string) => {
    const p = db.prepare('SELECT * FROM payments WHERE id=?').get(orderId) as Row | undefined;
    // A manual order, or a plain POST /v1/payments payment. Links, invoices and product orders have their own routes.
    return p && (metadataOf(p).manualOrder || Object.keys(metadataOf(p)).length === 0) ? p : undefined;
  };
  app.get('/orders/:id/public', async c => {
    const p = order(c.req.param('id'));
    if (!p) return bad('order_not_found', 404);
    const brand = checkoutSettings(db, String(p.merchant_id));
    const user = c.req.header('authorization') ? await payer(c).catch(() => null) : null;
    const view = manualOrderView(p, db);
    const access = !user ? 'sign_in' : user.email?.toLowerCase() === view.customerEmail.toLowerCase() || String(p.payer ?? '').toLowerCase() === user.wallet.address.toLowerCase() ? 'payer' : 'other';
    return c.json({ brand: { brandName: brand.brandName, logoUrl: brand.logoUrl }, access,
      order: access === 'payer' ? { id: view.id, status: view.status, description: view.productName, totalMinor: view.total.amountMinor, lines: view.lines, note: view.note, createdAt: view.createdAt, paidAt: view.status === 'paid' ? view.createdAt : null } : null });
  });
  app.post('/me/orders/:id/pay', async c => {
    const user = await payer(c), p = order(c.req.param('id'));
    if (!p) return bad('order_not_found', 404);
    const view = manualOrderView(p, db);
    if (user.email?.toLowerCase() !== view.customerEmail.toLowerCase() && String(p.payer ?? '').toLowerCase() !== user.wallet.address.toLowerCase()) return bad('not_your_order', 403);
    if (p.payer && String(p.payer).toLowerCase() !== user.wallet.address.toLowerCase()) return bad('payer_mismatch', 409);
    db.prepare('UPDATE payments SET payer=? WHERE id=? AND payer IS NULL').run(user.wallet.address.toLowerCase(), p.id);
    ensureCustomer(db, String(p.merchant_id), user);
    return c.json({ paymentId: p.id });
  });
}
