import { afterEach, describe, expect, it, vi } from 'vitest';
import { keccak256, type Address, type Hex } from 'viem';
import { FakeChain } from '../src/chain.js';
import { createApp } from '../src/app.js';
import { openDb, seedMerchant } from '../src/db.js';
import { IdentityError, type PrivyIdentity } from '../src/identity.js';
import { Indexer } from '../src/indexer.js';
import { deliverNotifications, mailSender } from '../src/notifications.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { enqueueWebhook } from '../src/webhooks.js';

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const MERCHANT = 'owner@shop.test', BUYER = 'buyer@example.test';
function fixture({ merchantEmail = true } = {}) {
  const db = openDb(), chain = new FakeChain(true), keys = seedMerchant(db, address(11));
  const identity = { async authenticate(token: string) {
    if (token !== 'payer' && token !== 'other') throw new IdentityError('invalid_identity_token', 401);
    return token === 'payer'
      ? { userId: 'person-1', sessionId: 's', expiresAt: Math.floor(Date.now() / 1000) + 300, email: BUYER, wallet: { address: address(22), id: null } }
      : { userId: 'person-2', sessionId: 's', expiresAt: Math.floor(Date.now() / 1000) + 300, email: 'other@example.test', wallet: { address: address(33), id: null } };
  }, async merchantFor() { throw new IdentityError('merchant_not_registered', 403); } } as unknown as PrivyIdentity;
  const app = createApp({ db, chain, identity, relayer: new Relayer(chain, address(1), allowedTargets({ escrow: address(2), subscription: address(3) })) });
  let count = 0;
  const request = async (path: string, token: string, body?: unknown) => {
    const result = await app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', 'idempotency-key': `key-${++count}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json() as any };
  };
  const emit = async (name: string, args: Record<string, unknown>) => {
    chain.emit({ id: `${name}-${++count}`, txHash: keccak256(`0x${count.toString(16).padStart(4, '0')}` as Hex), contract: 'escrow', name, args: { merchant: address(11), payer: address(22), ...args } });
    chain.block += 2n; await new Indexer(db, chain).poll();
  };
  const outbox = () => db.prepare('SELECT event_type,owner_kind,owner_id,recipient,subject,body,status FROM notification_outbox ORDER BY owner_kind DESC').all() as Array<Record<string, string>>;
  const setup = async () => { if (merchantEmail) expect((await request('/v1/notifications/preferences', keys.secretKey, { email: MERCHANT })).status).toBe(200); };
  const product = async () => (await request('/v1/commerce/products', keys.secretKey, { name: 'Widget', description: '', status: 'active', prices: [{ currency: 'USDT', amountMinor: '4000000' }], checkoutFields: [{ key: 'secret_note', label: 'Note', type: 'text' }] })).body;
  const buy = async () => {
    const item = await product();
    return (await request('/v1/commerce/checkout-sessions', 'payer', { productId: item.id, rail: 'whitechain', metadata: { secret_note: 'private answer' } })).body.order;
  };
  return { db, chain, keys, request, emit, outbox, setup, buy };
}
const sent = () => vi.fn(async () => 'sent' as const);
afterEach(() => vi.restoreAllMocks());

describe('notification hook', () => {
  it('queues exactly one merchant and one customer email for a paid product order, with no duplicate from the capture', async () => {
    const f = fixture(); await f.setup();
    const order = await f.buy();
    await f.emit('Charged', { id: order.paymentId, amount: 4_000_000n });
    expect(f.db.prepare("SELECT type FROM webhook_events WHERE type IN ('payment.captured','order.paid')").all()).toHaveLength(2);
    const rows = f.outbox();
    expect(rows.map(row => [row.event_type, row.owner_kind, row.recipient])).toEqual([['order.paid', 'merchant', MERCHANT], ['order.paid', 'customer', BUYER]]);
    expect(rows[1]).toMatchObject({ owner_id: 'person-1', subject: 'Receipt from the merchant: 4.00 USDT' });
    expect(rows[1].body).toContain('https://explorer.testnet.whitechain.io/tx/0x');
    expect(rows[1].body.split('\n').length).toBeLessThanOrEqual(5);
    for (const row of rows) expect(row.body).not.toContain('private answer');
    f.db.close();
  });
  it('sends paid mail from payment.captured for a link payment, without inventing order.paid', async () => {
    const f = fixture(); await f.setup();
    const link = (await f.request('/v1/payment-links', f.keys.secretKey, { kind: 'product', name: 'Audit', amount: '3' })).body;
    const payment = (await f.request(`/v1/commerce/me/links/${link.id}/payments`, 'payer', {})).body;
    await f.emit('Charged', { id: payment.paymentId, amount: 3_000_000n });
    expect(f.db.prepare("SELECT 1 FROM webhook_events WHERE type='order.paid'").all()).toHaveLength(0);
    expect(f.outbox().map(row => [row.event_type, row.owner_kind, row.recipient, row.subject])).toEqual([
      ['payment.captured', 'merchant', MERCHANT, 'Payment received: 3.00 USDT'],
      ['payment.captured', 'customer', BUYER, 'Receipt from the merchant: 3.00 USDT'],
    ]);
    f.db.close();
  });
  it('sends a guest receipt for a standalone payment and skips an address that is not an email', async () => {
    const f = fixture(); await f.setup();
    const guest = (await f.request('/v1/payments', f.keys.secretKey, { amount: '2', email: 'Guest@Example.test' })).body;
    await f.emit('Charged', { id: guest.id, amount: 2_000_000n, payer: address(44) });
    expect(f.outbox().find(row => row.owner_kind === 'customer')).toMatchObject({ owner_id: 'email:guest@example.test', recipient: 'guest@example.test', event_type: 'payment.captured' });
    f.db.exec('DELETE FROM notification_outbox');
    const bad = (await f.request('/v1/payments', f.keys.secretKey, { amount: '2', email: 'x@y.z\nBcc: victim@example.test' })).body;
    await f.emit('Charged', { id: bad.id, amount: 2_000_000n, payer: address(45) });
    expect(f.outbox().map(row => row.owner_kind)).toEqual(['merchant']);
    f.db.close();
  });
  it('tells the merchant about an invoice through invoice.paid alone and still gives the customer a receipt', async () => {
    const f = fixture(); await f.setup();
    const invoice = (await f.request('/v1/invoices', f.keys.secretKey, { customerEmail: BUYER, lines: [{ description: 'Service', unitAmount: '3', quantity: 1 }], status: 'sent' })).body;
    const payment = (await f.request('/v1/payments', f.keys.secretKey, { amount: '3', email: BUYER, metadata: { invoiceId: invoice.id } })).body;
    await f.emit('Charged', { id: payment.id, amount: 3_000_000n, payer: address(44) });
    expect(f.outbox().map(row => [row.event_type, row.owner_kind]).sort()).toEqual([['invoice.paid', 'merchant'], ['payment.captured', 'customer']]);
    f.db.close();
  });
  it('sends refunds to both sides once, with the refunded amount', async () => {
    const f = fixture(); await f.setup();
    const order = await f.buy();
    await f.emit('Charged', { id: order.paymentId, amount: 4_000_000n });
    f.db.exec('DELETE FROM notification_outbox');
    await f.emit('Refunded', { id: order.paymentId, amount: 1_500_000n });
    expect(f.outbox().map(row => [row.event_type, row.owner_kind, row.subject])).toEqual([
      ['payment.refunded', 'merchant', 'Refund confirmed: 1.50 USDT'],
      ['payment.refunded', 'customer', 'Refund from the merchant: 1.50 USDT'],
    ]);
    f.db.close();
  });
  it('covers subscription defaults for each side', async () => {
    const f = fixture(); await f.setup();
    f.db.prepare('INSERT INTO plans(id,merchant_id,name,amount_minor,period_seconds,created_at) VALUES (?,?,?,?,?,?)').run('plan', f.keys.merchantId, 'Pro', '5000000', 86400, new Date().toISOString());
    f.db.prepare('INSERT INTO subscriptions(id,merchant_id,plan_id,payer,status,next_charge_at,created_at) VALUES (?,?,?,?,?,?,?)').run('sub', f.keys.merchantId, 'plan', address(22), 'active', new Date().toISOString(), new Date().toISOString());
    f.db.prepare('INSERT INTO commerce_customers VALUES (?,?,?,?,?,?,?)').run('cus', f.keys.merchantId, 'person-1', address(22).toLowerCase(), BUYER, null, new Date().toISOString());
    const who = (type: string, context = {}) => { const id = enqueueWebhook(f.db, f.keys.merchantId, type, 'sub', context); return (f.db.prepare('SELECT owner_kind FROM notification_outbox WHERE event_id=? ORDER BY owner_kind DESC').all(id) as Array<{ owner_kind: string }>).map(row => row.owner_kind); };
    expect(who('subscription.renewed', { amountChargedMinor: '4000000', tx_hash: '0xabc' })).toEqual(['customer']);
    expect(who('subscription.trial_will_end', { trialEndsAt: '2026-12-01T00:00:00.000Z' })).toEqual(['customer']);
    expect(who('subscription.past_due', { next_retry_at: '2026-12-02T00:00:00.000Z' })).toEqual(['merchant', 'customer']);
    expect(who('subscription.cancelled', { cancelled_by: 'merchant' })).toEqual(['merchant']);
    expect(who('subscription.replaced')).toEqual([]);
    expect(who('webhook.test')).toEqual([]);
    const renewal = f.outbox().find(row => row.event_type === 'subscription.renewed')!;
    expect(renewal.subject).toContain('4.00 USDT');
    f.db.close();
  });
  it('sends nothing when prefs disable it, or to a merchant with no address', async () => {
    const f = fixture({ merchantEmail: false });
    const noAddress = await f.buy();
    await f.emit('Charged', { id: noAddress.paymentId, amount: 4_000_000n });
    expect(f.outbox().map(row => row.owner_kind)).toEqual(['customer']);
    f.db.exec('DELETE FROM notification_outbox');
    await f.request('/v1/notifications/preferences', f.keys.secretKey, { email: MERCHANT, events: ['invoice.paid'] });
    await f.request('/v1/commerce/me/notifications/preferences', 'payer', { events: [] });
    const next = await f.buy();
    await f.emit('Charged', { id: next.paymentId, amount: 4_000_000n });
    expect(f.outbox()).toEqual([]);
    f.db.close();
  });
  it('never rolls back the money event when notifications break', async () => {
    const f = fixture(); await f.setup();
    const order = await f.buy();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    f.db.exec('DROP TABLE notification_outbox');
    await f.emit('Charged', { id: order.paymentId, amount: 4_000_000n });
    expect(f.db.prepare('SELECT status,captured_minor FROM payments WHERE id=?').get(order.paymentId)).toEqual({ status: 'captured', captured_minor: '4000000' });
    expect(f.db.prepare("SELECT 1 FROM webhook_events WHERE type='order.paid'").all()).toHaveLength(1);
    expect(logged).toHaveBeenCalled();
    f.db.close();
  });
});

describe('notification preference routes', () => {
  it('defaults merchants to no address and saves a validated address and events', async () => {
    const f = fixture();
    const first = (await f.request('/v1/notifications/preferences', f.keys.secretKey)).body;
    expect(first).toMatchObject({ email: null });
    expect(first.events).not.toContain('gas_tank.low_runway');
    expect((await f.request('/v1/notifications/preferences', f.keys.secretKey, { email: 'Owner@Shop.test', events: ['order.paid'] })).body).toMatchObject({ email: 'owner@shop.test', events: ['order.paid'] });
    for (const body of [{ email: 'nope' }, { email: 'a@b.c\nBcc: x@y.z' }, { events: ['payment.captured'] }, { events: 'order.paid' }, { telegram_chat_id: '1' }, []]) {
      const refused = await f.request('/v1/notifications/preferences', f.keys.secretKey, body);
      expect(refused.status).toBe(422);
      expect(refused.body.error.code).toBe('invalid_notification_preferences');
    }
    expect((await f.request('/v1/notifications/preferences', f.keys.secretKey, { email: null })).body.email).toBeNull();
    f.db.close();
  });
  it('keeps merchant routes from publishable keys and anonymous callers', async () => {
    const f = fixture();
    expect((await f.request('/v1/notifications/preferences', f.keys.publishableKey)).status).toBe(403);
    expect((await f.request('/v1/notifications/preferences', f.keys.publishableKey, { email: MERCHANT })).status).toBe(403);
    expect((await f.request('/v1/notifications/preferences', '')).status).toBe(401);
    f.db.close();
  });
  it('scopes customer prefs to the session and never lets them set an address or merchant event', async () => {
    const f = fixture();
    expect((await f.request('/v1/commerce/me/notifications/preferences', '')).status).toBe(401);
    expect((await f.request('/v1/commerce/me/notifications/preferences', 'payer')).body).toMatchObject({ email: BUYER });
    expect((await f.request('/v1/commerce/me/notifications/preferences', 'payer', { events: ['payment.refunded'] })).body.events).toEqual(['payment.refunded']);
    expect((await f.request('/v1/commerce/me/notifications/preferences', 'other')).body.events).toContain('order.paid');
    expect((await f.request('/v1/commerce/me/notifications/preferences', 'payer', { events: ['invoice.paid'] })).status).toBe(422);
    expect((await f.request('/v1/commerce/me/notifications/preferences', 'payer', { email: 'attacker@example.test' })).status).toBe(422);
    f.db.close();
  });
});

describe('notification delivery', () => {
  const queued = async () => { const f = fixture(); await f.setup(); const order = await f.buy(); await f.emit('Charged', { id: order.paymentId, amount: 4_000_000n }); return f; };
  it('delivers once and records the outcome', async () => {
    const f = await queued(), send = sent();
    expect(await deliverNotifications(f.db, send)).toBe(2);
    expect(await deliverNotifications(f.db, send, new Date(Date.now() + 86_400_000))).toBe(0);
    expect(send).toHaveBeenCalledTimes(2);
    expect(f.outbox().map(row => row.status)).toEqual(['sent', 'sent']);
    f.db.close();
  });
  it('retries with backoff up to eight attempts, then gives up', async () => {
    const f = await queued(); f.db.exec("DELETE FROM notification_outbox WHERE owner_kind='customer'");
    const send = vi.fn(async () => { throw new Error('connection refused'); });
    let at = new Date(Date.now() + 1000);
    await deliverNotifications(f.db, send, at);
    expect(f.db.prepare('SELECT status,attempt,last_error FROM notification_outbox').get()).toEqual({ status: 'pending', attempt: 1, last_error: 'connection refused' });
    expect(await deliverNotifications(f.db, send, at)).toBe(0);
    for (let i = 0; i < 7; i++) { at = new Date(at.getTime() + 3_600_000); await deliverNotifications(f.db, send, at); }
    expect(f.db.prepare('SELECT status,attempt FROM notification_outbox').get()).toEqual({ status: 'failed', attempt: 8 });
    expect(send).toHaveBeenCalledTimes(8);
    f.db.close();
  });
  it('stops at once on a permanent SMTP refusal', async () => {
    const f = await queued(); f.db.exec("DELETE FROM notification_outbox WHERE owner_kind='customer'");
    await deliverNotifications(f.db, async () => { throw Object.assign(new Error('mailbox unavailable'), { responseCode: 550 }); });
    expect(f.db.prepare('SELECT status,attempt FROM notification_outbox').get()).toEqual({ status: 'failed', attempt: 1 });
    f.db.close();
  });
  it('logs instead of sending when SMTP_HOST is unset, without the email body', async () => {
    const f = await queued(), info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await deliverNotifications(f.db, mailSender({}));
    expect(f.outbox().map(row => row.status)).toEqual(['logged', 'logged']);
    expect(String(info.mock.calls[0][0])).toContain('SMTP_HOST is unset');
    expect(String(info.mock.calls[0][0])).not.toContain('explorer');
    f.db.close();
  });
  it('uses implicit TLS on port 465 and sends a plain text email from MAIL_FROM', async () => {
    const sendMail = vi.fn(async () => ({})), createTransport = vi.fn(() => ({ sendMail }));
    const send = mailSender({ SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', SMTP_USER: 'u', SMTP_PASS: 'p', MAIL_FROM: 'Pact <noreply@example.test>' }, createTransport as never);
    expect(await send({ to: BUYER, subject: 'Hi', text: 'Body' })).toBe('sent');
    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ host: 'smtp.example.test', port: 465, secure: true, auth: { user: 'u', pass: 'p' } }));
    expect(sendMail).toHaveBeenCalledWith({ from: 'Pact <noreply@example.test>', to: BUYER, subject: 'Hi', text: 'Body' });
  });
});

