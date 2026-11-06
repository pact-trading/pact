import 'server-only';
import type {
  DashboardSummary,
  ExportReport,
  FeeLedgerEntry,
  FeesDetail,
  FeeTermsStatus,
  MerchantSettings,
  MerchantSpender,
  WebhookDelivery,
} from '@pactagent/core/api-types';
import type { Product } from '@pactagent/core/commerce-types';
import type {
  AgentSession,
  CustomerSummary,
  DrainAttempt,
  DrainRun,
  InvoiceDetail,
  OnboardingStep,
  OrderListItem,
  PlanSummary,
  SecurityLayer,
  SubscriptionDetail,
  Viewer,
  ViewerRole,
} from '@pactagent/core/platform-types';
import { toMinor } from '@/lib/format';
import { requireViewer } from '../../viewer';
import { DataError, notFound } from '../errors';
import type {
  CheckoutState,
  DashboardOverview,
  DataSource,
  ExplorerTx,
  OrderDetail,
  SignRequest,
} from '../types';
import {
  agentCall,
  cancelSubscription,
  chargeSubscription,
  customer as customerRecord,
  dec6,
  FEE_TERMS,
  layerFor,
  MIN_AMOUNT_MINOR,
  payInvoice,
  payOrder,
  plan as planRecord,
  reasonDetail,
  refundableMinor,
  refundOrder,
  refusal,
  reminderSchedule,
  SECURITY_LAYERS,
  sponsor,
  subscribe,
  tick,
  USDT,
  webhook,
} from './engine';
import { checkMockAnswers, createMockCommerce, linkOrderProblem, planArchived, mockDiscount, redeemMockDiscount } from './commerce-extras';
import { CUSTOMER_NOTIFICATION_EVENTS, MERCHANT_NOTIFICATION_EVENTS } from '@/lib/notifications';
import { createMockFinancing, financingTransaction } from './financing';
import { DEMO } from './fixtures';
import { createMockLab, withScenario } from './lab';
import {
  hooks,
  DAY,
  dayKey,
  HOUR,
  iso,
  now,
  resetStore,
  sandboxed,
  store,
  type InvoiceRecord,
  type MockStore,
  type OrderRecord,
  type SubscriptionRecord,
} from './store';
import { MOCK_VIEWERS } from './viewers';
import { getAddress, keccak256, slice, stringToHex } from 'viem';
import type { CheckoutRecord } from './store';
import type { CheckoutMethodOption, PaymentMethodUsed } from '../types';
import {
  cardErrors,
  cardLabel,
  DECLINE_CARD,
  DECLINE_CARD_LABEL,
  digitsOnly,
} from '@/components/customer/checkout/card-rules';

const ROUTER = '0x014BC0e127D4660a3ef369a9d71a57e727a7D34f';
const SUBSCRIPTIONS = '0xAAB13cEfEb4291842439Bb958F54C11459e09573';
const USDT_ADDRESS = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7';
/** Synthetic escrow and FeeSchedule addresses the demo signs against (mock only). */
const ESCROW = '0x7f1a3c5e9b2d4068a1c3e5f7092b4d6e8a0c2e41';
const FEES = '0x4e8b2d6f0a1c3e5b7d9f1a3c5e7b9d0f2a4c6e81';

/** Every read first runs the keeper up to the demo clock. */
async function current(): Promise<MockStore> {
  const s = await store();
  tick(s);
  return s;
}

const merchantRoles: ViewerRole[] = ['merchant', 'accountant'];
const readMerchant = () => requireViewer(merchantRoles);
const writeMerchant = () => requireViewer(['merchant']);
const asCustomer = () => requireViewer(['customer']);
/** The demo has no bot, so Telegram stays hidden, as it does on an API with no bot set up. */
const telegramUnavailable = async (): Promise<never> => {
  throw new DataError('telegram_unavailable', 'Telegram is not set up.', 404);
};

// ------------------------------------------------------------- signatures

function typedData(domain: string, contract: string, primaryType: string, message: Record<string, string>) {
  return {
    domain: { name: domain, version: '1', chainId: 1874, verifyingContract: contract },
    primaryType,
    types: { [primaryType]: Object.keys(message).map(name => ({ name, type: 'string' })) },
    message,
  };
}

function prepare(
  s: MockStore,
  viewer: Viewer,
  kind: string,
  payload: Record<string, string>,
  view: Omit<SignRequest, 'token' | 'typedData'>,
  data: Record<string, unknown>,
): SignRequest {
  const token = s.ids.token();
  s.pending.set(token, { kind, role: viewer.role, subjectId: viewer.userId, payload, createdAt: Date.now() });
  return { token, ...view, typedData: data };
}

/** Consumes a prepared action. A second submit of the same token is refused like an onchain replay. */
function consume(s: MockStore, viewer: Viewer, kind: string, token: string, signature: string) {
  const pending = s.pending.get(token);
  if (!pending) throw new DataError('replay', 'This signed request was already used or has expired.', 409);
  s.pending.delete(token);
  if (pending.kind !== kind || pending.subjectId !== viewer.userId)
    throw new DataError('invalid_signature', 'The signature does not match this action.', 403);
  if (Date.now() - pending.createdAt > 10 * 60_000)
    throw new DataError('deadline', 'The signed request expired. Start again.', 409);
  if (!/^0x[0-9a-f]+$/i.test(signature))
    throw new DataError('invalid_signature', 'The signature is malformed.', 400);
  return pending.payload;
}

// ------------------------------------------------------------------ views

const brand = (s: MockStore) => ({
  brandName: s.merchant.settings.brandName,
  logoUrl: s.merchant.settings.logoUrl,
  brandColor: (s.merchant as { preferences?: { brandColor?: string } }).preferences?.brandColor ?? null,
});

function orderItem(s: MockStore, record: OrderRecord): OrderListItem {
  const c = s.customers.find(item => item.id === record.order.customerId);
  return { ...record.order, customerEmail: c?.email ?? null, customerName: c?.name ?? null };
}

function orderDetail(s: MockStore, record: OrderRecord): OrderDetail {
  const c = customerRecord(s, record.order.customerId);
  const paymentId = record.order.paymentId;
  return {
    order: { ...record.order },
    product: s.products.find(p => p.id === record.order.productId) ?? null,
    customer: { id: c.id, name: c.name, email: c.email, company: c.company },
    merchantName: s.merchant.name,
    payment:
      record.paidAt && paymentId
        ? {
            id: paymentId,
            txHash: record.txHash,
            feeMinor: record.feeMinor.toString(),
            payer: record.payerAddress,
            // Orders paid before methods were recorded were paid from the payer's Pact account.
            method: record.method ?? ACCOUNT_METHOD,
          }
        : null,
    refunds: [...record.refunds],
    refusals: s.refusals.filter(r => r.source === 'refund' && r.objectId === paymentId),
    activity: [...record.activity].sort((a, b) => b.at.localeCompare(a.at)),
    refundWindowEndsAt: record.paidAt
      ? iso(record.paidAt + s.merchant.settings.refundWindowSeconds * 1000)
      : null,
    refundableMinor: ['paid', 'partially_refunded'].includes(record.order.status)
      ? refundableMinor(record).toString()
      : '0',
  };
}

function invoiceDetail(s: MockStore, record: InvoiceRecord): InvoiceDetail {
  return {
    ...record.invoice,
    lines: record.invoice.lines.map(line => ({ ...line })),
    number: record.number,
    customerName: record.customerName,
    merchantName: s.merchant.name,
    acknowledgement: record.acknowledgement,
    reminders: record.reminders.map(r => ({ ...r })),
    activity: [...record.activity].sort((a, b) => b.at.localeCompare(a.at)),
  };
}

function subscriptionDetail(s: MockStore, sub: SubscriptionRecord): SubscriptionDetail {
  const p = planRecord(s, sub.planId);
  const c = customerRecord(s, sub.customerId);
  return {
    id: sub.id,
    chainId: sub.chainId,
    payer: c.address,
    planId: p.id,
    plan: p.name,
    amount: dec6(p.amountMinor),
    periodSeconds: p.periodSeconds,
    maxPeriods: p.maxPeriods,
    status: sub.status,
    nextChargeAt: iso(sub.nextChargeAt),
    createdAt: iso(sub.createdAt),
    customerId: c.id,
    customerName: c.name,
    customerEmail: c.email,
    merchantName: s.merchant.name,
    periodsCharged: sub.periodsCharged,
    retryCount: sub.retryCount,
    cancelledAt: sub.cancelledAt ? iso(sub.cancelledAt) : null,
    replacedBy: sub.replacedBy,
    mandate: {
      amountCap: dec6(p.amountMinor),
      periodSeconds: p.periodSeconds,
      maxPeriods: p.maxPeriods,
      signedAt: iso(sub.signedAt),
    },
    charges: sub.charges.map(charge => ({ ...charge })),
  };
}

function planSummary(s: MockStore, id: string): PlanSummary {
  const p = planRecord(s, id);
  const active = s.subscriptions.filter(
    sub => sub.planId === id && (sub.status === 'active' || sub.status === 'past_due'),
  );
  return {
    id: p.id,
    name: p.name,
    amount: dec6(p.amountMinor),
    periodSeconds: p.periodSeconds,
    maxPeriods: p.maxPeriods,
    description: p.description,
    activeSubscribers: active.length,
    monthlyRecurringMinor: (p.amountMinor * BigInt(active.length)).toString(),
  };
}

function agentView(s: MockStore, id: string): AgentSession {
  const record = s.agents.find(a => a.session.id === id);
  if (!record) throw notFound('Agent');
  const today = dayKey(now(s));
  return {
    ...record.session,
    allowedMerchants: [...record.session.allowedMerchants],
    spentTodayMinor: (record.spentByDay[today] ?? 0n).toString(),
    callsToday: record.callsByDay[today] ?? 0,
  };
}

// ------------------------------------------------------------------- fees

const rateView = (rate: (typeof FEE_TERMS)['checkout' | 'invoice']) => ({
  bps: rate.bps,
  percent: `${(rate.bps / 100).toFixed(2)}%`,
  minimumUsdt: dec6(rate.minFeeMinor),
  capUsdt: rate.maxFeeMinor === 0n ? null : dec6(rate.maxFeeMinor),
});
const termsView = () => ({ checkout: rateView(FEE_TERMS.checkout), invoice: rateView(FEE_TERMS.invoice) });

const PERMITS: Record<MerchantSpender, { label: string; address: string }> = {
  escrow: { label: 'Refunds: the escrow sends a refund from your wallet when you issue one', address: ESCROW },
  router: { label: 'Refund gas: the network fee for a refund you send, in USDT', address: ROUTER },
};

function feeTermsStatus(s: MockStore): FeeTermsStatus {
  const accepted = s.fees.acceptedVersion;
  return {
    acceptedVersion: accepted,
    latestVersion: FEE_TERMS.version,
    accepted: accepted ? termsView() : null,
    latest: termsView(),
    needsAcceptance: accepted === 0,
    newerTermsAvailable: accepted !== 0 && accepted < FEE_TERMS.version,
  };
}

const feesReady = (s: MockStore) => s.fees.acceptedVersion !== 0 && s.fees.permits.escrow && s.fees.permits.router;

/** Every fee Pact took, newest first: from payments, renewals and invoices, and refund network fees. */
function feeLedger(s: MockStore, limit: number): FeeLedgerEntry[] {
  const labels: Record<string, string> = {
    Payment: 'Payment',
    Subscription: 'Subscription renewal',
    Invoice: 'Invoice payment',
    'Agent payment': 'Agent payment',
    Fee: 'Refund network fee',
  };
  return s.accounting
    .filter(e => e.feeMinor !== 0n && !e.type.startsWith('Financing'))
    .sort((a, b) => b.at - a.at)
    .slice(0, limit)
    .map(e => {
      const gross = e.type === 'Fee' ? 0n : e.grossMinor;
      return {
        id: e.id,
        at: iso(e.at),
        kind: e.type,
        label: labels[e.type] ?? e.type,
        objectId: e.objectId,
        grossUsdt: dec6(gross),
        feeUsdt: dec6(e.feeMinor),
        netUsdt: dec6(gross - e.feeMinor),
        txHash: (e.txHash ?? '0x') as `0x${string}`,
      };
    });
}

function feesDetail(s: MockStore): FeesDetail {
  const since = now(s) - 30 * DAY;
  let gross = 0n;
  let fees = 0n;
  let payments = 0;
  for (const e of s.accounting) {
    if (e.at < since) continue;
    if (['Payment', 'Subscription', 'Invoice'].includes(e.type)) {
      gross += e.grossMinor;
      fees += e.feeMinor;
      payments += 1;
    } else if (e.type === 'Fee') fees += e.feeMinor;
  }
  return {
    terms: feeTermsStatus(s),
    permits: (Object.keys(PERMITS) as MerchantSpender[]).map(spender => ({
      spender,
      label: PERMITS[spender].label,
      address: PERMITS[spender].address as `0x${string}`,
      status: s.fees.permits[spender] ? 'ready' : 'needs_approval',
      reason: null,
    })),
    ready: feesReady(s),
    totals: {
      days: 30,
      grossUsdt: dec6(gross),
      feesUsdt: dec6(fees),
      netUsdt: dec6(gross - fees),
      payments,
      effectiveRateBps: gross > 0n ? Number((fees * 10_000n) / gross) : null,
    },
    ledger: feeLedger(s, 20),
  };
}

function onboarding(s: MockStore): OnboardingStep[] {
  const o = s.merchant.onboarding;
  return [
    { id: 'account', title: 'Create your account with a passkey', done: o.account },
    { id: 'brand', title: 'Add your business name and logo', done: o.brand },
    { id: 'fees', title: 'Sign the fee terms and refund permits', done: feesReady(s) },
    { id: 'integrate', title: 'Add checkout to your store', done: o.integrate },
    { id: 'test_payment', title: 'Take a test payment', done: o.test_payment },
  ];
}

function summary(s: MockStore): DashboardSummary {
  const at = now(s);
  const today = dayKey(at);
  // Financing rows (advance, reserve, repayments to holders, late fee, buy-back) are money moving
  // against an invoice already counted as a sale, so none of them belongs in sales totals.
  const isFinancing = (e: (typeof s.accounting)[number]) => e.type.startsWith('Financing');
  const income = s.accounting.filter(e => e.grossMinor > 0n && !isFinancing(e));
  const sum = (items: typeof s.accounting, pick: (e: (typeof s.accounting)[number]) => bigint) =>
    items.reduce((total, e) => total + pick(e), 0n);
  const todays = s.accounting.filter(e => dayKey(e.at) === today);
  const captured = sum(income, e => e.grossMinor);
  const refunded = -sum(
    s.accounting.filter(e => e.type === 'Refund'),
    e => e.grossMinor,
  );
  const fees = sum(s.accounting, e => e.feeMinor);
  const volume = Array.from({ length: 14 }, (_, i) => {
    const key = dayKey(at - (13 - i) * DAY);
    return {
      date: key,
      amount: dec6(
        sum(
          income.filter(e => dayKey(e.at) === key),
          e => e.grossMinor,
        ),
      ),
    };
  });
  return {
    generatedAt: iso(at),
    timeZone: 'UTC',
    accountingComplete: true,
    balance: {
      available: true,
      address: s.merchant.address,
      token: USDT_ADDRESS,
      amountUsdt: dec6(s.merchant.usdtMinor),
      blockNumber: String(11_930_519 + Math.floor((at - Date.UTC(2026, 10, 1)) / 1000)),
    },
    today: {
      capturedUsdt: dec6(
        sum(
          todays.filter(e => e.grossMinor > 0n && !isFinancing(e)),
          e => e.grossMinor,
        ),
      ),
      refundedUsdt: dec6(
        -sum(
          todays.filter(e => e.type === 'Refund'),
          e => e.grossMinor,
        ),
      ),
      feesUsdt: dec6(sum(todays, e => e.feeMinor)),
      payments: todays.filter(e => e.type === 'Payment' || e.type === 'Invoice').length,
      refunds: todays.filter(e => e.type === 'Refund').length,
      subscriptionCharges: todays.filter(e => e.type === 'Subscription').length,
    },
    metrics: {
      capturedUsdt: dec6(captured),
      refundedUsdt: dec6(refunded),
      netUsdt: dec6(captured - refunded - fees),
      feesUsdt: dec6(fees),
      totalPayments: s.orders.length,
      successfulPayments: s.orders.filter(o =>
        ['paid', 'partially_refunded', 'refunded'].includes(o.order.status),
      ).length,
      authorizedPayments: 0,
      activeSubscriptions: s.subscriptions.filter(sub => sub.status === 'active' || sub.status === 'past_due')
        .length,
      financedInvoices: ((s.financing as { positions?: Array<{ status: string }> }).positions ?? []).filter(
        p => ['funded', 'overdue', 'defaulted', 'repaid', 'bought_back'].includes(p.status),
      ).length,
    },
    volume,
    recentActivity: s.webhookEvents.slice(0, 10).map(e => ({
      id: e.id,
      type: e.type,
      objectId: e.object_id,
      createdAt: e.created_at,
      txHash: null,
      reason: null,
    })),
    feeTerms: {
      accepted: s.fees.acceptedVersion !== 0,
      acceptedVersion: s.fees.acceptedVersion,
      latestVersion: FEE_TERMS.version,
    },
  };
}

function activityFeed(s: MockStore): DashboardOverview['activity'] {
  const orderFor = (paymentId: string) =>
    s.orders.find(o => o.order.paymentId === paymentId || o.order.id === paymentId);
  const items: DashboardOverview['activity'] = [];
  for (const e of s.webhookEvents.slice(0, 60)) {
    if (items.length >= 8) break;
    const order = orderFor(e.object_id);
    const sub = s.subscriptions.find(x => x.id === e.object_id);
    const inv = s.invoices.find(x => x.invoice.id === e.object_id);
    const who = order
      ? customerRecord(s, order.order.customerId).name
      : sub
        ? customerRecord(s, sub.customerId).name
        : (inv?.customerName ?? '');
    const entry = (title: string, tone: DashboardOverview['activity'][number]['tone'], href: string | null) =>
      items.push({ id: e.id, at: e.created_at, title, detail: who, tone, href });
    if (e.type === 'payment.captured' && order)
      entry(`Payment for ${order.order.productName}`, 'success', `/dashboard/orders/${order.order.id}`);
    else if (e.type === 'payment.refunded' && order)
      entry(`Refund on ${order.order.productName}`, 'default', `/dashboard/orders/${order.order.id}`);
    else if (e.type === 'subscription.renewed' && sub)
      entry(`${planRecord(s, sub.planId).name} renewed`, 'success', `/dashboard/subscriptions/${sub.id}`);
    else if (e.type === 'subscription.refused' && sub)
      entry(
        `Renewal refused: ${sub.charges[0]?.reason?.replaceAll('_', ' ') ?? 'refused'}`,
        'warning',
        `/dashboard/subscriptions/${sub.id}`,
      );
    else if (e.type === 'subscription.past_due' && sub)
      entry(`${planRecord(s, sub.planId).name} is past due`, 'warning', `/dashboard/subscriptions/${sub.id}`);
    else if (e.type === 'subscription.cancelled' && sub)
      entry(`${planRecord(s, sub.planId).name} cancelled`, 'default', `/dashboard/subscriptions/${sub.id}`);
    else if (e.type === 'invoice.paid' && inv)
      entry(`Invoice ${inv.number} paid`, 'success', `/dashboard/invoices/${inv.invoice.id}`);
    else if (e.type === 'invoice.overdue' && inv)
      entry(`Invoice ${inv.number} is overdue`, 'danger', `/dashboard/invoices/${inv.invoice.id}`);
    else if (e.type === 'invoice.financed' && inv)
      entry(`Invoice ${inv.number} fully funded by investors`, 'success', `/dashboard/financing/${inv.invoice.id}`);
    else if (e.type === 'invoice.settled' && inv)
      entry(`Invoice ${inv.number} settled with its investors`, 'success', `/dashboard/financing/${inv.invoice.id}`);
    else if (e.type === 'intent.refused')
      items.push({
        id: e.id,
        at: e.created_at,
        title: 'Sponsored request refused',
        detail:
          s.refusals.find(r => r.objectId === e.object_id)?.detail ??
          'A limit stopped it before anything was sent.',
        tone: 'warning',
        href: '/dashboard/security',
      });
  }
  return items;
}

function exportReport(s: MockStore, range: { from?: string; to?: string }): ExportReport {
  const from = range.from ? new Date(`${range.from}T00:00:00Z`).getTime() : -Infinity;
  const to = range.to ? new Date(`${range.to}T23:59:59.999Z`).getTime() : Infinity;
  const entries = s.accounting.filter(e => e.at >= from && e.at <= to).sort((a, b) => a.at - b.at);
  // Payments show the price before the discount; refunds and fees stay as recorded.
  const discountOf = (e: (typeof entries)[number]) => {
    const order = e.grossMinor > 0n && e.orderId ? s.orders.find(o => o.order.id === e.orderId)?.order : undefined;
    return { amount: order?.amountDiscount ? BigInt(order.amountDiscount.replace('.', '')) : 0n, code: order?.discountCode ?? '' };
  };
  const rows = entries.map(e => {
    const net = e.grossMinor - e.feeMinor;
    const discount = discountOf(e);
    return {
      'Date (UTC)': iso(e.at).replace('T', ' ').slice(0, 19),
      Type: e.type,
      'Payment or Invoice ID': e.objectId,
      'Order ID': e.orderId ?? '',
      Customer: e.customer,
      'Gross USDT': dec6(e.grossMinor + discount.amount),
      'Discount USDT': dec6(discount.amount),
      'Discount Code': discount.code,
      'Fee USDT': dec6(e.feeMinor),
      'Net USDT': dec6(net),
      'Refund Of': e.refundOf ?? '',
      'Financing Status': '',
      'Transaction Hash': e.txHash ?? '',
      'Explorer Link': e.txHash ? `https://explorer.testnet.whitechain.io/tx/${e.txHash}` : '',
      'Token Balance Change USDT': dec6(net),
    };
  });
  const gross = entries.reduce((t, e) => t + e.grossMinor, 0n);
  const discounts = entries.reduce((t, e) => t + discountOf(e).amount, 0n);
  const fees = entries.reduce((t, e) => t + e.feeMinor, 0n);
  return {
    rows,
    totals: {
      grossUSDT: dec6(gross + discounts),
      discountsUSDT: dec6(discounts),
      feesUSDT: dec6(fees),
      netUSDT: dec6(gross - fees),
      tokenDeltaUSDT: dec6(gross - fees),
    },
    accountingBasis:
      'Confirmed block timestamps. Fee is what Pact took out of each payment, plus the USDT network fee of refunds you sent; Net is what reached your wallet.',
  };
}

function validateMinor(value: string, label: string) {
  if (!/^\d+$/.test(value) || BigInt(value) <= 0n)
    throw new DataError('invalid_amount', `${label} must be more than zero.`, 400);
  return BigInt(value);
}

const ACCOUNT_METHOD: PaymentMethodUsed = { kind: 'account', label: 'Pact account', demo: false };

/** Demo payment details derived from the checkout itself, so every session gets its own. */
function demoMethods(s: MockStore, checkout: CheckoutRecord): CheckoutMethodOption[] {
  const seed = keccak256(stringToHex(`pact-demo:${s.merchant.address}:${checkout.id}`));
  return [
    { kind: 'account' },
    { kind: 'card', demo: true, declineNumber: DECLINE_CARD_LABEL },
    {
      kind: 'bank',
      demo: true,
      payee: `${s.merchant.settings.brandName} via Pact`,
      bank: 'Pact Demo Bank',
      accountNumber: (BigInt(seed) % 10n ** 10n).toString().padStart(10, '0'),
      reference: `PACT-${checkout.id.slice(3, 11).toUpperCase()}`,
    },
    {
      kind: 'wallet',
      demo: true,
      depositAddress: getAddress(slice(seed, 12)),
      network: 'Whitechain Sepolia (chain 1874)',
      token: 'USDT',
    },
  ];
}

function defaultReturnPath(checkout: CheckoutRecord): string | null {
  if (checkout.returnPath) return checkout.returnPath;
  if (checkout.kind === 'product' && checkout.productId) return `/buy/${checkout.productId}`;
  if (checkout.kind === 'invoice' && checkout.invoiceId) return `/invoice/${checkout.invoiceId}`;
  if (checkout.kind === 'order' && checkout.orderId) return `/pay/${checkout.orderId}`;
  return null;
}

function checkoutState(s: MockStore, id: string, viewer: Viewer): CheckoutState {
  const checkout = s.checkouts.find(c => c.id === id);
  if (!checkout || checkout.customerId !== viewer.userId) throw notFound('Checkout');
  const c = customerRecord(s, checkout.customerId);
  if (
    checkout.status === 'pending' &&
    checkout.confirmsAtReal !== null &&
    Date.now() >= checkout.confirmsAtReal
  ) {
    // Products, payment links and manual orders all settle through their order.
    const order = checkout.kind !== 'invoice' ? s.orders.find(o => o.order.id === checkout.orderId)! : null;
    // Card, bank and own-wallet money arrives from outside the Pact account: it is credited for
    // exactly this payment, which then settles like any other (same fee, gas and records).
    const external = checkout.method !== undefined && checkout.method.kind !== 'account';
    const arriving = order ? BigInt(order.order.total.amountMinor) : checkout.amountMinor;
    if (external) c.balanceMinor += arriving;
    try {
      if (order) {
        payOrder(s, order, c);
        checkout.txHash = order.txHash;
        s.merchant.onboarding.test_payment = true;
      } else {
        const record = s.invoices.find(i => i.invoice.id === checkout.invoiceId)!;
        checkout.txHash = payInvoice(s, record, c, checkout.amountMinor).txHash;
      }
      checkout.status = 'paid';
      checkout.paidAt = now(s);
    } catch (error) {
      if (external) c.balanceMinor -= arriving;
      checkout.status = 'failed';
      checkout.failure = error instanceof DataError ? error.message : 'The payment could not be completed.';
    }
  }
  const settled = checkout.status === 'paid';
  const priced = s.orders.find(o => o.order.id === checkout.orderId)?.order;
  return {
    id: checkout.id,
    kind: checkout.kind,
    status: checkout.status,
    description: checkout.description,
    detail: checkout.detail,
    total: { currency: 'USDT', amountMinor: checkout.amountMinor.toString() },
    discountCode: priced?.discountCode,
    amountGross: priced?.amountGross,
    amountDiscount: priced?.amountDiscount,
    metadata: priced?.metadata,
    brand: brand(s),
    productId: checkout.productId,
    invoiceId: checkout.invoiceId,
    orderId: checkout.orderId,
    expiresAt: iso(checkout.expiresAt),
    readiness: c.balanceMinor >= checkout.amountMinor ? 'ready' : 'needs_funds',
    balanceMinor: c.balanceMinor.toString(),
    failure: checkout.failure,
    receipt: settled ? { paidAt: iso(checkout.paidAt!), txHash: checkout.txHash } : null,
    advanced: {
      network: 'Whitechain Sepolia (chain 1874)',
      payerAccount: c.address,
      merchantAccount: s.merchant.address,
      gasPaidBy: 'Pact',
      gasWei: settled ? (s.relayed.find(g => g.txHash === checkout.txHash)?.gasWei ?? null) : null,
    },
    methods: demoMethods(s, checkout),
    method: checkout.method ?? null,
    returnPath: defaultReturnPath(checkout),
  };
}

/** The payer's own open checkout, or the reason it cannot take a payment. */
function openCheckout(s: MockStore, id: string, viewer: Viewer): CheckoutRecord {
  const state = checkoutState(s, id, viewer);
  if (state.status !== 'open')
    throw new DataError(
      'not_open',
      state.status === 'expired' ? 'This checkout has expired.' : 'This checkout is already being paid.',
      409,
    );
  return s.checkouts.find(c => c.id === id)!;
}

/** Starts the pending → paid wait with the chosen method; checkoutState() settles it. */
function startSettlement(
  s: MockStore,
  checkout: CheckoutRecord,
  viewer: Viewer,
  method: PaymentMethodUsed,
  waitMs: number,
): CheckoutState {
  // Re-checked here, at payment time, so two payers on one single-use link cannot both pay.
  const linkProblem = linkOrderProblem(s, checkout.orderId);
  if (linkProblem) throw new DataError('link_unavailable', linkProblem, 409);
  checkout.status = 'pending';
  checkout.method = method;
  checkout.confirmsAtReal = Date.now() + waitMs;
  const order = checkout.orderId ? s.orders.find(o => o.order.id === checkout.orderId) : undefined;
  if (order) {
    order.order.status = 'pending';
    order.method = method;
  }
  return checkoutState(s, checkout.id, viewer);
}

function drainRun(s: MockStore): DrainRun {
  const before = s.merchant.usdtMinor;
  const attempts: DrainAttempt[] = [];
  const attempt = (
    attack: DrainAttempt['attack'],
    label: string,
    actor: string,
    result: { ok: boolean; reason: string },
  ) =>
    attempts.push({
      id: s.ids.next('atk', 50000),
      attack,
      label,
      actor,
      result: result.ok ? 'sent' : 'refused',
      reason: result.reason,
      layer: layerFor(result.reason) ?? 0,
    });
  const direct = (reason: string, actor: string) => {
    refusal(s, { source: 'sponsorship', reason, objectId: s.ids.tx(), actor });
    return { ok: false, reason };
  };
  const viaRelayer = (input: Parameters<typeof sponsor>[1]) => {
    const result = sponsor(s, input);
    return result.ok ? { ok: true, reason: 'sent' } : { ok: false, reason: result.refusal.reason };
  };
  const reused = s.ids.tx();
  for (let i = 0; i < 3; i++)
    attempt(
      'replay',
      `Replay a sponsored payment that already ran (copy ${i + 1})`,
      `nonce ${reused.slice(0, 10)}…`,
      direct('replay', s.ids.address()),
    );
  for (let i = 0; i < 5; i++) {
    const actor = s.ids.address();
    attempt(
      'dust',
      'Dust payment of 0.000001 USDT',
      actor,
      viaRelayer({
        action: 'payment',
        objectId: s.ids.tx(),
        label: 'Dust payment',
        payer: actor,
        amountMinor: 1n,
        feeMinor: 0n,
      }),
    );
  }
  for (let i = 0; i < 3; i++)
    attempt(
      'arbitrary_calldata',
      'Arbitrary calldata 0xdeadbeef through the Router',
      s.ids.address(),
      direct('wrong_selector', s.ids.address()),
    );
  for (let i = 0; i < 3; i++)
    attempt('over_gas_cap', 'Gas-heavy call above the per-call cap', s.ids.address(), direct('gas_limit', s.ids.address()));
  // Only the merchant can sign a call that spends its USDT; a stranger's refund never runs.
  for (let i = 0; i < 50; i++) {
    const actor = s.ids.address();
    attempt(
      'spend_merchant_funds',
      `A new account signs a refund that would spend the merchant's USDT (${i + 1}/50)`,
      actor,
      direct('signer_not_merchant', actor),
    );
  }
  for (let i = 0; i < 2; i++)
    attempt(
      'stale_deadline',
      'Intent with an expired deadline',
      s.ids.address(),
      direct('deadline', s.ids.address()),
    );
  return {
    id: s.ids.next('drn', 100),
    startedAt: iso(now(s)),
    attempts,
    legitimateSent: 0,
    merchantBalanceBeforeMinor: before.toString(),
    merchantBalanceAfterMinor: s.merchant.usdtMinor.toString(),
  };
}

/**
 * The keeper's work for written reminders: send each scheduled one once its time has come, and
 * call it off if the invoice was paid first. Runs on every tick, so it does not wait for a page view.
 */
function sendDueReminders(s: MockStore) {
  type Written = {
    id: string;
    to: string;
    sendAt: string;
    sentAt: string | null;
    cancelledAt: string | null;
  };
  for (const record of s.invoices as Array<InvoiceRecord & { manualReminders?: Written[] }>) {
    for (const reminder of [...(record.manualReminders ?? [])].reverse()) {
      if (reminder.sentAt || reminder.cancelledAt || new Date(reminder.sendAt).getTime() > now(s)) continue;
      if (record.invoice.status === 'paid') {
        reminder.cancelledAt = reminder.sendAt;
        continue;
      }
      reminder.sentAt = reminder.sendAt;
      record.activity.push({
        type: 'reminder',
        at: reminder.sendAt,
        detail: `Scheduled reminder sent to ${reminder.to}`,
      });
      webhook(s, 'invoice.reminder_due', record.invoice.id);
    }
  }
}
hooks.tick.push(sendDueReminders);

// -------------------------------------------------------------------- kit

/**
 * The helpers the part sources (commerce extras, financing, lab) share with this file.
 * Passed in rather than imported so the part modules never import this one at runtime.
 */
const kit = {
  current,
  store,
  readMerchant,
  writeMerchant,
  asCustomer,
  typedData,
  prepare,
  consume,
  brand,
  orderItem,
  orderDetail,
  invoiceDetail,
  subscriptionDetail,
  planSummary,
  validateMinor,
  checkoutState,
  contracts: { router: ROUTER, subscriptions: SUBSCRIPTIONS, usdt: USDT_ADDRESS },
};
export type MockKit = typeof kit;

// ------------------------------------------------------------------ source

const source: DataSource = {
  mode: 'mock',

  commerce: createMockCommerce(kit),
  financing: createMockFinancing(kit),
  lab: createMockLab(kit),

  merchant: {
    async notificationPreferences() {
      await readMerchant();
      const saved = (await current()).notificationPrefs?.merchant;
      return { email: saved?.email ?? null, events: saved?.events ?? MERCHANT_NOTIFICATION_EVENTS, available: MERCHANT_NOTIFICATION_EVENTS };
    },
    async updateNotificationPreferences(input) {
      await writeMerchant();
      if (input.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email))
        throw new DataError('invalid_notification_preferences', 'Enter a valid email address.', 422);
      const s = await current();
      s.notificationPrefs = { ...s.notificationPrefs, merchant: { email: input.email?.toLowerCase() ?? null, events: input.events.filter(event => MERCHANT_NOTIFICATION_EVENTS.includes(event)) } };
      return { ...s.notificationPrefs.merchant!, available: MERCHANT_NOTIFICATION_EVENTS };
    },
    connectTelegram: telegramUnavailable,
    disconnectTelegram: telegramUnavailable,
    async settings() {
      await readMerchant();
      return { ...(await current()).merchant.settings };
    },
    async updateSettings(update) {
      await writeMerchant();
      const s = await current();
      if (update.brandName !== undefined && !update.brandName.trim())
        throw new DataError('invalid_brand', 'Enter a business name.', 400);
      if (
        update.refundWindowSeconds !== undefined &&
        (update.refundWindowSeconds < 3600 || update.refundWindowSeconds > 365 * 86_400)
      )
        throw new DataError(
          'invalid_refund_window',
          'The refund window must be between 1 hour and 365 days.',
          400,
        );
      s.merchant.settings = { ...s.merchant.settings, ...update } as MerchantSettings;
      s.merchant.name = s.merchant.settings.brandName;
      s.merchant.onboarding.brand = true;
      return { ...s.merchant.settings };
    },
    async feePreview() {
      await readMerchant();
      const s = await current();
      return {
        chainId: 1874,
        blockNumber: summary(s).balance!.blockNumber!,
        targetGas: 120_000,
        gasPriceWei: '1000000000',
        usdtPerWbtMinor: s.fees.usdtPerWbtMinor.toString(),
        // 120,000 gas at 1 gwei, at the FeeSchedule's WBT price, rounded up.
        maximumGasFeeMinor: ((120_000n * 1_000_000_000n * s.fees.usdtPerWbtMinor + 10n ** 18n - 1n) / 10n ** 18n).toString(),
        minimumAmountMinor: MIN_AMOUNT_MINOR.toString(),
      };
    },
    async overview() {
      await readMerchant();
      const s = await current();
      return { summary: summary(s), onboarding: onboarding(s), activity: activityFeed(s) };
    },

    async products() {
      await readMerchant();
      return (await await current()).products.map(p => ({ ...p }));
    },
    async product(id) {
      await readMerchant();
      const found = (await await current()).products.find(p => p.id === id);
      if (!found) throw notFound('Product');
      return { ...found };
    },
    async createProduct(input) {
      await writeMerchant();
      const s = await current();
      if (!input.name.trim()) throw new DataError('invalid_name', 'Enter a product name.', 400);
      const product: Product = {
        id: s.ids.next('prod', 100),
        merchantId: s.merchant.id,
        name: input.name.trim(),
        description: input.description.trim(),
        imageUrl: null,
        status: input.status,
        revision: 1,
        prices: [{ currency: 'USDT', amountMinor: validateMinor(input.priceMinor, 'The price').toString() }],
        ...(input.checkoutFields?.length ? { checkoutFields: input.checkoutFields } : {}),
      };
      s.products.unshift(product);
      return { ...product };
    },
    async updateProduct(id, input) {
      await writeMerchant();
      const s = await current();
      const found = s.products.find(p => p.id === id);
      if (!found) throw notFound('Product');
      if (input.name !== undefined) found.name = input.name.trim() || found.name;
      if (input.description !== undefined) found.description = input.description.trim();
      if (input.status) found.status = input.status;
      if (input.priceMinor !== undefined)
        found.prices = [
          { currency: 'USDT', amountMinor: validateMinor(input.priceMinor, 'The price').toString() },
        ];
      if (input.checkoutFields !== undefined) found.checkoutFields = input.checkoutFields;
      found.revision += 1;
      return { ...found };
    },

    async orders(filter) {
      await readMerchant();
      const s = await current();
      const query = filter?.query?.toLowerCase();
      return s.orders
        .map(record => orderItem(s, record))
        .filter(
          o =>
            (!filter?.status || filter.status === 'all' || o.status === filter.status) &&
            (!filter?.customerId || o.customerId === filter.customerId) &&
            (!query ||
              `${o.id} ${o.productName} ${o.customerName} ${o.customerEmail}`.toLowerCase().includes(query)),
        );
    },
    async order(id) {
      await readMerchant();
      const s = await current();
      const record = s.orders.find(o => o.order.id === id);
      if (!record) throw notFound('Order');
      return orderDetail(s, record);
    },
    async prepareRefund(orderId, amountMinor, reason) {
      const viewer = await writeMerchant();
      const s = await current();
      const record = s.orders.find(o => o.order.id === orderId);
      if (!record) throw notFound('Order');
      const amount = validateMinor(amountMinor, 'The refund');
      if (!reason.trim()) throw new DataError('invalid_reason', 'Choose a reason for the refund.', 400);
      const c = customerRecord(s, record.order.customerId);
      return prepare(
        s,
        viewer,
        'refund',
        { orderId, amountMinor: amount.toString(), reason: reason.trim() },
        {
          title: `Refund ${c.name}`,
          lines: [
            { label: 'Refund', value: `${dec6(amount)} USDT` },
            { label: 'Order', value: `${record.order.productName} · ${record.order.id}` },
            { label: 'Reason', value: reason.trim() },
          ],
        },
        typedData('Settle Router', ROUTER, 'Intent', {
          action: 'refund',
          payment: record.order.paymentId ?? '',
          amount: amount.toString(),
          nonce: s.ids.token(8),
          deadline: String(Math.floor(now(s) / 1000) + 300),
        }),
      );
    },
    async submitRefund(token, signature) {
      const viewer = await writeMerchant();
      const s = await current();
      const payload = consume(s, viewer, 'refund', token, signature);
      const record = s.orders.find(o => o.order.id === payload.orderId);
      if (!record) throw notFound('Order');
      refundOrder(s, record, BigInt(payload.amountMinor), payload.reason);
      return orderDetail(s, record);
    },

    async customers(filter) {
      await readMerchant();
      const s = await current();
      const query = filter?.query?.toLowerCase();
      return s.customers
        .map((c): CustomerSummary => {
          const entries = s.accounting.filter(e => e.customer === c.email);
          const last = [...entries].sort((a, b) => b.at - a.at)[0];
          return {
            id: c.id,
            merchantId: s.merchant.id,
            subjectId: c.address,
            email: c.email,
            name: c.name,
            company: c.company,
            orders: s.orders.filter(o => o.order.customerId === c.id).length,
            spentMinor: entries
              .filter(e => e.grossMinor > 0n)
              .reduce((t, e) => t + e.grossMinor, 0n)
              .toString(),
            refundedMinor: (-entries
              .filter(e => e.grossMinor < 0n)
              .reduce((t, e) => t + e.grossMinor, 0n)).toString(),
            activeSubscriptions: s.subscriptions.filter(
              sub => sub.customerId === c.id && (sub.status === 'active' || sub.status === 'past_due'),
            ).length,
            lastActivityAt: last ? iso(last.at) : null,
          };
        })
        .filter(c => !query || `${c.name} ${c.email} ${c.company}`.toLowerCase().includes(query));
    },
    async customer(id) {
      const s = await current();
      const list = await mockSource.merchant.customers();
      const found = list.find(c => c.id === id);
      if (!found) throw notFound('Customer');
      return {
        customer: found,
        orders: s.orders.filter(o => o.order.customerId === id).map(o => orderItem(s, o)),
        subscriptions: s.subscriptions
          .filter(sub => sub.customerId === id)
          .map(sub => subscriptionDetail(s, sub)),
        invoices: s.invoices.filter(i => i.customerId === id).map(i => invoiceDetail(s, i)),
      };
    },

    async invoices(filter) {
      await readMerchant();
      const s = await current();
      const query = filter?.query?.toLowerCase();
      return s.invoices
        .map(i => invoiceDetail(s, i))
        .filter(
          i =>
            (!filter?.status || filter.status === 'all' || i.status === filter.status) &&
            (!filter?.customerId ||
              s.invoices.find(r => r.invoice.id === i.id)?.customerId === filter.customerId) &&
            (!query || `${i.number} ${i.customerName} ${i.customerEmail}`.toLowerCase().includes(query)),
        );
    },
    async invoice(id) {
      await readMerchant();
      const s = await current();
      const record = s.invoices.find(i => i.invoice.id === id);
      if (!record) throw notFound('Invoice');
      return invoiceDetail(s, record);
    },
    async createInvoice(input) {
      await writeMerchant();
      const s = await current();
      const email = input.customerEmail.trim().toLowerCase();
      if (!/^\S+@\S+\.\S+$/.test(email))
        throw new DataError('invalid_email', 'Enter the payer’s email address.', 400);
      const lines = (input.lines ?? []).filter(l => l.description.trim());
      if (!lines.length) throw new DataError('invalid_lines', 'Add at least one line item.', 400);
      const parsed = lines.map(l => ({
        description: l.description.trim(),
        quantity: l.quantity ?? 1,
        unit: toMinor(l.unitAmount),
      }));
      if (parsed.some(l => l.unit <= 0n || !Number.isInteger(l.quantity) || l.quantity < 1))
        throw new DataError('invalid_lines', 'Each line needs a quantity and a price above zero.', 400);
      const total = parsed.reduce((t, l) => t + l.unit * BigInt(l.quantity), 0n);
      const due = input.dueAt ? new Date(input.dueAt).getTime() : now(s) + 30 * DAY;
      let c = s.customers.find(item => item.email === email);
      if (!c) {
        c = {
          id: s.ids.next('cus', 100),
          name: input.customerName?.trim() || email.split('@')[0],
          email,
          company: input.customerName?.trim() || null,
          address: s.ids.address(),
          balanceMinor: 0n,
          passkeys: 0,
          testFundsClaimedAt: null,
          createdAt: now(s),
        };
        s.customers.push(c);
      }
      const number = `INV-${1043 + s.invoices.filter(i => i.number.startsWith('INV-')).length - 4}`;
      const id = `inv_${number.slice(4)}`;
      const record: InvoiceRecord = {
        invoice: {
          id,
          status: input.status === 'sent' ? 'sent' : 'draft',
          hostedUrl: `/invoice/${id}`,
          customerEmail: email,
          amount: dec6(total),
          paid: dec6(0n),
          remaining: dec6(total),
          allowPartial: input.allowPartial ?? false,
          dueAt: iso(due),
          memo: input.memo?.trim() ?? '',
          metadata: {},
          createdAt: iso(now(s)),
          lines: parsed.map((l, index) => ({
            id: `${id}_l${index + 1}`,
            description: l.description,
            quantity: l.quantity,
            unitAmount: dec6(l.unit),
            amount: dec6(l.unit * BigInt(l.quantity)),
          })),
        },
        number,
        customerId: c.id,
        customerName: c.company ?? c.name,
        acknowledgement: null,
        reminders: reminderSchedule(due),
        activity: [{ type: 'created', at: iso(now(s)), detail: 'Invoice created' }],
      };
      if (record.invoice.status === 'sent')
        record.activity.push({ type: 'sent', at: iso(now(s)), detail: `Sent to ${email}` });
      s.invoices.unshift(record);
      webhook(s, 'invoice.created', id);
      return invoiceDetail(s, record);
    },
    async sendInvoice(id) {
      await writeMerchant();
      const s = await current();
      const record = s.invoices.find(i => i.invoice.id === id);
      if (!record) throw notFound('Invoice');
      if (record.invoice.status !== 'draft')
        throw new DataError('already_sent', 'This invoice was already sent.', 409);
      record.invoice.status = 'sent';
      record.activity.push({
        type: 'sent',
        at: iso(now(s)),
        detail: `Sent to ${record.invoice.customerEmail}`,
      });
      webhook(s, 'invoice.sent', id);
      return invoiceDetail(s, record);
    },
    async remindInvoice(id) {
      await writeMerchant();
      const s = await current();
      const record = s.invoices.find(i => i.invoice.id === id);
      if (!record) throw notFound('Invoice');
      if (['draft', 'paid'].includes(record.invoice.status))
        throw new DataError('not_remindable', 'Only sent, unpaid invoices can be reminded.', 409);
      record.activity.push({
        type: 'reminder',
        at: iso(now(s)),
        detail: `Reminder sent to ${record.invoice.customerEmail}`,
      });
      webhook(s, 'invoice.reminder_due', id);
      return invoiceDetail(s, record);
    },

    async plans() {
      await readMerchant();
      const s = await current();
      return s.plans.map(p => planSummary(s, p.id));
    },
    async createPlan(input) {
      await writeMerchant();
      const s = await current();
      if (!input.name.trim()) throw new DataError('invalid_name', 'Enter a plan name.', 400);
      const amount = toMinor(input.amount);
      if (amount <= 0n) throw new DataError('invalid_amount', 'The price must be more than zero.', 400);
      if (input.periodSeconds < 86_400)
        throw new DataError('invalid_period', 'The billing period must be at least one day.', 400);
      const id = s.ids.next('plan', 100);
      s.plans.push({
        id,
        name: input.name.trim(),
        description: input.description?.trim() ?? '',
        amountMinor: amount,
        periodSeconds: input.periodSeconds,
        maxPeriods: input.maxPeriods ?? null,
        createdAt: now(s),
      });
      return planSummary(s, id);
    },
    async subscriptions(filter) {
      await readMerchant();
      const s = await current();
      return s.subscriptions
        .filter(sub => !filter?.status || filter.status === 'all' || sub.status === filter.status)
        .map(sub => subscriptionDetail(s, sub));
    },
    async subscription(id) {
      await readMerchant();
      const s = await current();
      const sub = s.subscriptions.find(x => x.id === id);
      if (!sub) throw notFound('Subscription');
      return subscriptionDetail(s, sub);
    },
    async runRenewal(id) {
      await writeMerchant();
      const s = await current();
      const sub = s.subscriptions.find(x => x.id === id);
      if (!sub) throw notFound('Subscription');
      const refused = chargeSubscription(s, sub, { source: 'merchant' });
      return { subscription: subscriptionDetail(s, sub), refusal: refused };
    },

    async refusals(filter) {
      await readMerchant();
      const s = await current();
      return s.refusals
        .filter(r => !filter?.source || r.source === filter.source)
        .slice(0, filter?.limit ?? 100);
    },

    async fees() {
      await readMerchant();
      return feesDetail(await current());
    },
    async feeLedger(limit = 50) {
      await readMerchant();
      return feeLedger(await current(), limit);
    },
    async prepareAcceptTerms() {
      const viewer = await writeMerchant();
      const s = await current();
      const terms = termsView();
      return prepare(
        s,
        viewer,
        'fee-terms',
        { version: String(FEE_TERMS.version) },
        {
          title: 'Sign Pact’s fee terms',
          lines: [
            { label: 'Checkout payments and renewals', value: `${terms.checkout.percent}, at least ${terms.checkout.minimumUsdt} USDT` },
            { label: 'Invoices', value: `${terms.invoice.percent}, at most ${terms.invoice.capUsdt} USDT` },
            { label: 'Taken from', value: 'Each payment, before it reaches your wallet' },
            { label: 'Your customers pay', value: 'No fee and no gas' },
          ],
          signer: 'merchant',
        },
        typedData('Pact Fees', FEES, 'AcceptTerms', {
          merchant: s.merchant.address,
          version: String(FEE_TERMS.version),
          nonce: '0',
          deadline: String(Math.floor(now(s) / 1000) + 600),
        }),
      );
    },
    async submitAcceptTerms(token, signature) {
      const viewer = await writeMerchant();
      const s = await current();
      const { version } = consume(s, viewer, 'fee-terms', token, signature);
      if (Number(version) !== FEE_TERMS.version)
        throw new DataError('fee_terms_changed', 'Pact published newer terms. Review them and sign again.', 409);
      // Pact's relayer submits the signed acceptance and pays its gas.
      sponsor(s, { action: 'fee_terms', objectId: s.merchant.id, label: 'Fee terms accepted', payer: s.merchant.address });
      s.fees.acceptedVersion = FEE_TERMS.version;
      s.merchant.onboarding.fees = feesReady(s);
      return feesDetail(s);
    },
    async preparePermit(spender) {
      const viewer = await writeMerchant();
      const s = await current();
      const permit = PERMITS[spender];
      if (!permit) throw new DataError('unknown_spender', 'Choose the escrow or the Router.', 404);
      if (s.fees.permits[spender]) throw new DataError('permit_ready', 'This permit is already in place.', 409);
      return prepare(
        s,
        viewer,
        'fee-permit',
        { spender },
        {
          title: spender === 'escrow' ? 'Allow refunds from your wallet' : 'Allow refund network fees in USDT',
          lines: [
            { label: 'Allows', value: permit.label },
            { label: 'Spent only on', value: 'Refunds you sign yourself' },
            { label: 'Network fee to sign', value: 'None: Pact submits it' },
          ],
          signer: 'merchant',
        },
        typedData('Tether USD', USDT_ADDRESS, 'Permit', {
          owner: s.merchant.address,
          spender: permit.address,
          value: (2n ** 256n - 1n).toString(),
          nonce: String(Number(s.fees.permits.escrow) + Number(s.fees.permits.router)),
          deadline: String(Math.floor(now(s) / 1000) + 300),
        }),
      );
    },
    async submitPermit(token, signature) {
      const viewer = await writeMerchant();
      const s = await current();
      const { spender } = consume(s, viewer, 'fee-permit', token, signature) as { spender: MerchantSpender };
      sponsor(s, { action: 'permit', objectId: `${s.merchant.id}:${spender}`, label: `USDT permit for the ${spender}`, payer: s.merchant.address });
      s.fees.permits[spender] = true;
      s.merchant.onboarding.fees = feesReady(s);
      return feesDetail(s);
    },

    async securityLayers() {
      await readMerchant();
      const s = await current();
      return SECURITY_LAYERS.map((layer): SecurityLayer => ({
        ...layer,
        reasons: [...layer.reasons],
        blocked: s.refusals.filter(r => r.source === 'sponsorship' && r.layer === layer.id).length,
      }));
    },
    async runDrainSimulation() {
      await writeMerchant();
      const s = await current();
      const run = drainRun(s);
      s.drainRuns.unshift(run);
      return run;
    },

    async paidEndpoints() {
      await readMerchant();
      const s = await current();
      const today = dayKey(now(s));
      return s.endpoints.map(ep => {
        const calls = s.agentCalls.filter(
          c =>
            c.merchantName === s.merchant.name && c.url.startsWith(ep.path) && c.createdAt.startsWith(today),
        );
        return {
          ...ep,
          callsToday: calls.filter(c => c.status === 'settled').length,
          refusedToday: calls.filter(c => c.status === 'refused').length,
          revenueTodayMinor: calls.reduce((t, c) => t + BigInt(c.amountMinor), 0n).toString(),
        };
      });
    },
    async agentCalls(limit = 50) {
      await readMerchant();
      const s = await current();
      return s.agentCalls.filter(c => c.merchantName === s.merchant.name).slice(0, limit);
    },
    async facilitator() {
      await readMerchant();
      const s = await current();
      const calls = s.agentCalls.filter(c => c.merchantName === s.merchant.name);
      const settled = calls.filter(c => c.status === 'settled').length;
      return {
        url: 'https://facilitator.pact.example',
        network: 'eip155:1874',
        asset: USDT_ADDRESS,
        schemes: ['exact', 'upto'],
        status: 'online',
        verified: calls.length,
        settled,
        refused: calls.length - settled,
        failed: 0,
      };
    },

    async apiKeys() {
      await readMerchant();
      return (await await current()).apiKeys.map(k => ({ ...k }));
    },
    async createApiKey(input) {
      await writeMerchant();
      const s = await current();
      if (!input.name.trim())
        throw new DataError('invalid_name', 'Name the key so you can recognise it later.', 400);
      const secret = `${input.kind === 'publishable' ? 'pk' : 'sk'}_test_${s.ids.token(20)}`;
      const key = {
        id: s.ids.next('key', 10),
        name: input.name.trim(),
        kind: input.kind,
        preview: `${secret.slice(0, 8)}…${secret.slice(-4)}`,
        createdAt: iso(now(s)),
        lastUsedAt: null,
        revokedAt: null,
      };
      s.apiKeys.unshift(key);
      return { key: { ...key }, secret };
    },
    async revokeApiKey(id) {
      await writeMerchant();
      const s = await current();
      const key = s.apiKeys.find(k => k.id === id);
      if (!key) throw notFound('API key');
      key.revokedAt ??= iso(now(s));
      return { ...key };
    },

    async webhook() {
      await readMerchant();
      const s = await current();
      return {
        url: s.merchant.settings.webhook.url,
        configured: s.merchant.settings.webhook.configured,
        eventTypes: [...s.merchant.webhookEventTypes],
        secretPreview: s.merchant.webhookSecret ? `${s.merchant.webhookSecret.slice(0, 9)}…` : null,
      };
    },
    async configureWebhook(url) {
      await writeMerchant();
      const s = await current();
      if (!/^https:\/\/[^\s]+$/.test(url))
        throw new DataError('invalid_url', 'Use an https:// endpoint.', 400);
      const signingSecret = `whsec_${s.ids.token(16)}`;
      s.merchant.webhookSecret = signingSecret;
      s.merchant.settings.webhook = { url, configured: true };
      s.merchant.onboarding.integrate = true;
      return { config: await mockSource.merchant.webhook(), signingSecret };
    },
    async webhookEvents() {
      await readMerchant();
      return (await await current()).webhookEvents.slice(0, 50);
    },
    async webhookDeliveries() {
      await readMerchant();
      return (await await current()).webhookDeliveries.slice(0, 80);
    },
    async replayWebhook(eventId) {
      await writeMerchant();
      const s = await current();
      const event = s.webhookEvents.find(e => e.id === eventId);
      if (!event) throw notFound('Event');
      const attempts = s.webhookDeliveries.filter(d => d.event_id === eventId).length;
      const delivery: WebhookDelivery = {
        id: s.ids.next('dlv', 7000),
        event_id: eventId,
        attempt: attempts + 1,
        status: 'delivered',
        next_at: iso(now(s)),
        last_http_status: 200,
        last_error: null,
        delivered_at: iso(now(s)),
      };
      s.webhookDeliveries.unshift(delivery);
    },
    async sendTestWebhook() {
      await writeMerchant();
      webhook(await current(), 'webhook.test', 'test');
    },

    async exportReport(range) {
      await readMerchant();
      return exportReport(await current(), range);
    },

    // Merchant polish. These records ride on existing sandbox records as optional fields, so
    // they persist with the rest of the sandbox without changing the store's shape.
    async preferences() {
      await readMerchant();
      const s = await current();
      const saved = (
        s.merchant as typeof s.merchant & {
          preferences?: Awaited<ReturnType<DataSource['merchant']['preferences']>>;
        }
      ).preferences;
      return { brandColor: saved?.brandColor ?? '#c6ff34' };
    },
    async updatePreferences(update) {
      await writeMerchant();
      const s = await current();
      if (update.brandColor !== undefined && !/^#[0-9a-f]{6}$/i.test(update.brandColor))
        throw new DataError('invalid_colour', 'Use a six-digit hex colour, like #c6ff34.', 400);
      const saved = await mockSource.merchant.preferences();
      const next = { brandColor: update.brandColor?.toLowerCase() ?? saved.brandColor };
      (
        s.merchant as typeof s.merchant & {
          preferences?: Awaited<ReturnType<DataSource['merchant']['preferences']>>;
        }
      ).preferences = next;
      return { ...next };
    },
    async sendReminder(id, input) {
      await writeMerchant();
      const s = await current();
      const record = s.invoices.find(i => i.invoice.id === id) as
        | (InvoiceRecord & {
            manualReminders?: Awaited<ReturnType<DataSource['merchant']['manualReminders']>>;
          })
        | undefined;
      if (!record) throw notFound('Invoice');
      if (['draft', 'paid'].includes(record.invoice.status))
        throw new DataError('not_remindable', 'Only sent, unpaid invoices can be reminded.', 409);
      const message = input.message.trim();
      if (!message) throw new DataError('invalid_message', 'Write a message for the payer.', 400);
      if (message.length > 1000)
        throw new DataError('invalid_message', 'Keep the message under 1,000 characters.', 400);
      const at = now(s);
      const sendAt = input.sendAt ? new Date(input.sendAt).getTime() : at;
      if (Number.isNaN(sendAt)) throw new DataError('invalid_date', 'Choose a valid date and time.', 400);
      if (input.sendAt && sendAt <= at)
        throw new DataError('invalid_date', 'Choose a time in the future, or send it now.', 400);
      if (sendAt > at + 90 * DAY)
        throw new DataError('invalid_date', 'Schedule reminders up to 90 days ahead.', 400);
      const reminder = {
        id: s.ids.next('rem', 100),
        invoiceId: id,
        message,
        to: record.invoice.customerEmail,
        sendAt: iso(sendAt),
        sentAt: null as string | null,
        cancelledAt: null as string | null,
        createdAt: iso(at),
      };
      (record.manualReminders ??= []).unshift(reminder);
      if (!input.sendAt) {
        reminder.sentAt = iso(at);
        record.activity.push({
          type: 'reminder',
          at: iso(at),
          detail: `Reminder sent to ${record.invoice.customerEmail}`,
        });
        webhook(s, 'invoice.reminder_due', id);
      }
      return { ...reminder };
    },
    async manualReminders(id) {
      await readMerchant();
      const s = await current();
      const record = s.invoices.find(i => i.invoice.id === id) as
        | (InvoiceRecord & {
            manualReminders?: Awaited<ReturnType<DataSource['merchant']['manualReminders']>>;
          })
        | undefined;
      if (!record) throw notFound('Invoice');
      sendDueReminders(s);
      return (record.manualReminders ?? []).map(reminder => ({ ...reminder }));
    },
    async cancelReminder(id, reminderId) {
      await writeMerchant();
      const s = await current();
      const record = s.invoices.find(i => i.invoice.id === id) as
        | (InvoiceRecord & {
            manualReminders?: Awaited<ReturnType<DataSource['merchant']['manualReminders']>>;
          })
        | undefined;
      const reminder = record?.manualReminders?.find(r => r.id === reminderId);
      if (!reminder) throw notFound('Reminder');
      if (reminder.sentAt) throw new DataError('already_sent', 'This reminder was already sent.', 409);
      reminder.cancelledAt ??= iso(now(s));
      return { ...reminder };
    },
    async simulateRenewalFailure(id) {
      await writeMerchant();
      const s = await current();
      const sub = s.subscriptions.find(x => x.id === id);
      if (!sub) throw notFound('Subscription');
      if (sub.status !== 'active' && sub.status !== 'past_due')
        throw new DataError('not_live', 'Only active or past-due subscriptions renew.', 409);
      // The engine runs the real pull with the payer's balance held at zero, so the refusal,
      // the retry schedule and the past-due webhook are the ones a low balance produces.
      const c = customerRecord(s, sub.customerId);
      const balance = c.balanceMinor;
      sub.nextChargeAt = Math.min(sub.nextChargeAt, now(s));
      c.balanceMinor = 0n;
      let refused: ReturnType<typeof chargeSubscription>;
      try {
        refused = chargeSubscription(s, sub, { source: 'merchant' });
      } finally {
        c.balanceMinor = balance;
      }
      return { subscription: subscriptionDetail(s, sub), refusal: refused };
    },
    async prepareCancelSubscription(id, effective) {
      const viewer = await writeMerchant();
      const s = await current();
      const sub = s.subscriptions.find(x => x.id === id);
      if (!sub) throw notFound('Subscription');
      if (sub.status === 'cancelled')
        throw new DataError('already_cancelled', 'This subscription is already cancelled.', 409);
      if (effective !== 'period_end' && effective !== 'now')
        throw new DataError('invalid_effective', 'Choose when the subscription ends.', 400);
      const p = planRecord(s, sub.planId);
      const c = customerRecord(s, sub.customerId);
      const day = (ms: number) =>
        new Date(ms).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        });
      const ends =
        effective === 'period_end' && sub.status === 'active'
          ? `${day(sub.nextChargeAt)}, end of the paid period`
          : `Today, ${day(now(s))}`;
      return prepare(
        s,
        viewer,
        'merchant_cancel',
        { id, effective },
        {
          title: `Cancel ${p.name} for ${c.name}`,
          lines: [
            { label: 'Customer', value: `${c.name} · ${c.email}` },
            { label: 'Ends', value: ends },
            { label: 'Charges', value: 'None after today' },
          ],
        },
        typedData('Settle Subscription', SUBSCRIPTIONS, 'MerchantCancel', {
          subscription: sub.chainId,
          deadline: String(Math.floor(now(s) / 1000) + 300),
        }),
      );
    },
    async submitCancelSubscription(token, signature) {
      const viewer = await writeMerchant();
      const s = await current();
      const { id, effective } = consume(s, viewer, 'merchant_cancel', token, signature);
      const sub = s.subscriptions.find(x => x.id === id);
      if (!sub) throw notFound('Subscription');
      const paidUp = sub.status === 'active';
      cancelSubscription(s, sub);
      // The mandate is revoked now either way; only the paid period's end differs.
      if (effective === 'now' || !paidUp) sub.nextChargeAt = sub.cancelledAt ?? now(s);
      return subscriptionDetail(s, sub);
    },
  },

  customer: {
    connectTelegram: telegramUnavailable,
    disconnectTelegram: telegramUnavailable,
    async notificationPreferences() {
      const viewer = await asCustomer();
      return { email: viewer.email, events: (await current()).notificationPrefs?.customers?.[viewer.userId] ?? CUSTOMER_NOTIFICATION_EVENTS, available: CUSTOMER_NOTIFICATION_EVENTS };
    },
    async updateNotificationPreferences(input) {
      const viewer = await asCustomer();
      const s = await current(), events = input.events.filter(event => CUSTOMER_NOTIFICATION_EVENTS.includes(event));
      s.notificationPrefs = { ...s.notificationPrefs, customers: { ...s.notificationPrefs?.customers, [viewer.userId]: events } };
      return { email: viewer.email, events, available: CUSTOMER_NOTIFICATION_EVENTS };
    },
    async account() {
      const viewer = await asCustomer();
      const s = await current();
      const c = customerRecord(s, viewer.userId);
      const at = now(s);
      return {
        name: c.name,
        email: c.email,
        company: c.company,
        address: c.address,
        balanceMinor: c.balanceMinor.toString(),
        passkeys: c.passkeys,
        testFunds: {
          amountMinor: USDT(1000).toString(),
          nextClaimAt:
            c.testFundsClaimedAt && c.testFundsClaimedAt + DAY > at ? iso(c.testFundsClaimedAt + DAY) : null,
        },
      };
    },
    async claimTestFunds() {
      const viewer = await asCustomer();
      const s = await current();
      const c = customerRecord(s, viewer.userId);
      if (c.testFundsClaimedAt && c.testFundsClaimedAt + DAY > now(s))
        throw new DataError('faucet_cooldown', 'Test funds can be claimed once a day.', 429);
      c.balanceMinor += USDT(1000);
      c.testFundsClaimedAt = now(s);
      return mockSource.customer.account();
    },

    async orders() {
      const viewer = await asCustomer();
      const s = await current();
      return s.orders
        .filter(
          o =>
            o.order.customerId === viewer.userId && o.order.status !== 'open' && o.order.status !== 'expired',
        )
        .map(o => orderItem(s, o));
    },
    async order(id) {
      const viewer = await asCustomer();
      const s = await current();
      const record = s.orders.find(o => o.order.id === id && o.order.customerId === viewer.userId);
      if (!record) throw notFound('Order');
      return orderDetail(s, record);
    },

    async subscriptions() {
      const viewer = await asCustomer();
      const s = await current();
      return s.subscriptions
        .filter(sub => sub.customerId === viewer.userId)
        .map(sub => subscriptionDetail(s, sub));
    },
    async subscription(id) {
      const viewer = await asCustomer();
      const s = await current();
      const sub = s.subscriptions.find(x => x.id === id && x.customerId === viewer.userId);
      if (!sub) throw notFound('Subscription');
      const detail = subscriptionDetail(s, sub);
      return detail;
    },
    async availablePlans() {
      await asCustomer();
      const s = await current();
      // The sandbox has one business, and the demo customer already buys from it.
      const merchant = { id: s.merchant.id, name: brand(s).brandName, logoUrl: brand(s).logoUrl };
      return s.plans
        .filter(p => !planArchived(s, p.id))
        .map(p => {
          const { activeSubscribers: _a, monthlyRecurringMinor: _m, ...plan } = planSummary(s, p.id);
          return { plan, merchant };
        });
    },
    async prepareCancel(id) {
      const viewer = await asCustomer();
      const s = await current();
      const sub = s.subscriptions.find(x => x.id === id && x.customerId === viewer.userId);
      if (!sub) throw notFound('Subscription');
      if (sub.status === 'cancelled')
        throw new DataError('already_cancelled', 'This subscription is already cancelled.', 409);
      const p = planRecord(s, sub.planId);
      const day = (ms: number) =>
        new Date(ms).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
          timeZone: 'UTC',
        });
      return prepare(
        s,
        viewer,
        'cancel',
        { id },
        {
          title: `Cancel ${p.name}`,
          lines: [
            { label: 'Plan', value: p.name },
            {
              label: 'Ends',
              value:
                sub.status === 'active'
                  ? `${day(sub.nextChargeAt)}, end of the period you paid for`
                  : `Today, ${day(now(s))}`,
            },
            { label: 'Charges', value: 'None after today' },
          ],
        },
        typedData('Settle Subscription', SUBSCRIPTIONS, 'Cancel', {
          subscription: sub.chainId,
          deadline: String(Math.floor(now(s) / 1000) + 300),
        }),
      );
    },
    async submitCancel(token, signature) {
      const viewer = await asCustomer();
      const s = await current();
      const { id } = consume(s, viewer, 'cancel', token, signature);
      const sub = s.subscriptions.find(x => x.id === id && x.customerId === viewer.userId);
      if (!sub) throw notFound('Subscription');
      const paidUp = sub.status === 'active';
      cancelSubscription(s, sub);
      // A paid-up subscription runs to the end of its period; one that is behind ends now.
      if (!paidUp) sub.nextChargeAt = sub.cancelledAt ?? now(s);
      return subscriptionDetail(s, sub);
    },
    async prepareChangePlan(id, planId) {
      const viewer = await asCustomer();
      const s = await current();
      const sub = s.subscriptions.find(x => x.id === id && x.customerId === viewer.userId);
      if (!sub) throw notFound('Subscription');
      if (sub.status === 'cancelled')
        throw new DataError('already_cancelled', 'Cancelled subscriptions cannot change plan.', 409);
      if (sub.planId === planId) throw new DataError('same_plan', 'You are already on this plan.', 409);
      const next = planRecord(s, planId);
      return prepare(
        s,
        viewer,
        'change_plan',
        { id, planId },
        {
          title: `Switch to ${next.name}`,
          lines: [
            { label: 'New plan', value: `${dec6(next.amountMinor)} USDT per period` },
            { label: 'Up to', value: next.maxPeriods ? `${next.maxPeriods} periods` : 'Until you cancel' },
            { label: 'Old plan', value: 'Revoked in the same transaction' },
          ],
        },
        typedData('Settle Subscription', SUBSCRIPTIONS, 'Mandate', {
          plan: next.id,
          amountCap: next.amountMinor.toString(),
          periodSeconds: String(next.periodSeconds),
          replaces: sub.chainId,
        }),
      );
    },
    async submitChangePlan(token, signature) {
      const viewer = await asCustomer();
      const s = await current();
      const { id, planId } = consume(s, viewer, 'change_plan', token, signature);
      const old = s.subscriptions.find(x => x.id === id && x.customerId === viewer.userId);
      if (!old) throw notFound('Subscription');
      const next = subscribe(s, customerRecord(s, viewer.userId), planRecord(s, planId), {
        chargeNow: false,
      });
      next.nextChargeAt = old.nextChargeAt;
      old.status = 'cancelled';
      old.cancelledAt = now(s);
      old.replacedBy = next.id;
      webhook(s, 'subscription.replaced', old.id);
      return subscriptionDetail(s, next);
    },

    async invoices() {
      const viewer = await asCustomer();
      const s = await current();
      return s.invoices
        .filter(i => i.customerId === viewer.userId && i.invoice.status !== 'draft')
        .map(i => invoiceDetail(s, i));
    },
    async invoice(id) {
      const viewer = await asCustomer();
      const s = await current();
      const record = s.invoices.find(
        i => i.invoice.id === id && i.customerId === viewer.userId && i.invoice.status !== 'draft',
      );
      if (!record) throw notFound('Invoice');
      return invoiceDetail(s, record);
    },
    async prepareAcknowledge(id) {
      const viewer = await asCustomer();
      const s = await current();
      const record = s.invoices.find(i => i.invoice.id === id && i.customerId === viewer.userId);
      if (!record) throw notFound('Invoice');
      if (record.acknowledgement)
        throw new DataError('already_acknowledged', 'You already acknowledged this invoice.', 409);
      return prepare(
        s,
        viewer,
        'acknowledge',
        { id },
        {
          title: `Acknowledge ${record.number}`,
          lines: [
            { label: 'Amount', value: `${record.invoice.amount.replace(/0{4}$/, '')} USDT` },
            { label: 'Due', value: record.invoice.dueAt?.slice(0, 10) ?? 'On receipt' },
            { label: 'You confirm', value: 'I owe this invoice' },
          ],
        },
        typedData('Settle Router', ROUTER, 'Acknowledgement', {
          invoice: record.number,
          amount: toMinor(record.invoice.amount).toString(),
          statement: 'I owe this invoice',
        }),
      );
    },
    async submitAcknowledge(token, signature) {
      const viewer = await asCustomer();
      const s = await current();
      const { id } = consume(s, viewer, 'acknowledge', token, signature);
      const record = s.invoices.find(i => i.invoice.id === id && i.customerId === viewer.userId);
      if (!record) throw notFound('Invoice');
      const c = customerRecord(s, viewer.userId);
      const signed = sponsor(s, {
        action: 'invoice_acknowledge',
        objectId: `${id}:ack`,
        label: `Acknowledgement of ${record.number}`,
        payer: c.address,
      });
      record.acknowledgement = {
        signedAt: iso(now(s)),
        signer: c.address,
        txHash: signed.ok ? signed.txHash : null,
      };
      if (record.invoice.status === 'sent') record.invoice.status = 'acknowledged';
      record.activity.push({
        type: 'acknowledged',
        at: iso(now(s)),
        detail: `${c.name} signed “I owe this invoice”`,
        txHash: signed.ok ? signed.txHash : null,
      });
      return invoiceDetail(s, record);
    },

    async agents() {
      const viewer = await asCustomer();
      const s = await current();
      return s.agents.filter(a => a.customerId === viewer.userId).map(a => agentView(s, a.session.id));
    },
    async agent(id) {
      const viewer = await asCustomer();
      const s = await current();
      const record = s.agents.find(a => a.session.id === id && a.customerId === viewer.userId);
      if (!record) throw notFound('Agent');
      return { session: agentView(s, id), calls: s.agentCalls.filter(c => c.agentId === id).slice(0, 40) };
    },
    async prepareAgentLimits(id, limits) {
      const viewer = await asCustomer();
      const s = await current();
      const record = s.agents.find(a => a.session.id === id && a.customerId === viewer.userId);
      if (!record) throw notFound('Agent');
      if (record.session.status !== 'active')
        throw new DataError('session_inactive', 'Only active agents can change limits.', 409);
      const perCall = validateMinor(limits.perCallCapMinor, 'The per-call cap');
      const daily = validateMinor(limits.dailyCapMinor, 'The daily cap');
      if (perCall > daily)
        throw new DataError('invalid_limits', 'The per-call cap cannot be above the daily cap.', 400);
      if (daily > USDT(100)) throw new DataError('invalid_limits', 'The daily cap can be at most $100.', 400);
      return prepare(
        s,
        viewer,
        'agent_limits',
        { id, perCall: perCall.toString(), daily: daily.toString() },
        {
          title: `Update ${record.session.name} limits`,
          lines: [
            { label: 'Per call', value: `up to ${dec6(perCall)} USDT` },
            { label: 'Per day', value: `up to ${dec6(daily)} USDT` },
            { label: 'Allowed', value: record.session.allowedMerchants.map(m => m.name).join(', ') },
          ],
        },
        typedData('Settle X402 Account', record.session.account, 'Session', {
          sessionKey: record.session.sessionKey,
          perCallCap: perCall.toString(),
          dailyCap: daily.toString(),
          expiresAt: record.session.expiresAt,
        }),
      );
    },
    async submitAgentLimits(token, signature) {
      const viewer = await asCustomer();
      const s = await current();
      const { id, perCall, daily } = consume(s, viewer, 'agent_limits', token, signature);
      const record = s.agents.find(a => a.session.id === id && a.customerId === viewer.userId);
      if (!record) throw notFound('Agent');
      record.session.perCallCapMinor = perCall;
      record.session.dailyCapMinor = daily;
      return agentView(s, id);
    },
    async prepareRevokeAgent(id) {
      const viewer = await asCustomer();
      const s = await current();
      const record = s.agents.find(a => a.session.id === id && a.customerId === viewer.userId);
      if (!record) throw notFound('Agent');
      if (record.session.status === 'revoked')
        throw new DataError('already_revoked', 'This agent was already revoked.', 409);
      return prepare(
        s,
        viewer,
        'agent_revoke',
        { id },
        {
          title: `Revoke ${record.session.name}`,
          lines: [
            { label: 'Effect', value: 'The agent can no longer pay anyone' },
            { label: 'Spent today', value: `${dec6(record.spentByDay[dayKey(now(s))] ?? 0n)} USDT` },
          ],
        },
        typedData('Settle X402 Account', record.session.account, 'RevokeSession', {
          sessionKey: record.session.sessionKey,
        }),
      );
    },
    async submitRevokeAgent(token, signature) {
      const viewer = await asCustomer();
      const s = await current();
      const { id } = consume(s, viewer, 'agent_revoke', token, signature);
      const record = s.agents.find(a => a.session.id === id && a.customerId === viewer.userId);
      if (!record) throw notFound('Agent');
      record.session.status = 'revoked';
      return agentView(s, id);
    },
    async runAgent(id, count) {
      const viewer = await asCustomer();
      const s = await current();
      const record = s.agents.find(a => a.session.id === id && a.customerId === viewer.userId);
      if (!record) throw notFound('Agent');
      const calls = [];
      const invoices = [
        'INV-1042',
        'INV-1040',
        'INV-1039',
        'INV-0977',
        'INV-0981',
        'INV-0990',
        'INV-1001',
        'INV-1013',
        'INV-1027',
        'INV-1031',
        'INV-1036',
        'INV-1038',
      ];
      for (let i = 0; i < Math.min(Math.max(count, 1), 20); i++) {
        calls.push(
          agentCall(
            s,
            record,
            s.endpoints[0],
            s.merchant,
            `/api/risk-score?invoice=${invoices[i % invoices.length]}`,
          ),
        );
      }
      return { calls, session: agentView(s, id) };
    },
  },

  checkout: {
    async invoiceBrand(invoiceId) {
      const s = await current();
      const record = s.invoices.find(i => i.invoice.id === invoiceId);
      if (!record || record.invoice.status === 'draft') throw notFound('Invoice');
      return brand(s);
    },
    async catalog(productId) {
      const s = await current();
      const product = s.products.find(p => p.id === productId && p.status !== 'archived');
      if (!product) throw notFound('Product');
      return { product: { ...product }, brand: brand(s), available: product.status === 'active' };
    },
    async startProductCheckout(productId, discountCode, metadata) {
      const viewer = await asCustomer();
      const s = await current();
      const product = s.products.find(p => p.id === productId && p.status === 'active');
      if (!product) throw new DataError('product_unavailable', 'This product is not available.', 404);
      const answers = checkMockAnswers(product.checkoutFields, metadata);
      const price = mockDiscount(s, discountCode, BigInt(product.prices[0].amountMinor), productId);
      const order: OrderRecord = {
        order: {
          id: s.ids.next('ord', 2000),
          merchantId: s.merchant.id,
          customerId: viewer.userId,
          productId,
          productRevision: product.revision,
          productName: product.name,
          total: { ...product.prices[0], amountMinor: price.net.toString() },
          discountCode: price.code,
          amountGross: dec6(price.gross),
          amountDiscount: dec6(price.discount),
          metadata: answers,
          refundedMinor: '0',
          status: 'open',
          rail: 'whitechain',
          paymentId: s.ids.tx(),
          providerSessionId: null,
          createdAt: iso(now(s)),
        },
        payerAddress: null,
        txHash: null,
        feeMinor: 0n,
        paidAt: null,
        refunds: [],
        activity: [{ type: 'order.created', at: iso(now(s)), detail: 'Checkout started', txHash: null }],
      };
      s.orders.unshift(order);
      const id = `cs_${s.ids.token(10)}`;
      s.checkouts.unshift({
        id,
        kind: 'product',
        customerId: viewer.userId,
        productId,
        invoiceId: null,
        orderId: order.order.id,
        amountMinor: price.net,
        description: product.name,
        detail: product.description,
        status: 'open',
        createdAt: now(s),
        expiresAt: now(s) + 30 * 60_000,
        confirmsAtReal: null,
        txHash: null,
        paidAt: null,
        failure: null,
      });
      redeemMockDiscount(s, price.code);
      return { sessionId: id };
    },
    async startInvoiceCheckout(invoiceId, amountMinor) {
      const viewer = await asCustomer();
      const s = await current();
      const record = s.invoices.find(i => i.invoice.id === invoiceId && i.customerId === viewer.userId);
      if (!record || record.invoice.status === 'draft') throw notFound('Invoice');
      if (record.invoice.status === 'paid')
        throw new DataError('already_paid', 'This invoice is already paid.', 409);
      const amount = validateMinor(amountMinor, 'The payment');
      const remaining = toMinor(record.invoice.remaining);
      if (amount > remaining)
        throw new DataError('invalid_amount', `At most ${dec6(remaining)} USDT is due.`, 400);
      if (!record.invoice.allowPartial && amount !== remaining)
        throw new DataError('partial_not_allowed', 'This invoice must be paid in full.', 400);
      const id = `cs_${s.ids.token(10)}`;
      s.checkouts.unshift({
        id,
        kind: 'invoice',
        customerId: viewer.userId,
        productId: null,
        invoiceId,
        orderId: null,
        amountMinor: amount,
        description: `Invoice ${record.number}`,
        detail:
          amount === remaining
            ? 'Pays the remaining balance'
            : `Partial payment of ${dec6(remaining)} USDT due`,
        status: 'open',
        createdAt: now(s),
        expiresAt: now(s) + 30 * 60_000,
        confirmsAtReal: null,
        txHash: null,
        paidAt: null,
        failure: null,
      });
      return { sessionId: id };
    },
    async session(id) {
      const viewer = await asCustomer();
      return checkoutState(await current(), id, viewer);
    },
    async preparePayment(sessionId) {
      const viewer = await asCustomer();
      const s = await current();
      const state = checkoutState(s, sessionId, viewer);
      if (state.status !== 'open')
        throw new DataError(
          'not_open',
          state.status === 'expired' ? 'This checkout has expired.' : 'This checkout is already being paid.',
          409,
        );
      if (state.readiness === 'needs_funds')
        throw new DataError('insufficient_funds', 'Add funds to your account to continue.', 409);
      const linkProblem = linkOrderProblem(s, state.orderId);
      if (linkProblem) throw new DataError('link_unavailable', linkProblem, 409);
      return prepare(
        s,
        viewer,
        'payment',
        { sessionId },
        {
          title: `Pay ${state.brand.brandName}`,
          lines: [
            { label: 'Amount', value: `$${dec6(BigInt(state.total.amountMinor)).replace(/0{4}$/, '')}` },
            { label: 'For', value: state.description },
            { label: 'Fees', value: 'None for you' },
          ],
        },
        typedData('Settle Router', ROUTER, 'Intent', {
          action: 'charge',
          checkout: sessionId,
          amount: state.total.amountMinor,
          nonce: s.ids.token(8),
          deadline: String(Math.floor(now(s) / 1000) + 300),
        }),
      );
    },
    async submitPayment(token, signature) {
      const viewer = await asCustomer();
      const s = await current();
      const { sessionId } = consume(s, viewer, 'payment', token, signature);
      const checkout = s.checkouts.find(c => c.id === sessionId && c.customerId === viewer.userId);
      if (!checkout) throw notFound('Checkout');
      if (checkout.status !== 'open')
        throw new DataError('not_open', 'This checkout is no longer open.', 409);
      return startSettlement(s, checkout, viewer, ACCOUNT_METHOD, 1800);
    },
    async payByCard(sessionId, card) {
      const viewer = await asCustomer();
      const s = await current();
      const checkout = openCheckout(s, sessionId, viewer);
      const input = {
        name: String(card?.name ?? ''),
        number: String(card?.number ?? ''),
        expiry: String(card?.expiry ?? ''),
        cvc: String(card?.cvc ?? ''),
      };
      const problem = Object.values(cardErrors(input, now(s)))[0];
      if (problem) throw new DataError('invalid_card', problem, 400);
      const label = cardLabel(input.number);
      if (digitsOnly(input.number) === DECLINE_CARD) {
        // The session stays open: nothing was charged, and the payer can try another way.
        const order = checkout.orderId ? s.orders.find(o => o.order.id === checkout.orderId) : undefined;
        order?.activity.push({
          type: 'payment.declined',
          at: iso(now(s)),
          detail: `Demo card payment declined (${label}). Nothing was charged.`,
          txHash: null,
        });
        throw new DataError(
          'card_declined',
          'Your card was declined and nothing was charged. Try another card or another way to pay.',
          402,
        );
      }
      // Only the brand and last four digits are kept.
      return startSettlement(s, checkout, viewer, { kind: 'card', label, demo: true }, 1800);
    },
    async confirmTransfer(sessionId, method) {
      const viewer = await asCustomer();
      const s = await current();
      if (method !== 'bank' && method !== 'wallet')
        throw new DataError('invalid_method', 'Choose a bank transfer or your own wallet.', 400);
      const checkout = openCheckout(s, sessionId, viewer);
      return startSettlement(
        s,
        checkout,
        viewer,
        method === 'bank'
          ? { kind: 'bank', label: 'Bank transfer', demo: true }
          : { kind: 'wallet', label: 'Your own wallet', demo: true },
        2600,
      );
    },

    async plans() {
      const s = await current();
      return s.plans.filter(p => !planArchived(s, p.id)).map(p => planSummary(s, p.id));
    },
    async planOffer(planId) {
      const s = await current();
      const viewer = await requireViewer(['customer', 'merchant', 'accountant']).catch(() => null);
      const existing =
        viewer?.role === 'customer'
          ? s.subscriptions.find(
              sub => sub.planId === planId && sub.customerId === viewer.userId && sub.status !== 'cancelled',
            )
          : undefined;
      return {
        plan: planSummary(s, planId),
        brand: brand(s),
        subscriptionId: existing?.id ?? null,
        available: !planArchived(s, planId),
      };
    },
    async prepareSubscribe(planId) {
      const viewer = await asCustomer();
      const s = await current();
      const p = planRecord(s, planId);
      if (planArchived(s, planId))
        throw new DataError('plan_archived', 'This plan is no longer offered.', 410);
      if (
        s.subscriptions.some(
          sub => sub.planId === planId && sub.customerId === viewer.userId && sub.status !== 'cancelled',
        )
      )
        throw new DataError('already_subscribed', 'You already have this plan.', 409);
      if (customerRecord(s, viewer.userId).balanceMinor < p.amountMinor)
        throw new DataError('insufficient_funds', 'Add funds to your account to continue.', 409);
      return prepare(
        s,
        viewer,
        'subscribe',
        { planId },
        {
          title: `Subscribe to ${p.name}`,
          lines: [
            { label: 'Charge', value: `up to $${dec6(p.amountMinor).replace(/0{4}$/, '')} each month` },
            { label: 'For at most', value: p.maxPeriods ? `${p.maxPeriods} months` : 'Until you cancel' },
            { label: 'Cancel', value: 'Anytime, in one click' },
          ],
        },
        typedData('Settle Subscription', SUBSCRIPTIONS, 'Mandate', {
          plan: p.id,
          merchant: s.merchant.address,
          amountCap: p.amountMinor.toString(),
          periodSeconds: String(p.periodSeconds),
          maxPeriods: String(p.maxPeriods ?? 0),
        }),
      );
    },
    async submitSubscribe(token, signature) {
      const viewer = await asCustomer();
      const s = await current();
      const { planId } = consume(s, viewer, 'subscribe', token, signature);
      if (planArchived(s, planId))
        throw new DataError('plan_archived', 'This plan is no longer offered.', 410);
      const sub = subscribe(s, customerRecord(s, viewer.userId), planRecord(s, planId));
      return { subscriptionId: sub.id };
    },
  },

  demo: {
    async state() {
      const s = await current();
      return { now: iso(now(s)), offsetDays: s.clock.offsetDays };
    },
    async advance(days) {
      const s = await store();
      s.clock.base += days * DAY;
      s.clock.offsetDays += days;
      tick(s);
      return { now: iso(now(s)), offsetDays: s.clock.offsetDays };
    },
    async reset() {
      const s = await resetStore();
      return { now: iso(now(s)), offsetDays: s.clock.offsetDays };
    },
    async viewers() {
      return MOCK_VIEWERS;
    },
    async transaction(hash) {
      const s = await current();
      // Funding, routed repayments, defaults, buy-backs, transfers and registry changes.
      const financed = financingTransaction(s, hash);
      if (financed) return financed;
      const lower = hash.toLowerCase();
      const gas = s.relayed.find(g => g.txHash.toLowerCase() === lower);
      const entry = s.accounting.find(e => e.txHash?.toLowerCase() === lower);
      const networkFee = s.accounting.find(e => e.type === 'Fee' && e.txHash?.toLowerCase() === lower);
      const refused = s.refusals.find(r => r.txHash?.toLowerCase() === lower);
      const ack = s.invoices.find(i => i.acknowledgement?.txHash?.toLowerCase() === lower);
      if (!gas && !entry && !refused) return null;
      const at = gas?.createdAt ?? refused?.createdAt ?? (entry ? iso(entry.at) : iso(now(s)));
      const block = String(11_930_519 + Math.floor((new Date(at).getTime() - Date.UTC(2026, 10, 1)) / 1000));
      const payer = entry
        ? (s.customers.find(c => c.email === entry.customer)?.address ??
          s.agents.find(a => a.session.name === entry.customer)?.session.account ??
          s.merchant.address)
        : (gas?.payer ?? s.merchant.address);
      const transfers: ExplorerTx['transfers'] = [];
      const financing = entry?.type.startsWith('Financing') ?? false;
      if (entry && !financing && entry.grossMinor > 0n) {
        transfers.push({
          from: payer,
          to: s.merchant.address,
          amountMinor: (entry.grossMinor - entry.feeMinor).toString(),
          label: 'To merchant',
        });
        if (entry.feeMinor > 0n)
          transfers.push({
            from: payer,
            to: '0x5e3f…fee',
            amountMinor: entry.feeMinor.toString(),
            label: 'Pact fee',
          });
      }
      if (entry && !financing && entry.grossMinor < 0n)
        transfers.push({
          from: s.merchant.address,
          to: s.customers.find(c => c.email === entry.customer)?.address ?? payer,
          amountMinor: (-entry.grossMinor).toString(),
          label: 'Refund to customer',
        });
      if (networkFee)
        transfers.push({
          from: s.merchant.address,
          to: '0x5e3f…fee',
          amountMinor: networkFee.feeMinor.toString(),
          label: 'Network fee, in USDT',
        });
      const events: ExplorerTx['events'] = [];
      if (gas)
        events.push(
          {
            name: 'Executed',
            detail: `Router executed a sponsored ${gas.action.replaceAll('_', ' ')} for ${gas.label}`,
          },
          networkFee
            ? { name: 'GasCharged', detail: `The Router took the refund's network fee from ${s.merchant.name} in USDT` }
            : { name: 'Sponsored', detail: 'Pact’s relayer paid the gas' },
        );
      if (entry?.type === 'Payment' || entry?.type === 'Invoice')
        events.push({ name: 'Charged', detail: `PaymentEscrow captured ${dec6(entry.grossMinor)} USDT` });
      if (entry?.type === 'Refund')
        events.push({
          name: 'Refunded',
          detail: `PaymentEscrow refunded ${dec6(-entry.grossMinor)} USDT against ${entry.refundOf}`,
        });
      if (entry?.type === 'Subscription')
        events.push({
          name: 'Charged',
          detail: 'SubscriptionManager pulled one period within the signed cap',
        });
      if (entry?.type === 'Agent payment')
        events.push({ name: 'PaymentSettled', detail: 'x402 payment settled through Permit2' });
      if (ack)
        events.push({ name: 'Acknowledged', detail: `${ack.customerName} acknowledged ${ack.number}` });
      if (refused) events.push({ name: 'Refused', detail: `${refused.reason}: ${refused.detail}` });
      return {
        hash,
        status: refused ? 'refused' : 'success',
        block,
        at,
        method: refused
          ? refused.source === 'subscription'
            ? 'charge (refused)'
            : 'execute (refused)'
          : entry?.type === 'Refund'
            ? 'refund'
            : entry?.type === 'Subscription'
              ? 'charge'
              : entry?.type === 'Agent payment'
                ? 'settle'
                : 'execute',
        summary: refused ? refused.detail : (gas?.label ?? entry?.type ?? 'Transaction'),
        from: '0x9b2c…relayer',
        to: entry?.type === 'Subscription' ? SUBSCRIPTIONS : ROUTER,
        transfers,
        gasWei: gas?.gasWei ?? '0',
        gasPaidBy: refused
          ? 'Nobody: refused before it was sent'
          : networkFee
            ? `Pact relayer, charged to ${s.merchant.name} in USDT`
            : 'Pact relayer',
        events,
      };
    },
  },
};

/** Each visitor's sandbox, with the review scenario (mock/lab.ts) applied to every read. */
export const mockSource: DataSource = sandboxed<DataSource>(withScenario<DataSource>(source));

export { DEMO, HOUR, reasonDetail };
