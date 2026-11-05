import type { Address, Hex } from 'viem';
import { amountString, id, now, type Db } from './db.js';
import { invoiceRow, invoiceView } from './invoices.js';
import { Refusal } from './types.js';
import { enqueueWebhook } from './webhooks.js';

type Row = Record<string, string | number | null>;
const DAY = 86_400_000;

export function initLiveInvoices(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS invoice_details(invoice_id TEXT PRIMARY KEY, customer_name TEXT);
    CREATE TABLE IF NOT EXISTS invoice_acknowledgements(invoice_id TEXT PRIMARY KEY, signer TEXT NOT NULL, signature TEXT NOT NULL, typed_hash TEXT NOT NULL, signed_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invoice_manual_reminders(id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, merchant_id TEXT NOT NULL, message TEXT NOT NULL,
      send_at TEXT NOT NULL, sent_at TEXT, cancelled_at TEXT, created_at TEXT NOT NULL);`);
}

/** EIP-712 "I owe this invoice". Stored with its signature; anyone can verify it against the payer. */
export function acknowledgementTypedData(invoice: Row, merchant: Address, payer: Address) {
  return {
    domain: { name: 'Pact Invoices', version: '1', chainId: 1874 },
    types: {
      InvoiceAcknowledgement: [
        { name: 'invoiceId', type: 'string' }, { name: 'merchant', type: 'address' }, { name: 'payer', type: 'address' },
        { name: 'amount', type: 'uint256' }, { name: 'dueAt', type: 'uint256' }, { name: 'statement', type: 'string' },
      ],
    },
    primaryType: 'InvoiceAcknowledgement' as const,
    message: {
      invoiceId: String(invoice.id), merchant, payer, amount: BigInt(String(invoice.amount_minor)),
      dueAt: BigInt(invoice.due_at ? Math.floor(new Date(String(invoice.due_at)).getTime() / 1000) : 0),
      statement: 'I received this invoice and owe the amount by the due date.',
    },
  };
}

export function invoiceDetail(db: Db, row: Row, baseUrl: string) {
  const view = invoiceView(db, row, baseUrl);
  const merchantId = String(row.merchant_id);
  // Sequential per merchant, by creation time; invoices are never deleted.
  const rank = (db.prepare('SELECT count(*) n FROM invoices WHERE merchant_id=? AND created_at<=?').get(merchantId, row.created_at) as { n: number }).n;
  const details = db.prepare('SELECT customer_name FROM invoice_details WHERE invoice_id=?').get(row.id) as { customer_name: string | null } | undefined;
  const merchantName = (db.prepare('SELECT brand_name FROM merchant_settings WHERE merchant_id=?').get(merchantId) as { brand_name: string } | undefined)?.brand_name || 'This business';
  const ack = db.prepare('SELECT signer,signed_at FROM invoice_acknowledgements WHERE invoice_id=?').get(row.id) as { signer: Address; signed_at: string } | undefined;
  const webhook = db.prepare('SELECT webhook_url FROM merchants WHERE id=?').get(merchantId) as { webhook_url: string | null } | undefined;
  const sent = db.prepare('SELECT stage,created_at FROM reminders WHERE invoice_id=?').all(row.id) as Array<{ stage: string; created_at: string }>;
  const due = row.due_at ? new Date(String(row.due_at)).getTime() : null;
  const reminders = due === null ? [] : ([['seven_days', 7 * DAY], ['one_day', DAY], ['overdue', 0]] as const).map(([stage, before]) => ({
    stage, dueAt: new Date(due - before).toISOString(), sentAt: sent.find(r => r.stage === stage)?.created_at ?? null,
    channel: webhook?.webhook_url ? 'webhook' as const : 'dashboard' as const,
  }));
  const events = db.prepare("SELECT type,payload,created_at FROM webhook_events WHERE merchant_id=? AND object_id=? ORDER BY created_at").all(merchantId, row.id) as Array<{ type: string; payload: string; created_at: string }>;
  const payments = (db.prepare("SELECT id,captured_minor,tx_hash,created_at,status,metadata FROM payments WHERE merchant_id=? AND status IN ('captured','partially_refunded','refunded')").all(merchantId) as Row[])
    .filter(p => (JSON.parse(String(p.metadata ?? '{}')) as { invoiceId?: string }).invoiceId === row.id);
  const manual = db.prepare('SELECT message,sent_at FROM invoice_manual_reminders WHERE invoice_id=? AND sent_at IS NOT NULL').all(row.id) as Array<{ message: string; sent_at: string }>;
  const activity = [
    { type: 'created' as const, at: String(row.created_at), detail: 'Invoice created' },
    ...events.filter(e => e.type === 'invoice.sent').map(e => ({ type: 'sent' as const, at: e.created_at, detail: `Sent to ${row.customer_email}` })),
    ...sent.map(r => ({ type: 'reminder' as const, at: r.created_at, detail: r.stage === 'overdue' ? 'Overdue reminder' : `Reminder: due in ${r.stage === 'one_day' ? '1 day' : '7 days'}` })),
    ...manual.map(r => ({ type: 'reminder' as const, at: r.sent_at, detail: `Reminder: ${r.message.slice(0, 80)}` })),
    ...(ack ? [{ type: 'acknowledged' as const, at: ack.signed_at, detail: 'The customer signed that they owe this invoice' }] : []),
    ...payments.map(p => ({ type: 'payment' as const, at: String(p.created_at), detail: 'Payment received', amount: amountString(String(p.captured_minor)), txHash: (p.tx_hash ?? null) as Hex | null })),
    ...events.filter(e => e.type === 'invoice.overdue').map(e => ({ type: 'overdue' as const, at: e.created_at, detail: 'Past its due date' })),
    ...events.filter(e => e.type === 'invoice.paid').map(e => ({ type: 'paid' as const, at: e.created_at, detail: 'Paid in full' })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  return {
    ...view, number: `INV-${String(rank).padStart(4, '0')}`, customerName: details?.customer_name ?? null, merchantName,
    acknowledgement: ack ? { signedAt: ack.signed_at, signer: ack.signer, txHash: null } : null, reminders, activity,
  };
}

export function setCustomerName(db: Db, invoiceId: string, name: unknown) {
  if (typeof name !== 'string' || !name.trim()) return;
  db.prepare('INSERT INTO invoice_details VALUES (?,?) ON CONFLICT(invoice_id) DO UPDATE SET customer_name=excluded.customer_name').run(invoiceId, name.trim().slice(0, 200));
}

type ReminderRow = { id: string; invoice_id: string; message: string; send_at: string; sent_at: string | null; cancelled_at: string | null; created_at: string };
const reminderView = (r: ReminderRow, to: string) => ({ id: r.id, invoiceId: r.invoice_id, message: r.message, to, sendAt: r.send_at, sentAt: r.sent_at, cancelledAt: r.cancelled_at, createdAt: r.created_at });

export function manualReminders(db: Db, merchantId: string, invoiceId: string) {
  const invoice = invoiceRow(db, merchantId, invoiceId);
  return (db.prepare('SELECT * FROM invoice_manual_reminders WHERE invoice_id=? ORDER BY send_at DESC').all(invoiceId) as ReminderRow[]).map(r => reminderView(r, String(invoice.customer_email)));
}
/** A written reminder, now or at a set time. The keeper sends scheduled ones (webhook `invoice.reminder`). */
export function scheduleReminder(db: Db, merchantId: string, invoiceId: string, body: Record<string, unknown>) {
  const invoice = invoiceRow(db, merchantId, invoiceId);
  if (!['sent', 'acknowledged', 'partially_paid', 'overdue'].includes(String(invoice.status))) throw new Refusal('invoice_not_open');
  const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim().slice(0, 2000) : 'A friendly reminder that this invoice is open.';
  const sendAt = body.sendAt ? new Date(String(body.sendAt)) : new Date();
  if (!Number.isFinite(sendAt.getTime())) throw new Refusal('invalid_send_at');
  const reminderId = id('rem');
  db.prepare('INSERT INTO invoice_manual_reminders VALUES (?,?,?,?,?,NULL,NULL,?)').run(reminderId, invoiceId, merchantId, message, sendAt.toISOString(), now());
  sendDueReminders(db);
  return reminderView(db.prepare('SELECT * FROM invoice_manual_reminders WHERE id=?').get(reminderId) as ReminderRow, String(invoice.customer_email));
}
export function cancelReminder(db: Db, merchantId: string, invoiceId: string, reminderId: string) {
  const invoice = invoiceRow(db, merchantId, invoiceId);
  const changed = db.prepare('UPDATE invoice_manual_reminders SET cancelled_at=? WHERE id=? AND invoice_id=? AND sent_at IS NULL AND cancelled_at IS NULL').run(now(), reminderId, invoiceId);
  if (!changed.changes) throw new Refusal('reminder_not_cancellable');
  return reminderView(db.prepare('SELECT * FROM invoice_manual_reminders WHERE id=?').get(reminderId) as ReminderRow, String(invoice.customer_email));
}
export function sendDueReminders(db: Db, at = new Date()) {
  const due = db.prepare('SELECT * FROM invoice_manual_reminders WHERE sent_at IS NULL AND cancelled_at IS NULL AND send_at<=?').all(at.toISOString()) as Array<ReminderRow & { merchant_id: string }>;
  for (const r of due) {
    db.prepare('UPDATE invoice_manual_reminders SET sent_at=? WHERE id=? AND sent_at IS NULL').run(now(), r.id);
    enqueueWebhook(db, r.merchant_id, 'invoice.reminder', r.invoice_id, { message: r.message });
  }
}
