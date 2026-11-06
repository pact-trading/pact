import { availableTrialDays } from '../subscription-trials.js';
import { randomBytes } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { encodeFunctionData, keccak256, toHex, type Address, type Hex } from 'viem';
import type { ApprovalService } from '../approval.js';
import { subscriptionAbi } from '../chain.js';
import { id, now, type Db } from '../db.js';
import { IdentityError, type VerifiedIdentity } from '../identity.js';
import { checkoutSettings } from '../merchant-settings.js';
import type { Relayer } from '../relayer.js';
import { planRow, planSummary, subscriptionDetail, subscriptionRows } from '../subscriptions-live.js';
import { cancellationTypedData, intentTypedData, mandateTypedData } from '../typed-data.js';
import { assertSubscriptionAvailable } from '../write-reservations.js';
import type { ChainAdapter } from '../types.js';

export interface PayerSubscriptionServices {
  db: Db; chain: ChainAdapter; approval: ApprovalService; relayer: Relayer; router: Address; subscription: Address;
  register(body: Record<string, unknown>, auth: { merchantId: string; address: Address; kind: 'secret' }, customerSubjectId?: string): Promise<{ id: string; chainId: Hex; status: string; txHash: Hex }>;
  cancel(row: Record<string, string>, body: Record<string, unknown>, auth: { merchantId: string; address: Address }): Promise<unknown>;
  replace(oldId: string, body: Record<string, unknown>, auth: { merchantId: string; address: Address }): Promise<unknown>;
}
/** How many periods the one-time USDT approval covers, so renewals need no further signature. */
const APPROVED_PERIODS = 12;
const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
const bad = (code: string, status: 400 | 403 | 404 | 409 = 400): never => { throw new IdentityError(code, status); };

/**
 * The customer side of subscriptions. The payer signs messages only: a one-time USDT permit for the
 * SubscriptionManager, the mandate (capped per period, in the contract), and a cancellation. Pact's
 * relayer submits each one and pays the gas: neither the customer nor the merchant pays for it. Each
 * renewal pays the merchant less Pact's fee.
 */
export function mountPayerSubscriptions(app: Hono, s: PayerSubscriptionServices, payer: (c: Context) => Promise<VerifiedIdentity>) {
  const { db } = s;
  const merchantOf = (merchantId: string) => db.prepare('SELECT id,address FROM merchants WHERE id=?').get(merchantId) as { id: string; address: Address };
  const activePlan = (planId: string) => {
    const plan = planRow(db, planId);
    if (!plan) return bad('plan_not_found', 404);
    if (plan.status === 'archived') return bad('plan_archived', 409);
    return plan;
  };
  const approvalTarget = (plan: NonNullable<ReturnType<typeof planRow>>, user: VerifiedIdentity, key: string, carryingTrial = false) => ({
    key, merchant: plan.merchant_id, payer: user.wallet.address, spender: s.subscription,
    amount: BigInt(plan.amount_minor) * BigInt(Math.min(plan.max_periods ?? APPROVED_PERIODS, APPROVED_PERIODS)),
    minimumBalance: carryingTrial || availableTrialDays(db, plan.id, plan.merchant_id, user.wallet.address, plan.trial_days, user.userId) > 0 ? 0n : BigInt(plan.amount_minor),
  });
  const validKey = (key: unknown) => typeof key === 'string' && /^subapr_[0-9a-f]{24}$/.test(key) ? key : bad('invalid_approval_key');
  const body = async (c: Context) => { try { const b = await c.req.json(); if (b && typeof b === 'object' && !Array.isArray(b)) return b as Record<string, unknown>; } catch { /* fallthrough */ } return bad('invalid_json'); };

  // Public: the hosted subscribe page.
  app.get('/plans/:id', c => {
    const plan = planRow(db, c.req.param('id'));
    if (!plan) return bad('plan_not_found', 404);
    const { activeSubscribers: _a, monthlyRecurringMinor: _m, ...offer } = planSummary(db, plan);
    return c.json({ plan: offer, brand: checkoutSettings(db, plan.merchant_id) });
  });
  app.get('/plans/:id/trial-eligibility', async c => {
    const user = await payer(c), plan = activePlan(c.req.param('id'));
    return c.json({ trialDays: availableTrialDays(db, plan.id, plan.merchant_id, user.wallet.address, plan.trial_days, user.userId) });
  });

  // The mandate to sign and, when the allowance is short, the approval that comes first.
  app.post('/plans/:id/subscription-intent', async c => {
    const user = await payer(c), b = await body(c), plan = activePlan(c.req.param('id'));
    const key = b.approvalKey === undefined ? `subapr_${randomBytes(12).toString('hex')}` : validKey(b.approvalKey);
    const approval = await s.approval.getFor(approvalTarget(plan, user, key));
    const merchant = merchantOf(plan.merchant_id);
    const periods = Math.min(plan.max_periods ?? APPROVED_PERIODS, APPROVED_PERIODS);
    const period = BigInt(plan.period_seconds);
    const mandate = {
      payer: user.wallet.address, merchant: merchant.address, planId: keccak256(toHex(plan.id)), amountCap: BigInt(plan.amount_minor),
      periodSeconds: period, maxPeriods: periods, endTime: BigInt(Math.floor(Date.now() / 1000)) + BigInt(plan.trial_days ?? 0) * 86_400n + period * BigInt(periods + 1) + 86_400n,
      nonce: await s.chain.mandateNonce(user.wallet.address),
    };
    return c.json(json({ approvalKey: key, approval, mandate, typedData: mandateTypedData(mandate, s.subscription) }));
  });
  app.get('/plans/:id/approval/:key', async c => {
    const user = await payer(c), plan = activePlan(c.req.param('id'));
    return c.json(await s.approval.getFor(approvalTarget(plan, user, validKey(c.req.param('key')))));
  });
  app.post('/plans/:id/approval', async c => {
    const user = await payer(c), b = await body(c), plan = activePlan(c.req.param('id'));
    const { approvalKey, ...signed } = b;
    return c.json(await s.approval.submitFor(approvalTarget(plan, user, validKey(approvalKey)), signed));
  });
  app.post('/plans/:id/subscribe', async c => {
    const user = await payer(c), b = await body(c), plan = activePlan(c.req.param('id'));
    const mandate = b.mandate as Record<string, unknown> | undefined;
    if (!mandate || String(mandate.payer).toLowerCase() !== user.wallet.address.toLowerCase()) return bad('payer_mismatch', 403);
    const merchant = merchantOf(plan.merchant_id);
    // The subscriber is this merchant's customer, like a buyer at checkout.
    const existing = db.prepare('SELECT id FROM commerce_customers WHERE merchant_id=? AND subject_id=?').get(plan.merchant_id, user.userId);
    if (!existing) db.prepare('INSERT INTO commerce_customers VALUES (?,?,?,?,?,?,?)').run(id('cus'), plan.merchant_id, user.userId, user.wallet.address.toLowerCase(), user.email, null, now());
    const created = await s.register({ planId: plan.id, mandate, signature: b.signature, discountCode: b.discountCode }, { merchantId: merchant.id, address: merchant.address, kind: 'secret' }, user.userId);
    return c.json(created, 201);
  });

  // The payer's own subscriptions, across every merchant they subscribed to.
  const own = (c: Context, user: VerifiedIdentity) => {
    const row = subscriptionRows(db, 'id=? AND lower(payer)=lower(?)', c.req.param('id'), user.wallet.address)[0];
    return row ?? bad('subscription_not_found', 404);
  };
  app.get('/me/subscriptions', async c => {
    const user = await payer(c);
    return c.json({ data: subscriptionRows(db, 'lower(payer)=lower(?)', user.wallet.address).map(r => subscriptionDetail(db, r)) });
  });
  // Active plans of the businesses this customer subscribes to: the choices for a plan change.
  app.get('/me/plans', async c => {
    const user = await payer(c);
    const merchants = (db.prepare('SELECT DISTINCT merchant_id FROM subscriptions WHERE lower(payer)=lower(?)').all(user.wallet.address) as Array<{ merchant_id: string }>).map(r => r.merchant_id);
    const plans = merchants.flatMap(m => db.prepare("SELECT * FROM plans WHERE merchant_id=? AND status!='archived' ORDER BY created_at").all(m) as Array<NonNullable<ReturnType<typeof planRow>>>);
    return c.json({ data: plans.map(p => planSummary(db, p)) });
  });
  // Plans the customer can join: the active plans of businesses they already buy from, subscribe to
  // or are invoiced by. Not a directory of every merchant, and without the merchant's own figures.
  app.get('/me/available-plans', async c => {
    const user = await payer(c);
    const plans = db.prepare(`SELECT p.* FROM plans p LEFT JOIN merchant_settings ms ON ms.merchant_id=p.merchant_id
      WHERE p.status!='archived' AND p.merchant_id IN (
        SELECT merchant_id FROM commerce_customers WHERE subject_id=? OR lower(wallet)=lower(?)
        UNION SELECT merchant_id FROM subscriptions WHERE lower(payer)=lower(?)
        UNION SELECT merchant_id FROM invoices WHERE lower(customer_email)=lower(?) AND status!='draft')
      ORDER BY lower(COALESCE(ms.brand_name,'')), p.merchant_id, p.created_at`)
      .all(user.userId, user.wallet.address, user.wallet.address, user.email ?? '') as Array<NonNullable<ReturnType<typeof planRow>>>;
    return c.json({ data: plans.map(p => {
      const { activeSubscribers: _a, monthlyRecurringMinor: _m, ...plan } = planSummary(db, p);
      const brand = checkoutSettings(db, p.merchant_id);
      // The trial this customer would actually get: none once they have used it.
      const trialDays = availableTrialDays(db, p.id, p.merchant_id, user.wallet.address, p.trial_days, user.userId);
      return { plan: { ...plan, trialDays }, merchant: { id: p.merchant_id, name: brand.brandName || 'This business', logoUrl: brand.logoUrl } };
    }) });
  });
  app.get('/me/subscriptions/:id', async c => { const user = await payer(c); return c.json(subscriptionDetail(db, own(c, user))); });
  // The cancellation to sign (EIP-712 `Cancel`), valid five minutes; Pact's relayer submits it.
  app.post('/me/subscriptions/:id/cancel-intent', async c => {
    const user = await payer(c), row = own(c, user);
    if (row.status === 'cancelled' || !row.chain_id) return bad('subscription_unavailable', 409);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
    return c.json(json({ deadline, typedData: cancellationTypedData(row.chain_id, deadline, s.subscription) }));
  });
  app.post('/me/subscriptions/:id/cancel', async c => {
    const user = await payer(c), row = own(c, user), b = await body(c);
    if (typeof b.signature !== 'string' || b.deadline === undefined) return bad('signed_cancellation_required');
    const merchant = merchantOf(row.merchant_id);
    return c.json(await s.cancel(row as unknown as Record<string, string>, { deadline: b.deadline, signature: b.signature }, { merchantId: merchant.id, address: merchant.address }));
  });

  // Plan change: a new mandate, then a payer-signed Router intent that swaps the old one for it.
  const changeTarget = (c: Context, user: VerifiedIdentity, planId: unknown) => {
    const row = own(c, user);
    if (!['trialing', 'active', 'past_due', 'paused'].includes(row.status) || !row.chain_id) return bad('subscription_unavailable', 409);
    const plan = activePlan(String(planId));
    if (plan.merchant_id !== row.merchant_id || plan.id === row.plan_id) return bad('invalid_plan');
    return { row, plan };
  };
  const changeApproval = (row: ReturnType<typeof changeTarget>['row'], plan: ReturnType<typeof changeTarget>['plan'], user: VerifiedIdentity, key: string) =>
    approvalTarget(plan, user, key, row.status === 'trialing' && !!row.trial_ends_at && Date.parse(row.trial_ends_at) > Date.now());
  app.get('/me/subscriptions/:id/change-approval/:key', async c => {
    const user = await payer(c), { row, plan } = changeTarget(c, user, c.req.query('planId'));
    return c.json(await s.approval.getFor(changeApproval(row, plan, user, validKey(c.req.param('key')))));
  });
  app.post('/me/subscriptions/:id/change-approval', async c => {
    const user = await payer(c), b = await body(c), { row, plan } = changeTarget(c, user, b.planId);
    const { planId: _planId, approvalKey, ...signed } = b;
    return c.json(await s.approval.submitFor(changeApproval(row, plan, user, validKey(approvalKey)), signed));
  });
  app.post('/me/subscriptions/:id/change-intent', async c => {
    const user = await payer(c), b = await body(c), { row, plan } = changeTarget(c, user, b.planId);
    // A charge still confirming would make the swap fail after the customer signed: refuse before any signature.
    assertSubscriptionAvailable(db, row.id);
    const key = b.approvalKey === undefined ? `subapr_${randomBytes(12).toString('hex')}` : validKey(b.approvalKey);
    const approval = await s.approval.getFor(changeApproval(row, plan, user, key));
    const merchant = merchantOf(plan.merchant_id);
    const periods = Math.min(plan.max_periods ?? APPROVED_PERIODS, APPROVED_PERIODS);
    const period = BigInt(plan.period_seconds);
    const mandate = { payer: user.wallet.address, merchant: merchant.address, planId: keccak256(toHex(plan.id)), amountCap: BigInt(plan.amount_minor), periodSeconds: period, maxPeriods: periods,
      endTime: BigInt(Math.max(Math.floor(Date.now() / 1000), row.status === 'trialing' && row.trial_ends_at ? Math.ceil(Date.parse(row.trial_ends_at) / 1000) : 0)) + period * BigInt(periods + 1) + 86_400n, nonce: await s.chain.mandateNonce(user.wallet.address) };
    return c.json(json({ approvalKey: key, approval, mandate, typedData: mandateTypedData(mandate, s.subscription) }));
  });
  app.post('/me/subscriptions/:id/change-route', async c => {
    const user = await payer(c), b = await body(c), { row, plan } = changeTarget(c, user, b.planId);
    const raw = b.mandate as Record<string, string> | undefined;
    if (!raw || String(raw.payer).toLowerCase() !== user.wallet.address.toLowerCase() || typeof b.signature !== 'string') return bad('signed_mandate_required');
    const mandate = { payer: raw.payer as Address, merchant: raw.merchant as Address, planId: raw.planId as Hex, amountCap: BigInt(raw.amountCap), periodSeconds: BigInt(raw.periodSeconds), maxPeriods: Number(raw.maxPeriods), endTime: BigInt(raw.endTime), nonce: BigInt(raw.nonce) };
    const data = encodeFunctionData({ abi: subscriptionAbi, functionName: 'replace', args: [row.chain_id!, mandate, b.signature as Hex] });
    const quote = await s.relayer.quote();
    const merchant = merchantOf(row.merchant_id);
    const intent = { signer: user.wallet.address, merchant: merchant.address, target: s.subscription, dataHash: keccak256(data), amount: BigInt(plan.amount_minor), nonce: BigInt(`0x${randomBytes(32).toString('hex')}`), deadline: BigInt(Math.floor(Date.now() / 1000) + 300), maxGas: quote.targetGas };
    return c.json(json({ data, intent, typedData: intentTypedData(intent, s.router) }));
  });
  app.post('/me/subscriptions/:id/change', async c => {
    const user = await payer(c), b = await body(c), { row, plan } = changeTarget(c, user, b.planId);
    const intent = b.intent as Record<string, unknown> | undefined;
    if (!intent || String(intent.signer).toLowerCase() !== user.wallet.address.toLowerCase()) return bad('payer_mismatch', 403);
    const merchant = merchantOf(row.merchant_id);
    return c.json(await s.replace(row.id, { planId: plan.id, intent: b.intent, data: b.data, signature: b.signature }, { merchantId: merchant.id, address: merchant.address }));
  });
}
