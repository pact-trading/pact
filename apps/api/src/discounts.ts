import type { Context, Hono } from 'hono';
import { amountString, id, now, type Db } from './db.js';
import { Refusal } from './types.js';

type Discount = {
  id: string; merchant_id: string; code: string; kind: 'percent' | 'fixed'; value: string;
  duration: 'once' | 'repeating' | 'forever'; periods: number | null;
  max_redemptions: number | null; redemptions: number; starts_at: string | null;
  expires_at: string | null; product_ids: string | null; status: 'active' | 'archived'; created_at: string;
};

export function initDiscounts(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS discounts(
    id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, code TEXT NOT NULL COLLATE NOCASE,
    kind TEXT NOT NULL CHECK(kind IN ('percent','fixed')), value TEXT NOT NULL,
    duration TEXT NOT NULL CHECK(duration IN ('once','repeating','forever')),
    periods INTEGER, max_redemptions INTEGER, redemptions INTEGER NOT NULL DEFAULT 0,
    starts_at TEXT, expires_at TEXT, product_ids TEXT,
    status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
    UNIQUE(merchant_id,code));`);
  for (const [table, cols] of [
    ['commerce_orders', ['discount_code', 'amount_gross_minor', 'amount_discount_minor']],
    ['subscriptions', ['discount_code', 'amount_gross_minor', 'amount_discount_minor', 'discount_duration', 'discount_periods']],
  ] as const) for (const col of cols) {
    if (!(db.pragma(`table_info(${table})`) as Array<{ name: string }>).some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} TEXT`);
  }
}

const view = (d: Discount) => ({
  id: d.id, code: d.code, kind: d.kind, value: d.value, duration: d.duration,
  periods: d.periods, maxRedemptions: d.max_redemptions, redemptions: d.redemptions,
  startsAt: d.starts_at, expiresAt: d.expires_at,
  productIds: d.product_ids ? JSON.parse(d.product_ids) as string[] : null,
  status: d.status, createdAt: d.created_at,
});

export function mountDiscounts(app: Hono, db: Db, merchant: (c: Context) => string) {
  app.get('/v1/discounts', c => c.json({ data: (db.prepare('SELECT * FROM discounts WHERE merchant_id=? ORDER BY created_at DESC').all(merchant(c)) as Discount[]).map(view) }));
  app.post('/v1/discounts', async c => {
    const b = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Refusal('discount_invalid');
    const code = typeof b.code === 'string' ? b.code.trim().toUpperCase() : '';
    if (!/^[A-Z0-9]{2,40}$/.test(code)) throw new Refusal('discount_invalid');
    if (b.kind !== 'percent' && b.kind !== 'fixed') throw new Refusal('discount_invalid');
    if (b.duration !== 'once' && b.duration !== 'repeating' && b.duration !== 'forever') throw new Refusal('discount_invalid');
    const value = String(b.value ?? '');
    if (!/^[1-9]\d*$/.test(value) || (b.kind === 'percent' && BigInt(value) > 10_000n)) throw new Refusal('discount_invalid');
    const periods = b.duration === 'repeating' ? Number(b.periods) : null;
    if (b.duration === 'repeating' && (!Number.isSafeInteger(periods) || periods! < 1 || periods! > 1000)) throw new Refusal('discount_invalid');
    const limit = b.maxRedemptions == null ? null : Number(b.maxRedemptions);
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new Refusal('discount_invalid');
    const productIds = b.productIds == null ? null : b.productIds;
    if (productIds !== null && (!Array.isArray(productIds) || productIds.length > 100 || productIds.some(v => typeof v !== 'string' || !v))) throw new Refusal('discount_invalid');
    const dates = [b.startsAt, b.expiresAt].map(v => v == null ? null : typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(v).toISOString() : false);
    if (dates.includes(false) || (dates[0] && dates[1] && dates[0] >= dates[1])) throw new Refusal('discount_invalid');
    const merchantId = merchant(c);
    if (db.prepare('SELECT 1 FROM discounts WHERE merchant_id=? AND code=? COLLATE NOCASE').get(merchantId, code)) throw new Refusal('discount_invalid');
    const key = id('disc');
    db.prepare('INSERT INTO discounts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(key, merchantId, code, b.kind, value, b.duration, periods, limit, 0, dates[0], dates[1], productIds === null ? null : JSON.stringify(productIds), 'active', now());
    return c.json(view(db.prepare('SELECT * FROM discounts WHERE id=?').get(key) as Discount), 201);
  });
  app.post('/v1/discounts/:id/archive', c => {
    const result = db.prepare("UPDATE discounts SET status='archived' WHERE id=? AND merchant_id=?").run(c.req.param('id'), merchant(c));
    if (!result.changes) throw new Refusal('discount_invalid');
    return c.json(view(db.prepare('SELECT * FROM discounts WHERE id=?').get(c.req.param('id')) as Discount));
  });
}

export function priceWithDiscount(db: Db, merchantId: string, code: unknown, gross: bigint, productId?: string, minimum = 1_000_000n) {
  if (code === undefined || code === null || code === '') return { net: gross, gross, discount: 0n, code: null as string | null, duration: null as Discount['duration'] | null, periods: null as number | null };
  if (typeof code !== 'string' || !/^[A-Za-z0-9]{2,40}$/.test(code.trim())) throw new Refusal('discount_invalid');
  const row = db.prepare('SELECT * FROM discounts WHERE merchant_id=? AND code=? COLLATE NOCASE').get(merchantId, code.trim()) as Discount | undefined;
  if (!row || row.status !== 'active' || (row.product_ids && !((JSON.parse(row.product_ids) as string[]).includes(productId ?? '')))) throw new Refusal('discount_invalid');
  const date = now();
  if (row.starts_at && row.starts_at > date || row.expires_at && row.expires_at <= date) throw new Refusal('discount_expired');
  if (row.max_redemptions !== null && row.redemptions >= row.max_redemptions) throw new Refusal('discount_exhausted');
  const discount = row.kind === 'percent' ? (gross * BigInt(row.value) + 5_000n) / 10_000n : BigInt(row.value) > gross ? gross : BigInt(row.value);
  const net = gross - discount;
  if (net < minimum) throw new Refusal('discount_below_minimum');
  return { net, gross, discount, code: row.code, duration: row.duration, periods: row.periods };
}

export function redeemDiscount(db: Db, merchantId: string, code: string | null) {
  if (code) {
    const changed = db.prepare("UPDATE discounts SET redemptions=redemptions+1 WHERE merchant_id=? AND code=? COLLATE NOCASE AND status='active' AND (max_redemptions IS NULL OR redemptions<max_redemptions)").run(merchantId, code);
    if (!changed.changes) throw new Refusal('discount_exhausted');
  }
}

/** Confirmed charges of a subscription. The next charge is period `chargedPeriods + 1`. */
export function chargedPeriods(db: Db, chainId: string): number {
  return (db.prepare("SELECT count(*) n FROM accounting_entries WHERE lower(object_id)=lower(?) AND kind='Subscription'").get(chainId) as { n: number }).n;
}

/** The subscription's discount as documented: its duration and how many periods are left (null = no end). */
export function discountTerms(duration: string | null | undefined, periods: string | number | null | undefined, charged: number) {
  if (!duration) return null;
  return { duration, periods: duration === 'forever' ? null : Math.max(0, (duration === 'once' ? 1 : Number(periods)) - charged) };
}

export function renewalDiscountAmount(db: Db, subscriptionId: string, period: number): bigint {
  const row = db.prepare('SELECT s.discount_duration,s.discount_periods,s.amount_discount_minor,p.amount_minor FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.id=?').get(subscriptionId) as { discount_duration: string | null; discount_periods: string | null; amount_discount_minor: string | null; amount_minor: string };
  const applies = row.discount_duration === 'forever' || row.discount_duration === 'repeating' && period <= Number(row.discount_periods) || row.discount_duration === 'once' && period === 1;
  return BigInt(row.amount_minor) - (applies ? BigInt(row.amount_discount_minor ?? '0') : 0n);
}

export function discountView(gross: string | null, discount: string | null, code: string | null) {
  return { discountCode: code, amountGross: gross === null ? null : amountString(gross), amountDiscount: discount === null ? null : amountString(discount) };
}
