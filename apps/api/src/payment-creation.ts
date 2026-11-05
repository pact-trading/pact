import { randomBytes } from 'node:crypto';
import { now, type Db } from './db.js';
import { snapshotPaymentPolicy } from './merchant-settings.js';

/** Shared persistence only; all caller-specific permission/price checks precede
 * this transaction. There is no signer, RPC call or success transition here. */
export function createOpenPayment(db: Db, input: { merchantId: string; amount: bigint; description?: string | null; email?: string | null; metadata?: Record<string, unknown>; customMetadata?: Record<string, unknown>; expiresAt?: string | null; payer?: string | null; id?: string }) {
  if (input.amount <= 0n || input.amount >= 2n ** 256n) throw new Error('Invalid payment amount');
  return db.transaction(() => {
    const paymentId = input.id ?? `0x${randomBytes(32).toString('hex')}`;
    db.prepare('INSERT INTO payments(id,merchant_id,amount_minor,currency,description,customer,metadata,custom_metadata,status,expires_at,payer,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(paymentId, input.merchantId, input.amount.toString(), 'USDT', input.description ?? null, input.email ?? null, JSON.stringify(input.metadata ?? {}), JSON.stringify(input.customMetadata ?? {}), 'open', input.expiresAt ?? null, input.payer?.toLowerCase() ?? null, now());
    snapshotPaymentPolicy(db, paymentId, input.merchantId);
    return paymentId;
  })();
}
