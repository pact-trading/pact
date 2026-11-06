import { randomBytes } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { decodeFunctionData, encodeFunctionData, hashTypedData, keccak256, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import type { ApprovalService } from '../approval.js';
import { escrowAbi, receivablesAbi } from '../chain.js';
import type { FinancingService } from '../financing/service.js';
import { now, type Db } from '../db.js';
import { IdentityError, type VerifiedIdentity } from '../identity.js';
import { startPayerInvoicePayment } from '../invoices.js';
import { acknowledgementTypedData, invoiceDetail } from '../invoices-live.js';
import { checkoutSettings, paymentRefundWindow } from '../merchant-settings.js';
import type { Relayer } from '../relayer.js';
import { intentTypedData } from '../typed-data.js';
import { discountView } from '../discounts.js';
import { enqueueWebhook } from '../webhooks.js';

export interface HostedPaymentServices {
  db: Db; approval: ApprovalService; relayer: Relayer; router: Address; escrow: Address; baseUrl: string;
  submitIntent: (body: Record<string, unknown>, auth: { merchantId: string; address: Address }) => Promise<unknown>;
  /** Invoice financing: a financed invoice's payment goes to the receivables contract, which pays the investors. */
  financing?: FinancingService;
}
type Row = Record<string, string | number | null>;
const bad = (code: string, status: 400 | 403 | 404 | 409 = 400): never => { throw new IdentityError(code, status); };
const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));

/**
 * Payer routes for payments that are not product checkouts: invoices today. The payer owns the
 * payment once they start it; readiness, the USDT permit and the signed charge follow the checkout
 * routes. Pact's fee comes out of the payment, at the invoice rate.
 */
export function mountHostedPayments(app: Hono, s: HostedPaymentServices, payer: (c: Context) => Promise<VerifiedIdentity>) {
  const { db } = s;
  const body = async (c: Context) => { try { const b = await c.req.json(); if (b && typeof b === 'object' && !Array.isArray(b)) return b as Record<string, unknown>; } catch { /* fallthrough */ } return bad('invalid_json'); };
  const merchantAddress = (merchantId: string) => (db.prepare('SELECT address FROM merchants WHERE id=?').get(merchantId) as { address: Address }).address;

  // ---- invoices addressed to this payer's email
  const myInvoice = (user: VerifiedIdentity, invoiceId: string) => {
    if (!user.email) return bad('email_required', 403);
    const row = db.prepare("SELECT * FROM invoices WHERE id=? AND lower(customer_email)=lower(?) AND status!='draft'").get(invoiceId, user.email) as Row | undefined;
    return row ?? bad('invoice_not_found', 404);
  };
  app.get('/invoices/:id/brand', c => {
    const row = db.prepare("SELECT merchant_id FROM invoices WHERE id=? AND status!='draft'").get(c.req.param('id')) as { merchant_id: string } | undefined;
    if (!row) return bad('invoice_not_found', 404);
    const brand = checkoutSettings(db, row.merchant_id);
    return c.json({ brandName: brand.brandName, logoUrl: brand.logoUrl });
  });
  app.get('/me/invoices', async c => {
    const user = await payer(c);
    if (!user.email) return c.json({ data: [] });
    const rows = db.prepare("SELECT * FROM invoices WHERE lower(customer_email)=lower(?) AND status!='draft' ORDER BY created_at DESC LIMIT 200").all(user.email) as Row[];
    return c.json({ data: rows.map(r => invoiceDetail(db, r, s.baseUrl)) });
  });
  app.get('/me/invoices/:id', async c => { const user = await payer(c); return c.json(invoiceDetail(db, myInvoice(user, c.req.param('id')), s.baseUrl)); });
  app.get('/me/invoices/:id/acknowledgement', async c => {
    const user = await payer(c), row = myInvoice(user, c.req.param('id'));
    return c.json(json(acknowledgementTypedData(row, merchantAddress(String(row.merchant_id)), user.wallet.address)));
  });
  app.post('/me/invoices/:id/acknowledge', async c => {
    const user = await payer(c), row = myInvoice(user, c.req.param('id')), b = await body(c);
    if (db.prepare('SELECT 1 FROM invoice_acknowledgements WHERE invoice_id=?').get(row.id)) return c.json(invoiceDetail(db, row, s.baseUrl));
    if (!['sent', 'overdue', 'partially_paid'].includes(String(row.status))) return bad('invoice_not_open', 409);
    const typed = acknowledgementTypedData(row, merchantAddress(String(row.merchant_id)), user.wallet.address);
    let signer: Address;
    try { signer = await recoverTypedDataAddress({ ...typed, signature: b.signature as Hex }); } catch { return bad('invalid_signature'); }
    if (signer.toLowerCase() !== user.wallet.address.toLowerCase()) return bad('invalid_signature');
    db.transaction(() => {
      db.prepare('INSERT INTO invoice_acknowledgements VALUES (?,?,?,?,?)').run(row.id, signer.toLowerCase(), b.signature, hashTypedData(typed), now());
      if (row.status === 'sent') db.prepare("UPDATE invoices SET status='acknowledged' WHERE id=?").run(row.id);
      enqueueWebhook(db, String(row.merchant_id), 'invoice.acknowledged', String(row.id), { signer: signer.toLowerCase() });
    })();
    return c.json(invoiceDetail(db, myInvoice(user, String(row.id)), s.baseUrl));
  });
  app.post('/me/invoices/:id/payments', async c => {
    const user = await payer(c), row = myInvoice(user, c.req.param('id')), b = await body(c);
    if (b.amountMinor !== undefined && (typeof b.amountMinor !== 'string' || !/^[1-9]\d{0,30}$/.test(b.amountMinor))) return bad('invalid_amount');
    const payment = startPayerInvoicePayment(db, {
      merchantId: String(row.merchant_id), invoiceId: String(row.id), payer: user.wallet.address,
      amount: b.amountMinor === undefined ? undefined : BigInt(b.amountMinor as string), escrow: s.escrow, baseUrl: s.baseUrl,
    });
    return c.json({ paymentId: payment.paymentId, amount: payment.amount }, payment.reused ? 200 : 201);
  });

  // ---- hosted payments owned by this payer
  const myPayment = (user: VerifiedIdentity, paymentId: string) => {
    const row = db.prepare('SELECT * FROM payments WHERE id=? AND lower(payer)=lower(?)').get(paymentId, user.wallet.address) as Row | undefined;
    return row ?? bad('payment_not_found', 404);
  };
  app.get('/me/payments/:id', async c => {
    const user = await payer(c), p = myPayment(user, c.req.param('id'));
    const metadata = JSON.parse(String(p.metadata ?? '{}')) as { invoiceId?: string; linkId?: string; discountCode?: string | null; amountGrossMinor?: string; amountDiscountMinor?: string };
    const brand = checkoutSettings(db, String(p.merchant_id));
    return c.json({ id: p.id, amountMinor: p.amount_minor, description: p.description, status: p.status, txHash: p.tx_hash, createdAt: p.created_at, expiresAt: p.expires_at, invoiceId: metadata.invoiceId ?? null, ...(metadata.linkId ? discountView(metadata.amountGrossMinor ?? null, metadata.amountDiscountMinor ?? null, metadata.discountCode ?? null) : {}), brand: { brandName: brand.brandName, logoUrl: brand.logoUrl }, merchant: merchantAddress(String(p.merchant_id)) });
  });
  app.get('/me/payments/:id/readiness', async c => {
    const user = await payer(c), p = myPayment(user, c.req.param('id'));
    return c.json(await s.approval.get(String(p.id), String(p.merchant_id), user.wallet.address));
  });
  app.post('/me/payments/:id/approval', async c => {
    const user = await payer(c), p = myPayment(user, c.req.param('id')), b = await body(c);
    return c.json(await s.approval.submit(String(p.id), String(p.merchant_id), { ...b, payer: user.wallet.address }));
  });
  app.get('/me/payments/:id/intent', async c => {
    const user = await payer(c), p = myPayment(user, c.req.param('id'));
    const readiness = await s.approval.get(String(p.id), String(p.merchant_id), user.wallet.address);
    if (readiness.status !== 'ready') return bad('payment_not_ready', 409);
    const merchant = merchantAddress(String(p.merchant_id));
    const invoiceId = (JSON.parse(String(p.metadata ?? '{}')) as { invoiceId?: string }).invoiceId;
    // While an invoice is financed its payment goes to the receivables contract, never the escrow.
    const route = invoiceId && s.financing ? await s.financing.route(invoiceId, merchant) : null;
    const amount = BigInt(String(p.amount_minor));
    const data = route
      ? encodeFunctionData({ abi: receivablesAbi, functionName: 'pay', args: [route.claimId, p.id as Hex, amount] })
      // An invoice the merchant sent pays at the invoice rate; anything else at the checkout rate.
      : encodeFunctionData({ abi: escrowAbi, functionName: invoiceId ? 'chargeInvoice' : 'charge', args: [p.id as Hex, merchant, amount, BigInt(paymentRefundWindow(db, String(p.id))!)] });
    if (route) s.financing!.checkPayment(route.claimId, amount, user.wallet.address as Address);
    const quote = await s.relayer.quote(route ? s.financing!.paymentGas(route.holders) : undefined);
    const intent = { signer: user.wallet.address, merchant, target: route ? s.financing!.addresses.receivables : s.escrow, dataHash: keccak256(data), amount, nonce: BigInt(`0x${randomBytes(32).toString('hex')}`), deadline: BigInt(Math.floor(Date.now() / 1000) + 300), maxGas: quote.targetGas };
    // Remember how long this charge stays signable, so an abandoned attempt is released only after that.
    db.prepare('INSERT INTO hosted_intent_offers VALUES (?,?) ON CONFLICT(payment_id) DO UPDATE SET deadline=max(deadline,excluded.deadline)').run(p.id, Number(intent.deadline));
    return c.json(json({ data, intent, typedData: intentTypedData(intent, s.router) }));
  });
  app.post('/me/payments/:id/intent', async c => {
    const user = await payer(c), p = myPayment(user, c.req.param('id')), b = await body(c);
    const i = b.intent as Record<string, unknown> | undefined;
    const receivables = s.financing?.addresses.receivables;
    if (!i || String(i.signer).toLowerCase() !== user.wallet.address.toLowerCase()) return bad('intent_mismatch');
    if (receivables && String(i.target).toLowerCase() === receivables.toLowerCase()) {
      let pay; try { pay = decodeFunctionData({ abi: receivablesAbi, data: b.data as Hex }); } catch { return bad('intent_mismatch'); }
      if (pay.functionName !== 'pay' || String(pay.args?.[1]).toLowerCase() !== String(p.id).toLowerCase()) return bad('intent_mismatch');
      return c.json(await s.submitIntent(b, { merchantId: String(p.merchant_id), address: merchantAddress(String(p.merchant_id)) }));
    }
    if (String(i.target).toLowerCase() !== s.escrow.toLowerCase()) return bad('intent_mismatch');
    let call; try { call = decodeFunctionData({ abi: escrowAbi, data: b.data as Hex }); } catch { return bad('intent_mismatch'); }
    if (!['charge', 'chargeInvoice'].includes(call.functionName) || String(call.args?.[0]).toLowerCase() !== String(p.id).toLowerCase()) return bad('intent_mismatch');
    return c.json(await s.submitIntent(b, { merchantId: String(p.merchant_id), address: merchantAddress(String(p.merchant_id)) }));
  });
}
