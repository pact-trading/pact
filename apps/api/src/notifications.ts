import type { Context, Hono } from 'hono';
import nodemailer from 'nodemailer';
import { amountString, id, now, type Db } from './db.js';
import { renewalDiscountAmount } from './discounts.js';
import { checkoutSettings } from './merchant-settings.js';
import { Refusal } from './types.js';

export type OwnerKind = 'merchant' | 'customer';
export const MERCHANT_EVENTS = ['order.paid', 'payment.refunded', 'subscription.past_due', 'subscription.cancelled', 'invoice.paid', 'gas_tank.low_runway'];
export const CUSTOMER_EVENTS = ['order.paid', 'payment.refunded', 'subscription.renewed', 'subscription.trial_will_end', 'subscription.past_due'];
export const eventsFor = (kind: OwnerKind) => kind === 'merchant' ? MERCHANT_EVENTS : CUSTOMER_EVENTS;
const EXPLORER = 'https://explorer.testnet.whitechain.io/tx/';
const MAX_ATTEMPTS = 8;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const validEmail = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 && EMAIL.test(value);

export function initNotifications(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notification_prefs(owner_kind TEXT NOT NULL CHECK(owner_kind IN ('merchant','customer')),owner_id TEXT NOT NULL,channel TEXT NOT NULL CHECK(channel IN ('email','telegram')),events TEXT NOT NULL,email TEXT,telegram_chat_id TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(owner_kind,owner_id,channel));
    CREATE TABLE IF NOT EXISTS notification_outbox(id TEXT PRIMARY KEY,event_id TEXT NOT NULL,event_type TEXT NOT NULL,owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,channel TEXT NOT NULL,recipient TEXT NOT NULL,subject TEXT NOT NULL,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','sent','logged','failed')),attempt INTEGER NOT NULL DEFAULT 0,next_at TEXT NOT NULL,last_error TEXT,sent_at TEXT,created_at TEXT NOT NULL,UNIQUE(event_id,owner_kind,owner_id,channel));
    CREATE INDEX IF NOT EXISTS notification_outbox_due ON notification_outbox(status,next_at);
    CREATE TABLE IF NOT EXISTS telegram_tokens(token_hash TEXT PRIMARY KEY,owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,expires_at TEXT NOT NULL,used_at TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS telegram_state(id INTEGER PRIMARY KEY CHECK(id=1),update_offset INTEGER NOT NULL);
  `);
}

type Prefs = { events: string[]; email: string | null };
function prefsFor(db: Db, kind: OwnerKind, ownerId: string): Prefs {
  const row = db.prepare("SELECT events,email FROM notification_prefs WHERE owner_kind=? AND owner_id=? AND channel='email'").get(kind, ownerId) as { events: string; email: string | null } | undefined;
  return row ? { events: JSON.parse(row.events) as string[], email: row.email } : { events: eventsFor(kind), email: null };
}
function telegramPrefs(db: Db, kind: OwnerKind, ownerId: string) {
  const row = db.prepare("SELECT events,telegram_chat_id FROM notification_prefs WHERE owner_kind=? AND owner_id=? AND channel='telegram'").get(kind, ownerId) as { events: string; telegram_chat_id: string | null } | undefined;
  return { events: row ? JSON.parse(row.events) as string[] : eventsFor(kind), chatId: row?.telegram_chat_id ?? null };
}
const telegramView = (db: Db, kind: OwnerKind, ownerId: string) => {
  const { events, chatId } = telegramPrefs(db, kind, ownerId);
  return { connected: chatId !== null, events };
};
/** Telegram events apply only to a connected chat: connecting creates the row. */
function saveTelegramEvents(db: Db, kind: OwnerKind, ownerId: string, value: unknown, enabled: boolean) {
  if (value === undefined) return;
  if (!enabled) throw new Refusal('invalid_notification_preferences', 'Telegram is not set up');
  db.prepare("UPDATE notification_prefs SET events=?,updated_at=? WHERE owner_kind=? AND owner_id=? AND channel='telegram'").run(JSON.stringify(parseEvents(kind, value, [])), now(), kind, ownerId);
}
function savePrefs(db: Db, kind: OwnerKind, ownerId: string, prefs: Prefs) {
  db.prepare(`INSERT INTO notification_prefs(owner_kind,owner_id,channel,events,email,updated_at) VALUES (?,?,'email',?,?,?)
    ON CONFLICT(owner_kind,owner_id,channel) DO UPDATE SET events=excluded.events,email=excluded.email,updated_at=excluded.updated_at`).run(kind, ownerId, JSON.stringify(prefs.events), prefs.email, now());
}
function parseEvents(kind: OwnerKind, value: unknown, current: string[]) {
  if (value === undefined) return current;
  if (!Array.isArray(value) || value.some(event => typeof event !== 'string' || !eventsFor(kind).includes(event))) throw new Refusal('invalid_notification_preferences', 'Unknown notification event');
  return [...new Set(value as string[])];
}
const body = async (c: Context) => {
  const value = await c.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Refusal('invalid_notification_preferences', 'Invalid request');
  return value;
};

/** Merchant routes, mounted behind the /v1 middleware, which refuses publishable keys. */
export function mountMerchantNotifications(app: Hono, db: Db, merchant: (c: Context) => string, telegram = false) {
  const view = (merchantId: string) => ({ ...prefsFor(db, 'merchant', merchantId), available: MERCHANT_EVENTS, ...(telegram ? { telegram: telegramView(db, 'merchant', merchantId) } : {}) });
  app.get('/v1/notifications/preferences', c => c.json(view(merchant(c))));
  app.post('/v1/notifications/preferences', async c => {
    const merchantId = merchant(c), input = await body(c), current = prefsFor(db, 'merchant', merchantId);
    if (Object.keys(input).some(key => !['email', 'events', 'telegramEvents'].includes(key))) throw new Refusal('invalid_notification_preferences', 'Unknown field');
    let email = current.email;
    if (input.email !== undefined) {
      if (input.email !== null && input.email !== '' && !validEmail(input.email)) throw new Refusal('invalid_notification_preferences', 'Enter a valid email address');
      email = input.email ? input.email.toLowerCase() : null;
    }
    saveTelegramEvents(db, 'merchant', merchantId, input.telegramEvents, telegram);
    savePrefs(db, 'merchant', merchantId, { events: parseEvents('merchant', input.events, current.events), email });
    return c.json(view(merchantId));
  });
}

/** Portal routes. The owner comes from the session and the address is the account's own verified email. */
export function mountCustomerNotifications(app: Hono, db: Db, customer: (c: Context) => Promise<{ userId: string; email: string | null }>, telegram = false) {
  const view = (user: { userId: string; email: string | null }) => ({ events: prefsFor(db, 'customer', user.userId).events, email: user.email, available: CUSTOMER_EVENTS, ...(telegram ? { telegram: telegramView(db, 'customer', user.userId) } : {}) });
  app.get('/me/notifications/preferences', async c => c.json(view(await customer(c))));
  app.post('/me/notifications/preferences', async c => {
    const user = await customer(c), input = await body(c);
    if (Object.keys(input).some(key => !['events', 'telegramEvents'].includes(key))) throw new Refusal('invalid_notification_preferences', 'Unknown field');
    saveTelegramEvents(db, 'customer', user.userId, input.telegramEvents, telegram);
    savePrefs(db, 'customer', user.userId, { events: parseEvents('customer', input.events, prefsFor(db, 'customer', user.userId).events), email: null });
    return c.json(view(user));
  });
}

const clean = (value: unknown) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
const money = (minor: unknown) => `${amountString(String(minor)).replace(/(\.\d{2}\d*?)0+$/, '$1')} USDT`;
const receiptLink = (tx: unknown) => typeof tx === 'string' && tx ? [`Transaction: ${EXPLORER}${tx}`] : [];
const day = (iso: unknown) => typeof iso === 'string' && iso ? `${iso.slice(0, 10)} (UTC)` : 'soon';
type Mail = { subject: string; lines: string[] };
type Recipient = { ownerId: string; email: string | null };
type Planned = { merchant?: Mail; customer?: Mail; recipient?: Recipient | null };

/** Email if the owner has an address, Telegram if they connected a chat. Each channel has its own prefs. */
function queueAll(db: Db, eventId: string, type: string, kind: OwnerKind, ownerId: string, email: string | null | undefined, mail: Mail) {
  if (email) queue(db, eventId, type, kind, ownerId, email, mail);
  const { chatId } = telegramPrefs(db, kind, ownerId);
  if (chatId) queue(db, eventId, type, kind, ownerId, chatId, mail, 'telegram');
}

function queue(db: Db, eventId: string, type: string, kind: OwnerKind, ownerId: string, to: string, mail: Mail, channel: 'email' | 'telegram' = 'email') {
  // Prefs name the outcome: a capture with no order is the same "paid" notification as order.paid.
  const key = type === 'payment.captured' ? 'order.paid' : type;
  if (!(channel === 'email' ? prefsFor(db, kind, ownerId) : telegramPrefs(db, kind, ownerId)).events.includes(key)) return;
  db.prepare(`INSERT OR IGNORE INTO notification_outbox(id,event_id,event_type,owner_kind,owner_id,channel,recipient,subject,body,next_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id('ntf'), eventId, type, kind, ownerId, channel, to, clean(mail.subject), mail.lines.map(line => line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ')).join('\n'), now(), now());
}

/** The customer behind a payer wallet, or the email given with the payment. A guest has no account to hold prefs. */
function customerFor(db: Db, merchantId: string, wallet: string | null | undefined, fallback?: string | null): Recipient | null {
  const row = wallet ? db.prepare('SELECT subject_id,email FROM commerce_customers WHERE merchant_id=? AND lower(wallet)=lower(?) ORDER BY created_at LIMIT 1').get(merchantId, wallet) as { subject_id: string; email: string | null } | undefined : undefined;
  const given = validEmail(fallback) ? fallback.toLowerCase() : null;
  if (row) return { ownerId: row.subject_id, email: validEmail(row.email) ? row.email : given };
  return given ? { ownerId: `email:${given}`, email: given } : null;
}

function plan(db: Db, merchantId: string, type: string, objectId: string, context: Record<string, unknown>): Planned | null {
  const brand = checkoutSettings(db, merchantId).brandName || 'the merchant';
  const tx = context.tx_hash;
  const paid = (amount: unknown, what: unknown, recipient: Recipient | null, opts: { merchant?: boolean } = {}): Planned => ({
    recipient,
    ...(opts.merchant === false ? {} : { merchant: { subject: `Payment received: ${money(amount)}`, lines: [`You received ${money(amount)} for ${clean(what) || 'a payment'}.`, ...(recipient?.email ? [`Customer: ${recipient.email}`] : []), ...receiptLink(tx)] } }),
    customer: { subject: `Receipt from ${brand}: ${money(amount)}`, lines: [`You paid ${money(amount)} to ${brand} for ${clean(what) || 'your order'}.`, 'Keep this email as your receipt.', ...receiptLink(tx)] },
  });
  if (type === 'order.paid') {
    const order = db.prepare('SELECT o.amount_minor,o.product_name,c.subject_id,c.email FROM commerce_orders o JOIN commerce_customers c ON c.id=o.customer_id WHERE o.id=? AND o.merchant_id=?').get(objectId, merchantId) as { amount_minor: string; product_name: string; subject_id: string; email: string | null } | undefined;
    return order ? paid(order.amount_minor, order.product_name, { ownerId: order.subject_id, email: validEmail(order.email) ? order.email : null }) : null;
  }
  if (type === 'payment.captured' || type === 'payment.refunded') {
    const p = db.prepare('SELECT amount_minor,captured_minor,description,customer,payer,metadata FROM payments WHERE id=? AND merchant_id=?').get(objectId, merchantId) as { amount_minor: string; captured_minor: string; description: string | null; customer: string | null; payer: string | null; metadata: string | null } | undefined;
    if (!p) return null;
    const recipient = customerFor(db, merchantId, p.payer, p.customer);
    if (type === 'payment.refunded') {
      const amount = money(context.amount_minor ?? p.captured_minor), what = clean(p.description) || 'a payment';
      return { recipient,
        merchant: { subject: `Refund confirmed: ${amount}`, lines: [`A refund of ${amount} for ${what} confirmed onchain.`, ...(recipient?.email ? [`Customer: ${recipient.email}`] : []), ...receiptLink(tx)] },
        customer: { subject: `Refund from ${brand}: ${amount}`, lines: [`${brand} refunded ${amount} for ${what}.`, 'The USDT is back in your account.', ...receiptLink(tx)] } };
    }
    // A product order reports this same money through order.paid.
    if (db.prepare('SELECT 1 FROM commerce_orders WHERE payment_id=?').get(objectId)) return null;
    // An invoice payment tells the merchant through invoice.paid; the customer still gets a receipt.
    const invoice = !!(JSON.parse(p.metadata ?? '{}') as { invoiceId?: string }).invoiceId;
    return paid(context.amount_minor ?? p.amount_minor, p.description, recipient, { merchant: !invoice });
  }
  if (type === 'invoice.paid') {
    const invoice = db.prepare('SELECT amount_minor,customer_email FROM invoices WHERE id=? AND merchant_id=?').get(objectId, merchantId) as { amount_minor: string; customer_email: string } | undefined;
    return invoice ? { merchant: { subject: `Invoice paid: ${money(invoice.amount_minor)}`, lines: [`${clean(invoice.customer_email)} paid invoice ${clean(objectId)} in full (${money(invoice.amount_minor)}).`, ...receiptLink(tx)] } } : null;
  }
  if (type.startsWith('subscription.')) {
    const s = db.prepare('SELECT s.payer,s.trial_ends_at,p.name,p.amount_minor FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.id=? AND s.merchant_id=?').get(objectId, merchantId) as { payer: string | null; trial_ends_at: string | null; name: string; amount_minor: string } | undefined;
    if (!s) return null;
    const recipient = customerFor(db, merchantId, s.payer), name = clean(s.name);
    if (type === 'subscription.renewed') {
      const amount = money(context.amountChargedMinor ?? s.amount_minor);
      return { recipient, customer: { subject: `${brand}: ${name} renewed for ${amount}`, lines: [`Your ${name} subscription with ${brand} renewed for ${amount}.`, ...receiptLink(tx)] } };
    }
    if (type === 'subscription.trial_will_end') {
      const next = money(renewalDiscountAmount(db, objectId, 1));
      return { recipient, customer: { subject: `Your ${name} trial ends soon`, lines: [`Your free trial of ${name} with ${brand} ends on ${day(context.trialEndsAt ?? s.trial_ends_at)}.`, `You will then be charged ${next}, unless you cancel first in your account.`] } };
    }
    if (type === 'subscription.past_due') {
      const retry = context.next_retry_at ? `We will try again on ${day(context.next_retry_at)}.` : 'We will not try again.';
      return { recipient,
        merchant: { subject: `Renewal failed: ${name}`, lines: [`A renewal of ${name} failed because the customer did not have enough USDT.`, ...(recipient?.email ? [`Customer: ${recipient.email}`] : []), retry] },
        customer: { subject: `Your ${name} renewal failed`, lines: [`We could not renew your ${name} subscription with ${brand} because your account did not have enough USDT.`, `Add funds to keep it active. ${retry}`] } };
    }
    if (type === 'subscription.cancelled') {
      const by = context.cancelled_by === 'merchant' ? 'You cancelled' : 'The customer cancelled';
      return { recipient, merchant: { subject: `Subscription cancelled: ${name}`, lines: [`${by} a subscription to ${name}. No further charges will be made.`, ...(recipient?.email ? [`Customer: ${recipient.email}`] : [])] } };
    }
  }
  return null;
}

/**
 * Called from enqueueWebhook, often inside the indexer's money transaction. It only writes outbox rows,
 * in a nested savepoint: a problem here is logged and can never roll back the payment or the webhook.
 */
export function enqueueNotifications(db: Db, eventId: string, merchantId: string, type: string, objectId: string, context: Record<string, unknown>) {
  try {
    db.transaction(() => {
      const planned = plan(db, merchantId, type, objectId, context);
      if (!planned) return;
      if (planned.merchant) queueAll(db, eventId, type, 'merchant', merchantId, prefsFor(db, 'merchant', merchantId).email, planned.merchant);
      if (planned.customer && planned.recipient) queueAll(db, eventId, type, 'customer', planned.recipient.ownerId, planned.recipient.email, planned.customer);
    })();
  } catch (error) {
    console.error(`Notifications skipped for event ${eventId}:`, error instanceof Error ? error.message : 'unknown error');
  }
}

/** For alerts that are not webhook events. The same key on the same day queues one email. */
export function queueMerchantAlert(db: Db, key: string, merchantId: string, type: string, mail: Mail) {
  queueAll(db, key, type, 'merchant', merchantId, prefsFor(db, 'merchant', merchantId).email, mail);
}

export const retryAt = (at: Date, attempt: number) => new Date(at.getTime() + Math.min(3_600_000, 1000 * 2 ** (attempt - 1))).toISOString();

export type MailMessage = { to: string; subject: string; text: string };
/** Resolves to how the message left: really sent, or only logged because SMTP is not configured. */
export type MailSender = (message: MailMessage) => Promise<'sent' | 'logged'>;

export function mailSender(env: Record<string, string | undefined> = process.env, createTransport: typeof nodemailer.createTransport = nodemailer.createTransport): MailSender {
  if (!env.SMTP_HOST) return async message => {
    console.info(`Email not sent, SMTP_HOST is unset. To: ${message.to}. Subject: ${message.subject}`);
    return 'logged';
  };
  const port = Number(env.SMTP_PORT || 465);
  const transport = createTransport({ host: env.SMTP_HOST, port, secure: port === 465, ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } } : {}), connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 });
  const from = env.MAIL_FROM || 'Pact <noreply@pactagent.app>';
  return async message => { await transport.sendMail({ from, to: message.to, subject: message.subject, text: message.text }); return 'sent'; };
}

/** Same retry shape as webhooks: 8 attempts, doubling from a second up to an hour. A permanent SMTP refusal stops at once. */
export async function deliverNotifications(db: Db, send: MailSender, at = new Date()) {
  const rows = db.prepare("SELECT * FROM notification_outbox WHERE channel='email' AND status='pending' AND next_at<=? ORDER BY next_at LIMIT 20").all(at.toISOString()) as Array<{ id: string; recipient: string; subject: string; body: string; attempt: number }>;
  await Promise.all(rows.map(async row => {
    const attempt = row.attempt + 1;
    try {
      const outcome = await send({ to: row.recipient, subject: row.subject, text: row.body });
      db.prepare('UPDATE notification_outbox SET status=?,attempt=?,sent_at=?,last_error=NULL WHERE id=?').run(outcome, attempt, now(), row.id);
    } catch (error) {
      const permanent = Number((error as { responseCode?: number }).responseCode) >= 500;
      const message = (error instanceof Error ? error.message : 'Send failed').slice(0, 300);
      db.prepare('UPDATE notification_outbox SET status=?,attempt=?,last_error=?,next_at=? WHERE id=?').run(permanent || attempt >= MAX_ATTEMPTS ? 'failed' : 'pending', attempt, message, retryAt(at, attempt), row.id);
    }
  }));
  return rows.length;
}
