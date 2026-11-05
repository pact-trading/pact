import type { Product, Money } from '@pactagent/core/commerce-types';
import { id, now, type Db } from '../db.js';
import { IdentityError } from '../identity.js';
import { validateCheckoutFields } from '../metadata.js';

export const invalid = (code: string): never => { throw new IdentityError(code, 400); };
export const missing = (): never => { throw new IdentityError('not_found', 404); };
const fields = ['name', 'description', 'imageUrl', 'status', 'prices', 'revision', 'checkoutFields'];
function info(input: Record<string, unknown>, previous?: Product): Omit<Product, 'id' | 'merchantId' | 'revision'> {
  if (Object.keys(input).some(key => !fields.includes(key))) invalid('invalid_product_field');
  const value = { name: '', description: '', imageUrl: null, status: 'draft', prices: [], ...previous, ...input };
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || /[\u0000-\u001f]/.test(value.name)) invalid('invalid_product_name');
  if (typeof value.description !== 'string' || value.description.length > 4000 || /[\u0000-\u0008]/.test(value.description)) invalid('invalid_product_description');
  if (!['draft', 'active', 'archived'].includes(String(value.status))) invalid('invalid_product_status');
  if (value.imageUrl !== null) {
    if (typeof value.imageUrl !== 'string' || value.imageUrl.length > 2048 || /[\\\u0000-\u0020]/.test(value.imageUrl)) invalid('invalid_product_image');
    if (!/^\/(?!\/)/.test(value.imageUrl)) {
      let url: URL; try { url = new URL(value.imageUrl); } catch { return invalid('invalid_product_image'); }
      if (url.protocol !== 'https:' || url.username || url.password) invalid('invalid_product_image');
    }
  }
  if (!Array.isArray(value.prices) || !value.prices.length || value.prices.length > 2) invalid('invalid_product_price');
  const seen = new Set<string>();
  const prices: Money[] = value.prices.map(price => {
    if (!price || typeof price !== 'object' || Array.isArray(price) || Object.keys(price).some(k => !['currency', 'amountMinor'].includes(k)) || !['USDT', 'USD'].includes(price.currency) || seen.has(price.currency) || typeof price.amountMinor !== 'string' || !/^[1-9]\d{0,77}$/.test(price.amountMinor) || BigInt(price.amountMinor) >= 2n ** 256n) return invalid('invalid_product_price');
    seen.add(price.currency); return { currency: price.currency, amountMinor: price.amountMinor };
  });
  const checkoutFields = validateCheckoutFields(value.checkoutFields);
  return { name: value.name.trim(), description: value.description, imageUrl: value.imageUrl, status: value.status as Product['status'], prices, ...(checkoutFields.length ? { checkoutFields } : {}) };
}
export function product(db: Db, productId: string, merchantId?: string): Product | undefined {
  const row = db.prepare(`SELECT r.payload FROM commerce_products p JOIN commerce_product_revisions r ON r.product_id=p.id AND r.revision=p.revision WHERE p.id=?${merchantId ? ' AND p.merchant_id=?' : ''}`).get(...(merchantId ? [productId, merchantId] : [productId])) as { payload: string } | undefined;
  return row ? JSON.parse(row.payload) as Product : undefined;
}
export function saveProduct(db: Db, merchantId: string, input: Record<string, unknown>, productId?: string) {
  return db.transaction(() => {
    const old = productId ? product(db, productId, merchantId) : undefined;
    if (productId && !old) return missing();
    if (input.revision !== undefined && (!old || input.revision !== old.revision)) throw new IdentityError('product_revision_conflict', 409);
    const next: Product = { ...info(input, old), id: old?.id ?? id('prod'), merchantId, revision: (old?.revision ?? 0) + 1 };
    if (old) db.prepare('UPDATE commerce_products SET revision=?,status=?,updated_at=? WHERE id=? AND merchant_id=?').run(next.revision, next.status, now(), next.id, merchantId);
    else db.prepare('INSERT INTO commerce_products VALUES (?,?,?,?,?,?)').run(next.id, merchantId, next.revision, next.status, now(), now());
    db.prepare('INSERT INTO commerce_product_revisions VALUES (?,?,?,?)').run(next.id, next.revision, JSON.stringify(next), now());
    return next;
  })();
}
export function listProducts(db: Db, merchantId: string, limit: number, after?: string) {
  const rows = db.prepare('SELECT id FROM commerce_products WHERE merchant_id=? AND id>? ORDER BY id LIMIT ?').all(merchantId, after ?? '', limit + 1) as { id: string }[];
  return { data: rows.slice(0, limit).map(row => product(db, row.id, merchantId)!), next: rows.length > limit ? rows[limit - 1].id : null };
}
