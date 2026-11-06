import { Hono, type Context } from 'hono';
import { randomBytes } from 'node:crypto';
import { decodeFunctionData, encodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import type { Db } from '../db.js';
import { prepareRefund } from '../refund-preparation.js';
import { IdentityError, type Identity } from '../identity.js';
import { mountPayerSubscriptions, type PayerSubscriptionServices } from './payer-subscriptions.js';
import { mountHostedPayments } from './hosted-payments.js';
import { mountPayerAgents } from './payer-agents.js';
import { mountPayerLinksOrders } from './links-orders.js';
import { mountCustomerNotifications } from '../notifications.js';
import { mountCustomerTelegram, type TelegramConfig } from '../telegram.js';
import type { AgentService } from '../agents.js';
import type { ApprovalService } from '../approval.js';
import type { ChainAdapter } from '../types.js';
import type { Relayer } from '../relayer.js';
import { escrowAbi } from '../chain.js';
import type { FinancingService } from '../financing/service.js';
import { checkoutSettings, paymentRefundWindow, confirmedPaymentTerms } from '../merchant-settings.js';
import { intentTypedData } from '../typed-data.js';
import { merchantAuth, payerAuth } from './auth.js';
import { invalid, missing, product, saveProduct, listProducts } from './products.js';
import { createCheckout, ownedOrder, listOrders, orderView, sessionView, type OrderRow } from './orders.js';
import { customerDetail, listCustomers } from './customers.js';
type Services = { telegram?: TelegramConfig; db: Db; identity?: Identity; approval: ApprovalService; chain: ChainAdapter; relayer: Relayer; router: Address; escrow: Address; baseUrl: string; minimumAmount: bigint; submitIntent: (body: Record<string, unknown>, auth: { merchantId: string; address: Address }) => Promise<unknown>; subscriptions?: Omit<PayerSubscriptionServices, 'db' | 'chain' | 'approval' | 'relayer' | 'router'>; agents?: AgentService; financing?: FinancingService };
async function body(c: Context) {
  try { const v = await c.req.json(); if (!v || typeof v !== 'object' || Array.isArray(v)) return invalid('invalid_json'); return v as Record<string, unknown>; } catch { return invalid('invalid_json'); }
}
function page(c: Context) {
  const limit = c.req.query('limit') === undefined ? 25 : Number(c.req.query('limit'));
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (c.req.query('after')?.length ?? 0) > 200) invalid('invalid_pagination');
  return { limit, after: c.req.query('after') };
}
export function commerceRoutes(s: Services) {
  const { db, identity } = s, app = new Hono();
  app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  const merchant = (c: Context) => merchantAuth(c, db, identity);
  const payer = (c: Context) => payerAuth(c, identity);
  const receipt = (row: OrderRow) => {
    const payment = db.prepare('SELECT status,tx_hash,refund_deadline FROM payments WHERE id=?').get(row.payment_id) as { status: string; tx_hash: string | null; refund_deadline: string | null } | undefined;
    const refunds = db.prepare('SELECT id,amount_minor AS amountMinor,reason,status,tx_hash AS txHash,created_at AS createdAt FROM refunds WHERE payment_id=? ORDER BY created_at').all(row.payment_id);
    // Pact's fee, taken from the payment itself, as the confirmed charge recorded it. Pact pays the gas.
    const fee = db.prepare("SELECT fee_minor FROM accounting_entries WHERE merchant_id=? AND lower(object_id)=lower(?) AND kind='Payment' ORDER BY block_number LIMIT 1").get(row.merchant_id, row.payment_id) as { fee_minor: string } | undefined;
    const payerAddress = (db.prepare('SELECT payer FROM payments WHERE id=?').get(row.payment_id) as { payer: string | null } | undefined)?.payer ?? null;
    const revision = db.prepare('SELECT payload FROM commerce_product_revisions WHERE product_id=? AND revision=?').get(row.product_id, row.product_revision) as { payload: string };
    const events = db.prepare('SELECT type,source_id AS sourceId,created_at AS createdAt FROM commerce_order_events WHERE order_id=? ORDER BY created_at').all(row.id);
    return { order: orderView(db, row), product: JSON.parse(revision.payload), brand: checkoutSettings(db, row.merchant_id), payment: payment ? { financialStatus: payment.status, txHash: payment.tx_hash, refundDeadline: payment.refund_deadline, feeMinor: fee?.fee_minor ?? null, payer: payerAddress, ...confirmedPaymentTerms(db, row.payment_id!) } : null, refunds, events };
  };
  const ownedSession = async (c: Context) => {
    const user = await payer(c);
    const session = db.prepare('SELECT order_id FROM commerce_checkout_sessions WHERE id=? AND subject_id=?').get(c.req.param('id'), user.userId) as { order_id: string } | undefined;
    if (!session) return missing();
    const row = ownedOrder(db, session.order_id, { subjectId: user.userId, wallet: user.wallet.address });
    return { user, row };
  };
  app.get('/catalog/:id', c => {
    const item = product(db, c.req.param('id')); if (!item || item.status !== 'active') return missing();
    return c.json({ product: item, brand: checkoutSettings(db, item.merchantId), rails: item.prices.some(p => p.currency === 'USDT') ? ['whitechain'] : [] });
  });
  app.get('/products', async c => { const auth = await merchant(c), p = page(c); return c.json(listProducts(db, auth.merchantId, p.limit, p.after)); });
  app.post('/products', async c => { const auth = await merchant(c); return c.json(saveProduct(db, auth.merchantId, await body(c)), 201); });
  app.get('/products/:id', async c => { const auth = await merchant(c); return c.json(product(db, c.req.param('id'), auth.merchantId) ?? missing()); });
  app.patch('/products/:id', async c => { const auth = await merchant(c); return c.json(saveProduct(db, auth.merchantId, await body(c), c.req.param('id'))); });
  app.post('/checkout-sessions', async c => c.json(createCheckout(db, await payer(c), await body(c), c.req.header('idempotency-key'), s.baseUrl, s.minimumAmount), 201));
  app.get('/checkout-sessions/:id', async c => { const { row } = await ownedSession(c); return c.json({ ...sessionView(db, c.req.param('id'), s.baseUrl), ...receipt(row) }); });
  app.get('/checkout-sessions/:id/readiness', async c => { const { row, user } = await ownedSession(c); return c.json(await s.approval.get(row.payment_id!, row.merchant_id, user.wallet.address)); });
  app.post('/checkout-sessions/:id/approval', async c => {
    const { row, user } = await ownedSession(c), b = await body(c);
    if (b.payer !== undefined && String(b.payer).toLowerCase() !== user.wallet.address.toLowerCase()) invalid('payer_mismatch');
    return c.json(await s.approval.submit(row.payment_id!, row.merchant_id, { ...b, payer: user.wallet.address }));
  });
  app.get('/checkout-sessions/:id/intent', async c => {
    const { row, user } = await ownedSession(c);
    const readiness = await s.approval.get(row.payment_id!, row.merchant_id, user.wallet.address);
    if (readiness.status !== 'ready') throw new IdentityError('payment_not_ready', 409);
    const auth = db.prepare('SELECT address FROM merchants WHERE id=?').get(row.merchant_id) as { address: Address };
    const data = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [row.payment_id as Hex, auth.address, BigInt(row.amount_minor), BigInt(paymentRefundWindow(db, row.payment_id!)!)] });
    const quote = await s.relayer.quote();
    const intent = { signer: user.wallet.address, merchant: auth.address, target: s.escrow, dataHash: keccak256(data), amount: BigInt(row.amount_minor), nonce: BigInt(`0x${randomBytes(32).toString('hex')}`), deadline: BigInt(Math.floor(Date.now() / 1000) + 300), maxGas: quote.targetGas };
    return c.json(JSON.parse(JSON.stringify({ data, intent, typedData: intentTypedData(intent, s.router) }, (_, v) => typeof v === 'bigint' ? v.toString() : v)));
  });
  app.post('/checkout-sessions/:id/intent', async c => {
    const { row, user } = await ownedSession(c), b = await body(c);
    const i = b.intent as Record<string, unknown> | undefined;
    if (!i || String(i.signer).toLowerCase() !== user.wallet.address.toLowerCase() || String(i.target).toLowerCase() !== s.escrow.toLowerCase()) invalid('intent_mismatch');
    let call; try { call = decodeFunctionData({ abi: escrowAbi, data: b.data as Hex }); } catch { return invalid('intent_mismatch'); }
    if (call.functionName !== 'charge' || String(call.args?.[0]).toLowerCase() !== row.payment_id!.toLowerCase()) invalid('intent_mismatch');
    const auth = db.prepare('SELECT address FROM merchants WHERE id=?').get(row.merchant_id) as { address: Address };
    return c.json(await s.submitIntent(b, { merchantId: row.merchant_id, address: auth.address }));
  });
  app.get('/orders', async c => { const auth = await merchant(c), p = page(c); return c.json(listOrders(db, auth, p.limit, p.after, c.req.query('customerId'))); });
  app.get('/orders/:id', async c => c.json(receipt(ownedOrder(db, c.req.param('id'), await merchant(c)))));
  app.post('/orders/:id/refund-intent', async c => {
    const auth = await merchant(c), row = ownedOrder(db, c.req.param('id'), auth), b = await body(c);
    return c.json(await prepareRefund(db, s.relayer, s.router, s.escrow, row.payment_id!, auth, b));
  });
  app.get('/customers', async c => { const auth = await merchant(c), p = page(c); return c.json(listCustomers(db, auth.merchantId, p.limit, p.after)); });
  app.get('/customers/:id', async c => { const auth = await merchant(c); return c.json(customerDetail(db, auth.merchantId, c.req.param('id'))); });
  // The payer's own account: its address (shown only behind "Advanced details") and USDT balance.
  app.get('/me/account', async c => {
    const user = await payer(c);
    const balance = await s.chain.merchantBalance(user.wallet.address).catch(() => null);
    return c.json({ userId: user.userId, address: user.wallet.address, email: user.email, kind: user.kind ?? 'privy', balanceMinor: balance ? balance.balanceMinor.toString() : null });
  });
  mountHostedPayments(app as unknown as Hono, { db, approval: s.approval, relayer: s.relayer, router: s.router, escrow: s.escrow, baseUrl: s.baseUrl, submitIntent: s.submitIntent, financing: s.financing }, payer);
  mountPayerLinksOrders(app as unknown as Hono, db, payer);
  mountCustomerNotifications(app as unknown as Hono, db, payer, !!s.telegram);
  mountCustomerTelegram(app as unknown as Hono, db, s.telegram, payer);
  if (s.agents) mountPayerAgents(app as unknown as Hono, db, s.agents, payer);
  if (s.subscriptions) mountPayerSubscriptions(app as unknown as Hono, { db, chain: s.chain, approval: s.approval, relayer: s.relayer, router: s.router, ...s.subscriptions }, payer);
  app.get('/me/orders', async c => { const user = await payer(c), p = page(c); return c.json(listOrders(db, { subjectId: user.userId, wallet: user.wallet.address }, p.limit, p.after)); });
  app.get('/me/orders/:id', async c => { const user = await payer(c); return c.json(receipt(ownedOrder(db, c.req.param('id'), { subjectId: user.userId, wallet: user.wallet.address }))); });
  return app;
}
