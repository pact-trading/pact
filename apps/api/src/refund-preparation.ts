import { randomBytes } from 'node:crypto';
import { encodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import { amountMinor, amountString, type Db } from './db.js';
import { IdentityError } from './identity.js';
import type { Relayer } from './relayer.js';
import { escrowAbi } from './chain.js';
import { intentTypedData } from './typed-data.js';
import { confirmedPaymentTerms } from './merchant-settings.js';
/** Read-only preparation. The existing refund endpoint rechecks and atomically
 * reserves the available amount after the merchant supplies their signature. */
export async function prepareRefund(db: Db, relayer: Relayer, router: Address, escrow: Address, paymentId: string, auth: { merchantId: string; address: Address }, body: Record<string, unknown>) {
  const p = db.prepare('SELECT captured_minor,refunded_minor,refund_deadline FROM payments WHERE id=? AND merchant_id=?').get(paymentId, auth.merchantId) as { captured_minor: string; refunded_minor: string; refund_deadline: string | null } | undefined;
  if (!p) throw new IdentityError('not_found', 404);
  // A financed invoice's payment went to the claim holders through the receivables contract; the
  // escrow holds nothing to refund. The merchant settles any credit with the customer directly.
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='financed_payments'").get() && db.prepare('SELECT 1 FROM financed_payments WHERE payment_id=?').get(paymentId))
    throw new IdentityError('financed_payment_not_refundable', 409);
  if (Object.keys(body).some(k => !['amount', 'reason'].includes(k)) || typeof body.reason !== 'string' || body.reason.length > 200) throw new IdentityError('invalid_refund_request', 400);
  let amount: bigint; try { amount = amountMinor(body.amount); } catch { throw new IdentityError('invalid_amount', 400); }
  const reserved = (db.prepare("SELECT amount_minor FROM refunds WHERE payment_id=? AND status='pending'").all(paymentId) as { amount_minor: string }[]).reduce((v, r) => v + BigInt(r.amount_minor), 0n);
  if (amount <= 0n || amount > BigInt(p.captured_minor) - BigInt(p.refunded_minor) - reserved) throw new IdentityError('refund_limit', 400);
  const { refundDeadlineUnix } = confirmedPaymentTerms(db, paymentId);
  const closed = refundDeadlineUnix !== null ? BigInt(refundDeadlineUnix) === 0n || BigInt(refundDeadlineUnix) < BigInt(Math.floor(Date.now() / 1000)) : p.refund_deadline && new Date(p.refund_deadline).getTime() < Date.now();
  if (closed) throw new IdentityError('refund_window_closed', 409);
  const data = encodeFunctionData({ abi: escrowAbi, functionName: 'refund', args: [paymentId as Hex, amount, keccak256(new TextEncoder().encode(body.reason))] });
  const quote = await relayer.quote();
  const intent = { signer: auth.address, merchant: auth.address, target: escrow, dataHash: keccak256(data), amount, feeUSDT: BigInt(quote.minimumFeeMinor), nonce: BigInt(`0x${randomBytes(32).toString('hex')}`), deadline: BigInt(Math.floor(Date.now() / 1000) + 300), maxGas: quote.targetGas };
  return JSON.parse(JSON.stringify({ data, intent, typedData: intentTypedData(intent, router), amount: amountString(amount), reason: body.reason, paymentId }, (_, v) => typeof v === 'bigint' ? v.toString() : v));
}
