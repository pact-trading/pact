import type { Customer, Money } from '@pactagent/core/commerce-types';
import type { Db } from '../db.js';
import { orderView, type OrderRow } from './orders.js';
import { missing } from './products.js';
type CustomerRow = { id: string; merchant_id: string; subject_id: string; email: string | null; name: string | null; wallet: string };
export function customerView(db: Db, row: CustomerRow) {
  const orders = (db.prepare('SELECT * FROM commerce_orders WHERE customer_id=? AND merchant_id=?').all(row.id, row.merchant_id) as OrderRow[]).map(o => orderView(db, o));
  const amounts = new Map<Money['currency'], bigint>();
  for (const order of orders) if (['paid', 'partially_refunded', 'refunded'].includes(order.status)) amounts.set(order.total.currency, (amounts.get(order.total.currency) ?? 0n) + BigInt(order.total.amountMinor) - BigInt(order.refundedMinor));
  const customer: Customer = { id: row.id, merchantId: row.merchant_id, subjectId: row.subject_id, email: row.email, name: row.name };
  return { ...customer, wallet: row.wallet, orderCount: orders.length, totals: [...amounts].map(([currency, amount]) => ({ currency, amountMinor: amount.toString() })) };
}
export function customerDetail(db: Db, merchantId: string, customerId: string) {
  const row = db.prepare('SELECT * FROM commerce_customers WHERE id=? AND merchant_id=?').get(customerId, merchantId) as CustomerRow | undefined;
  return row ? customerView(db, row) : missing();
}
export function listCustomers(db: Db, merchantId: string, limit: number, after = '') {
  const rows = db.prepare('SELECT * FROM commerce_customers WHERE merchant_id=? AND id>? ORDER BY id LIMIT ?').all(merchantId, after, limit + 1) as CustomerRow[];
  return { data: rows.slice(0, limit).map(row => customerView(db, row)), next: rows.length > limit ? rows[limit - 1].id : null };
}
