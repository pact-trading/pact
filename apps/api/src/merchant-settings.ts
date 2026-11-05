import type { Db } from './db.js';
import { Refusal } from './types.js';

export const DEFAULT_REFUND_WINDOW_SECONDS = 30 * 86400;
type SettingsRow = { brand_name: string; logo_url: string | null; refund_window_seconds: number };
export function checkoutSettings(db: Db, merchantId: string) {
  const row = db.prepare('SELECT brand_name,logo_url,refund_window_seconds FROM merchant_settings WHERE merchant_id=?').get(merchantId) as SettingsRow | undefined;
  return { brandName: row?.brand_name ?? '', logoUrl: row?.logo_url ?? null, refundWindowSeconds: row?.refund_window_seconds ?? DEFAULT_REFUND_WINDOW_SECONDS };
}
export function merchantSettings(db: Db, merchantId: string) {
  const merchant = db.prepare('SELECT address,webhook_url,webhook_secret IS NOT NULL AS configured FROM merchants WHERE id=?').get(merchantId) as { address: string; webhook_url: string | null; configured: number } | undefined;
  if (!merchant) throw new Refusal('merchant_not_found');
  return { ...checkoutSettings(db, merchantId), payoutAddress: merchant.address,
    payoutMode: 'merchant_wallet' as const, webhook: { url: merchant.webhook_url, configured: Boolean(merchant.configured) } };
}
export function updateMerchantSettings(db: Db, merchantId: string, input: Record<string, unknown>) {
  if (Object.keys(input).some(key => !['brandName', 'logoUrl', 'refundWindowSeconds'].includes(key))) throw new Error('Unsupported settings field; payout remains the bound merchant wallet');
  const previous = checkoutSettings(db, merchantId);
  const brandName = input.brandName === undefined ? previous.brandName : input.brandName;
  if (typeof brandName !== 'string' || brandName.length > 200 || /[\u0000-\u001f\u007f]/.test(brandName)) throw new Error('Brand name must be at most 200 characters without control characters');
  let logoUrl = input.logoUrl === undefined ? previous.logoUrl : input.logoUrl;
  if (logoUrl !== null) {
    if (typeof logoUrl !== 'string' || logoUrl.length > 2048) throw new Error('Invalid logo URL');
    let url; try { url = new URL(logoUrl); } catch { throw new Error('Invalid logo URL'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Logo URL must use HTTPS without credentials');
    logoUrl = url.toString();
  }
  const window = input.refundWindowSeconds === undefined ? previous.refundWindowSeconds : input.refundWindowSeconds;
  if (typeof window !== 'number' || !Number.isSafeInteger(window) || window <= 0 || window > 365 * 86400) throw new Error('Refund window must be an integer between 1 and 31536000 seconds');
  db.prepare(`INSERT INTO merchant_settings VALUES (?,?,?,?,?) ON CONFLICT(merchant_id) DO UPDATE SET
    brand_name=excluded.brand_name,logo_url=excluded.logo_url,refund_window_seconds=excluded.refund_window_seconds,updated_at=excluded.updated_at`)
    .run(merchantId, brandName.trim(), logoUrl, window, new Date().toISOString());
  return merchantSettings(db, merchantId);
}
/** Call inside the payment creation transaction. No later settings update changes this promise. */
export function snapshotPaymentPolicy(db: Db, paymentId: string, merchantId: string) {
  const { refundWindowSeconds } = checkoutSettings(db, merchantId);
  db.prepare('INSERT INTO payment_policies VALUES (?,?)').run(paymentId, refundWindowSeconds);
  return refundWindowSeconds;
}
export function paymentRefundWindow(db: Db, paymentId: string): number | null {
  return (db.prepare('SELECT refund_window_seconds FROM payment_policies WHERE payment_id=?').get(paymentId) as { refund_window_seconds: number } | undefined)?.refund_window_seconds ?? null;
}
export function confirmedPaymentTerms(db: Db, paymentId: string) {
  const row = db.prepare('SELECT * FROM payment_contract_terms WHERE payment_id=?').get(paymentId) as { refund_window_seconds: string; refund_deadline_unix: string } | undefined;
  return { onchainRefundWindowSeconds: row?.refund_window_seconds ?? null, refundDeadlineUnix: row?.refund_deadline_unix ?? null };
}
export function deadlineIso(seconds: string): string | null {
  const value = BigInt(seconds);
  // Preserve the exact uint64 separately, even if it cannot be represented by Date.
  return value > 0n && value <= 8_640_000_000_000n ? new Date(Number(value) * 1000).toISOString() : null;
}
