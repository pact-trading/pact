import { randomBytes } from 'node:crypto';
import { decodeFunctionData } from 'viem';
import { escrowAbi, receivablesAbi } from './chain.js';
import type { Db } from './db.js';
import { amountMinor, amountString, id, now } from './db.js';
import { Refusal } from './types.js';
import { enqueueWebhook } from './webhooks.js';
import { snapshotPaymentPolicy } from './merchant-settings.js';

type Row = Record<string, string | number | null>;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Record<string, unknown>;
};
export function invoiceRow(db: Db, merchantId: string, invoiceId: string): Row {
  const row = db.prepare('SELECT * FROM invoices WHERE id=? AND merchant_id=?').get(invoiceId, merchantId) as Row | undefined;
  if (!row) throw new Refusal('invoice_not_found');
  return row;
}
export function invoiceView(db: Db, row: Row, baseUrl: string) {
  const metadata = JSON.parse(String(row.metadata ?? '{}')) as Record<string, unknown>;
  const { invoiceMemo: memo = '', ...customMetadata } = metadata;
  const amount = BigInt(String(row.amount_minor)), paid = BigInt(String(row.paid_minor));
  return {
    id: row.id, customerEmail: row.customer_email, amount: amountString(amount), paid: amountString(paid),
    remaining: amountString(amount > paid ? amount - paid : 0n), status: row.status,
    dueAt: row.due_at, allowPartial: Boolean(row.allow_partial), memo, metadata: customMetadata,
    createdAt: row.created_at, hostedUrl: `${baseUrl}/invoices/${row.id}`,
    lines: (db.prepare('SELECT * FROM invoice_lines WHERE invoice_id=? ORDER BY rowid').all(row.id) as Row[]).map(line => ({
      id: line.id, description: line.description, quantity: Number(line.quantity), unitAmount: amountString(String(line.unit_amount_minor)),
      amount: amountString(BigInt(String(line.unit_amount_minor)) * BigInt(Number(line.quantity))),
    })),
  };
}
export function createInvoice(db: Db, merchantId: string, body: Record<string, unknown>, baseUrl: string) {
  const email = body.customerEmail ?? body.payer_email;
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid customer email');
  if (body.lines !== undefined && !Array.isArray(body.lines)) throw new Error('Invalid invoice lines');
  const lines = (body.lines as unknown[] | undefined ?? []).map(value => {
    const line = object(value);
    const quantity = line.quantity === undefined ? 1 : line.quantity;
    if (typeof quantity !== 'number' || !Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('Quantity must be a positive safe integer');
    if (typeof line.description !== 'string' || !line.description.trim() || line.description.length > 1000) throw new Error('Line description required (maximum 1000 characters)');
    return { description: line.description.trim(), quantity, unit: amountMinor(line.unitAmount ?? line.unit_amount) };
  });
  if (lines.length > 100) throw new Error('Maximum 100 invoice lines');
  const amount = lines.length ? lines.reduce((sum, line) => sum + line.unit * BigInt(line.quantity), 0n) : amountMinor(body.amount);
  if (lines.length && body.amount !== undefined && amountMinor(body.amount) !== amount) throw new Error('Invoice amount does not match line total');
  const due = body.dueAt ?? body.due_date;
  if (due !== undefined && due !== null && (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(due) || !Number.isFinite(Date.parse(due)))) throw new Error('Invalid due date');
  const partial = body.allowPartial ?? body.allow_partial ?? false;
  if (typeof partial !== 'boolean') throw new Error('allowPartial must be boolean');
  const status = body.status ?? 'sent';
  if (status !== 'draft' && status !== 'sent') throw new Error('Initial status must be draft or sent');
  const metadata = body.metadata === undefined ? {} : object(body.metadata);
  if ('invoiceMemo' in metadata) throw new Error('Reserved metadata field: invoiceMemo');
  const memo = body.memo ?? '';
  if (typeof memo !== 'string' || memo.length > 5000) throw new Error('Invalid memo');
  const invoiceId = id('inv');
  db.transaction(() => {
    db.prepare('INSERT INTO invoices(id,merchant_id,customer_email,amount_minor,paid_minor,due_at,allow_partial,metadata,status,financing_status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(invoiceId, merchantId, email, amount.toString(), '0', due ? new Date(String(due)).toISOString() : null, partial ? 1 : 0, JSON.stringify({ ...metadata, invoiceMemo: memo }), status, null, now());
    for (const line of lines) db.prepare('INSERT INTO invoice_lines VALUES (?,?,?,?,?)').run(id('line'), invoiceId, line.description, line.quantity, line.unit.toString());
    enqueueWebhook(db, merchantId, status === 'draft' ? 'invoice.created' : 'invoice.sent', invoiceId);
  })();
  return invoiceView(db, invoiceRow(db, merchantId, invoiceId), baseUrl);
}
export function sendInvoice(db: Db, merchantId: string, invoiceId: string, baseUrl: string) {
  return db.transaction(() => {
    const invoice = invoiceRow(db, merchantId, invoiceId);
    if (invoice.status === 'draft') {
      db.prepare("UPDATE invoices SET status='sent' WHERE id=?").run(invoiceId);
      enqueueWebhook(db, merchantId, 'invoice.sent', invoiceId);
    } else if (invoice.status !== 'sent') throw new Refusal('invoice_not_draft');
    return invoiceView(db, invoiceRow(db, merchantId, invoiceId), baseUrl);
  })();
}

/**
 * Called in the SAME synchronous transaction that inserts the payment reservation. `except` leaves
 * one attempt out of the reserved total, so that attempt can be re-checked against the balance.
 */
export function validateInvoicePayment(db: Db, merchantId: string, invoiceId: unknown, amount: bigint, except?: string) {
  if (typeof invoiceId !== 'string') throw new Refusal('invalid_invoice_id');
  const invoice = invoiceRow(db, merchantId, invoiceId);
  if (!['sent', 'acknowledged', 'partially_paid', 'overdue'].includes(String(invoice.status))) throw new Refusal('invoice_not_payable');
  const outstanding = BigInt(String(invoice.amount_minor)) - BigInt(String(invoice.paid_minor));
  let reserved = 0n;
  // Status 'expired' is set only by startPayerInvoicePayment, after it has shown that no signed charge
  // for the attempt can still execute. Any later charge would still be indexed and credited.
  const payments = db.prepare("SELECT id,amount_minor,captured_minor,status,metadata FROM payments WHERE merchant_id=? AND status NOT IN ('voided','refunded','partially_refunded','expired')").all(merchantId) as Row[];
  for (const payment of payments) {
    if (payment.id === except || JSON.parse(String(payment.metadata ?? '{}')).invoiceId !== invoiceId) continue;
    // A passed expires_at or an uncertain/reverted attempt is not proof that its signed charge cannot
    // execute. Keep its reservation until the payment itself is definitively closed.
    const remainder = BigInt(String(payment.amount_minor)) - BigInt(String(payment.captured_minor));
    if (remainder > 0n) reserved += remainder;
  }
  if (amount > outstanding - reserved) throw new Refusal('invoice_payment_limit');
  if (!invoice.allow_partial && amount !== outstanding) throw new Refusal('invoice_partial_disabled');
  return invoice;
}
export function createInvoiceCheckout(db: Db, merchantId: string, invoiceId: string, body: Record<string, unknown>, baseUrl: string) {
  return db.transaction(() => {
    const row = invoiceRow(db, merchantId, invoiceId);
    const amount = body.amount === undefined ? BigInt(String(row.amount_minor)) - BigInt(String(row.paid_minor)) : amountMinor(body.amount);
    if (amount <= 0n) throw new Refusal('invoice_not_payable');
    validateInvoicePayment(db, merchantId, invoiceId, amount);
    const paymentId = `0x${randomBytes(32).toString('hex')}`;
    db.prepare('INSERT INTO payments(id,merchant_id,amount_minor,description,customer,metadata,status,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(paymentId, merchantId, amount.toString(), `Invoice ${invoiceId}`, row.customer_email, JSON.stringify({ invoiceId }), 'open', now());
    const refundWindowSeconds = snapshotPaymentPolicy(db, paymentId, merchantId);
    return { id: paymentId, invoiceId, amount: amountString(amount), currency: 'USDT', status: 'pending', financialStatus: 'open', checkoutUrl: `${baseUrl}/pay/${paymentId}`, refundWindowSeconds };
  })();
}

/** Seconds a chain block timestamp may run ahead of this server's clock. */
const CHAIN_CLOCK_SKEW_SECONDS = 60n;

/**
 * For each payment, the latest deadline of a charge this payer signed or was offered to sign, and
 * whether a submitted charge is still unsettled. Router.execute is permissionless and refuses only
 * after the deadline, so a signed charge can run until then whether or not it reached this API.
 */
function chargeExposure(db: Db, payer: string, escrow: string, paymentIds: string[]) {
  const exposure = new Map<string, { deadline: bigint; pending: boolean }>();
  const note = (paymentId: string, deadline: bigint, pending: boolean) => {
    const seen = exposure.get(paymentId) ?? { deadline: 0n, pending: false };
    exposure.set(paymentId, { deadline: deadline > seen.deadline ? deadline : seen.deadline, pending: seen.pending || pending });
  };
  for (const row of db.prepare('SELECT status,request_json FROM intents WHERE signer=?').all(payer) as Array<{ status: string; request_json: string }>) {
    try {
      const request = JSON.parse(row.request_json) as { data: `0x${string}`; intent: { target: string; deadline: string } };
      if (request.intent.target.toLowerCase() !== escrow.toLowerCase()) {
        // A financed invoice's payment to the receivables contract counts the same way.
        const pay = decodeFunctionData({ abi: receivablesAbi, data: request.data });
        if (pay.functionName === 'pay') note(String(pay.args?.[1]).toLowerCase(), BigInt(request.intent.deadline), ['submitted', 'reconciliation_required'].includes(row.status));
        continue;
      }
      const call = decodeFunctionData({ abi: escrowAbi, data: request.data });
      if (call.functionName !== 'charge' && call.functionName !== 'authorize') continue;
      note(String(call.args?.[0]).toLowerCase(), BigInt(request.intent.deadline), ['submitted', 'reconciliation_required'].includes(row.status));
    } catch { /* Not a readable escrow charge: it cannot belong to an invoice attempt. */ }
  }
  for (const paymentId of paymentIds) {
    const offer = db.prepare('SELECT deadline FROM hosted_intent_offers WHERE payment_id=?').get(paymentId) as { deadline: number } | undefined;
    if (offer) note(paymentId.toLowerCase(), BigInt(offer.deadline), false);
  }
  return exposure;
}

/**
 * The payer's Pay button on a hosted invoice. They can leave and come back as often as they like.
 * If they already have an open attempt for the same amount, it is returned as is. Their other unpaid
 * attempts are expired once nothing signed for them can still execute. An attempt that might still
 * execute keeps its reservation, so the same balance can never be charged twice.
 */
export function startPayerInvoicePayment(db: Db, input: { merchantId: string; invoiceId: string; payer: string; amount?: bigint; escrow: string; baseUrl: string }) {
  const payer = input.payer.toLowerCase();
  return db.transaction(() => {
    const invoice = invoiceRow(db, input.merchantId, input.invoiceId);
    const amount = input.amount ?? BigInt(String(invoice.amount_minor)) - BigInt(String(invoice.paid_minor));
    if (amount <= 0n) throw new Refusal('invoice_not_payable');
    const attempts = (db.prepare("SELECT id,amount_minor,status,metadata FROM payments WHERE merchant_id=? AND lower(payer)=? AND status IN ('open','failed') AND captured_minor='0' ORDER BY created_at DESC").all(input.merchantId, payer) as Row[])
      .filter(p => JSON.parse(String(p.metadata ?? '{}')).invoiceId === input.invoiceId);
    // A failed approval can never be retried for the same payment, so that attempt is not offered again.
    const deadApproval = (paymentId: string) => !!db.prepare("SELECT 1 FROM approval_attempts WHERE payment_id=? AND status IN ('failed','reconciliation_required')").get(paymentId);
    const reusable = attempts.find(p => p.status === 'open' && BigInt(String(p.amount_minor)) === amount && !deadApproval(String(p.id)));
    if (reusable) {
      validateInvoicePayment(db, input.merchantId, input.invoiceId, amount, String(reusable.id));
      return { paymentId: String(reusable.id), amount: amountString(amount), reused: true };
    }
    const exposure = chargeExposure(db, payer, input.escrow, attempts.map(p => String(p.id)));
    const cutoff = BigInt(Math.floor(Date.now() / 1000)) - CHAIN_CLOCK_SKEW_SECONDS;
    let live = 0;
    for (const p of attempts) {
      const charge = exposure.get(String(p.id).toLowerCase());
      if (charge && (charge.pending || charge.deadline >= cutoff)) { live++; continue; }
      db.prepare("UPDATE payments SET status='expired' WHERE id=? AND status IN ('open','failed') AND captured_minor='0'").run(p.id);
    }
    try {
      const payment = createInvoiceCheckout(db, input.merchantId, input.invoiceId, { amount: amountString(amount) }, input.baseUrl);
      db.prepare('UPDATE payments SET payer=? WHERE id=?').run(payer, payment.id);
      return { paymentId: payment.id, amount: payment.amount, reused: false };
    } catch (error) {
      // The payer's own attempt that may still be charged is what holds the balance: say so.
      if (error instanceof Refusal && error.code === 'invoice_payment_limit' && live) throw new Refusal('invoice_payment_in_progress');
      throw error;
    }
  })();
}
