import 'server-only';
import { randomBytes } from 'node:crypto';
import type {
  DashboardSummary,
  ExportReport,
  FeePreview,
  MerchantSettings,
  WebhookDelivery,
  WebhookEvent,
} from '@pactagent/core/api-types';
import type { Customer, Order, Product } from '@pactagent/core/commerce-types';
import type {
  DrainRun,
  GasLedgerEntry,
  GasTankDetail,
  OrderListItem,
  PlanSummary,
  RefusalEvent,
  SecurityLayer,
} from '@pactagent/core/platform-types';
import { reasonDetail } from '@/lib/reasons';
import { merchantApi, publicApi, sessionApi, SessionError } from '../../api-client';
import { DataError, NotWiredError } from '../errors';
import type { CheckoutState, DataSource, MerchantPreferences, NotificationPreferences, OrderDetail, SignRequest } from '../types';
import { createApiCommerce, type ApiManualOrder } from './commerce-extras';
import { createApiFinancing } from './financing';
import { createApiSubscriptions } from './subscriptions';
import { createApiInvoices } from './invoices';
import { createApiAgents } from './agents';
import { hold, peek, take } from './pending';

/**
 * Reads and writes through the Pact API with the visitor's session.
 * Screens whose endpoints do not exist yet throw NotWiredError.
 */

type ApiOrderDetail = {
  order: Order;
  product: Product;
  brand: { brandName: string; logoUrl: string | null; refundWindowSeconds: number };
  payment: {
    txHash: string | null;
    financialStatus: string;
    refundDeadline: string | null;
    feeMinor?: string | null;
    gasWei?: string | null;
    payer?: string | null;
  } | null;
  refunds: Array<{
    id: string;
    amountMinor: string;
    reason?: string | null;
    status: string;
    txHash: string | null;
    createdAt: string;
  }>;
  events: Array<{ type: string; sourceId: string; createdAt: string }>;
};

const refusalMessages: Record<string, string> = {
  checkout_field_required: 'Answer the required questions to continue.',
  telegram_unavailable: 'Telegram is not set up.',
  invalid_metadata: 'Check your answers and try again.',
  discount_invalid: 'That discount code is not valid here.',
  discount_expired: 'That discount code has expired or has not started yet.',
  discount_exhausted: 'That discount code has reached its limit.',
  discount_below_minimum: 'This discount brings the price below the 1.00 USDT minimum.',
};
const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
  try {
    return await sessionApi<T>(path, init);
  } catch (error) {
    if (error instanceof SessionError)
      throw new DataError(error.code, refusalMessages[error.code] ?? error.code.replaceAll('_', ' '), error.status);
    throw error;
  }
};
const post = <T>(path: string, body: unknown, method = 'POST') =>
  api<T>(path, { method, body: JSON.stringify(body) });
/** Merchant screens use the merchant's wallet session; customer and checkout screens the customer's. */
const mApi = async <T>(path: string, init?: RequestInit): Promise<T> => {
  try {
    return await merchantApi<T>(path, init);
  } catch (error) {
    if (error instanceof SessionError && error.code === 'telegram_unavailable')
      throw new DataError(error.code, 'Telegram is not set up.', error.status);
    if (error instanceof SessionError && error.code === 'invalid_notification_preferences')
      throw new DataError(error.code, 'Enter a valid email address.', error.status);
    if (error instanceof SessionError && error.code === 'invalid_checkout_fields')
      throw new DataError(error.code, 'Each checkout field needs a question of up to 120 characters.', error.status);
    if (error instanceof SessionError && error.code === 'discount_invalid')
      throw new DataError(error.code, 'Check the code, value and dates. Each code must be unique.', error.status);
    if (error instanceof SessionError)
      throw new DataError(error.code, error.code.replaceAll('_', ' '), error.status);
    throw error;
  }
};
const mPost = <T>(path: string, body: unknown, method = 'POST') =>
  mApi<T>(path, { method, body: JSON.stringify(body) });

function toDetail(
  detail: ApiOrderDetail,
  contact?: { email: string | null; name: string | null; refunded?: bigint },
): OrderDetail {
  const confirmed = detail.refunds
    .filter(r => r.status !== 'failed')
    .reduce((sum, r) => sum + BigInt(r.amountMinor), 0n);
  return {
    order: detail.order,
    product: detail.product,
    customer: {
      id: detail.order.customerId,
      name: contact?.name ?? null,
      email: contact?.email ?? null,
      company: null,
    },
    merchantName: detail.brand.brandName || 'This business',
    payment: detail.order.paymentId
      ? {
          id: detail.order.paymentId,
          txHash: detail.payment?.txHash ?? null,
          feeMinor: detail.payment?.feeMinor ?? '0',
          gasWei: detail.payment?.gasWei ?? '0',
          payer: (detail.payment?.payer as `0x${string}` | null | undefined) ?? null,
        }
      : null,
    refunds: detail.refunds.map(r => ({
      id: r.id,
      amountMinor: r.amountMinor,
      reason: r.reason ?? '',
      status: r.status === 'succeeded' ? 'succeeded' : r.status === 'failed' ? 'failed' : 'pending',
      txHash: r.txHash,
      createdAt: r.createdAt,
    })),
    refusals: [],
    activity: detail.events.map(e => ({
      type: e.type,
      at: e.createdAt,
      detail: e.type.replace('order.', '').replaceAll('_', ' '),
      txHash: null,
    })),
    refundWindowEndsAt: detail.payment?.refundDeadline ?? null,
    refundableMinor: ['paid', 'partially_refunded'].includes(detail.order.status)
      ? (BigInt(detail.order.total.amountMinor) - confirmed).toString()
      : '0',
  };
}

const listItem = (order: Order): OrderListItem => ({ ...order, customerEmail: null, customerName: null });
type ApiKeyRow = {
  id: string;
  name: string;
  kind: 'publishable' | 'secret';
  createdAt: string;
  revokedAt: string | null;
};
/** The key itself is shown once at creation; afterwards only its kind and name. */
const keyView = (k: ApiKeyRow) => ({
  id: k.id,
  name: k.name || (k.kind === 'secret' ? 'Secret key' : 'Publishable key'),
  kind: k.kind,
  preview: `${k.kind === 'secret' ? 'sk' : 'pk'}_test_…`,
  createdAt: k.createdAt,
  lastUsedAt: null,
  revokedAt: k.revokedAt,
});

/** Product checkouts are checkout sessions; invoice and other hosted payments use `hp_<paymentId>`. */
const HOSTED = 'hp_';
/** What a payer is told when the API will not start a payment for an invoice. */
const INVOICE_START_ERRORS: Record<string, string> = {
  invoice_payment_in_progress:
    'A payment you started for this invoice is still processing. Try again in a few minutes.',
  invoice_payment_limit: 'That is more than is left to pay on this invoice.',
  invoice_partial_disabled: 'This invoice has to be paid in full.',
  invoice_not_payable: 'This invoice cannot be paid right now.',
};
const sessionBase = (sessionId: string) =>
  sessionId.startsWith(HOSTED)
    ? `/v1/commerce/me/payments/${encodeURIComponent(sessionId.slice(HOSTED.length))}`
    : `/v1/commerce/checkout-sessions/${encodeURIComponent(sessionId)}`;

type Readiness = {
  status: 'needs_funding' | 'needs_approval' | 'ready' | 'pending' | 'unavailable';
  reason?: string;
  message: string | null;
  approvalNonce: string | null;
  authorizationNonce: string | null;
  deadline: string | null;
  authorizationRequired: boolean;
  delegate: string;
};
/** The relayed approval confirms within a few blocks; the payment can only be prepared after it. */
async function waitUntilReady(base: string, seconds = 45): Promise<Readiness> {
  for (let i = 0; i < seconds; i++) {
    const readiness = await api<Readiness>(`${base}/readiness`);
    if (readiness.status === 'ready') return readiness;
    if (readiness.status !== 'pending' && readiness.status !== 'needs_approval')
      throw new DataError(readiness.reason ?? readiness.status, 'The approval did not go through.', 409);
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new DataError('approval_pending', 'The approval is still confirming. Try again in a moment.', 409);
}
async function paymentRequest(sessionId: string, _ready: Readiness): Promise<SignRequest> {
  const request = await api<{
    data: string;
    intent: Record<string, unknown>;
    typedData: Record<string, unknown>;
  }>(`${sessionBase(sessionId)}/intent`);
  return hold(
    'payment',
    { sessionId, data: request.data, intent: request.intent },
    { title: 'Confirm payment', lines: [], typedData: request.typedData },
  );
}

async function hostedSession(id: string): Promise<CheckoutState> {
  const base = sessionBase(id);
  const [p, readiness] = await Promise.all([
    api<{
      id: string;
      amountMinor: string;
      description: string;
      status: string;
      txHash: string | null;
      createdAt: string;
      expiresAt: string | null;
      invoiceId: string | null;
      discountCode?: string | null;
      amountGross?: string | null;
      amountDiscount?: string | null;
      brand: { brandName: string; logoUrl: string | null };
      merchant: string;
    }>(base),
    api<{ status: string; balance: string | null }>(`${base}/readiness`).catch(() => null),
  ]);
  const paid = ['captured', 'partially_refunded', 'refunded'].includes(p.status);
  return {
    id,
    kind: p.invoiceId ? 'invoice' : 'product',
    status: paid ? 'paid' : p.status === 'failed' ? 'failed' : p.status === 'expired' ? 'expired' : 'open',
    description: p.description,
    detail: null,
    total: { currency: 'USDT', amountMinor: p.amountMinor },
    discountCode: p.discountCode,
    amountGross: p.amountGross,
    amountDiscount: p.amountDiscount,
    brand: { brandName: p.brand.brandName || 'This business', logoUrl: p.brand.logoUrl },
    productId: null,
    invoiceId: p.invoiceId,
    orderId: null,
    expiresAt: p.expiresAt ?? new Date(Date.now() + 30 * 60_000).toISOString(),
    readiness:
      readiness?.status === 'needs_funding'
        ? 'needs_funds'
        : readiness?.status === 'unavailable' || !readiness
          ? 'unavailable'
          : 'ready',
    balanceMinor: readiness?.balance ?? null,
    failure: null,
    receipt: paid ? { paidAt: p.createdAt, txHash: p.txHash } : null,
    advanced: {
      network: 'Whitechain Sepolia (chain 1874)',
      payerAccount: null,
      merchantAccount: p.merchant,
      gasPaidBy: p.brand.brandName ? `${p.brand.brandName}'s gas tank` : "The business's gas tank",
      gasWei: null,
    },
    methods: [{ kind: 'account' }],
    method: null,
    returnPath: p.invoiceId ? `/invoice/${p.invoiceId}` : null,
  };
}

/** Re-reads until the chain has settled the change (1-second blocks), or gives up and returns the last read. */
async function settled<T>(read: () => Promise<T>, done: (value: T) => boolean, seconds = 30): Promise<T> {
  let value = await read();
  for (let i = 0; i < seconds && !done(value); i++) {
    await new Promise(r => setTimeout(r, 1000));
    value = await read();
  }
  return value;
}

/** Shared with the part sources so they reach the API the same way this file does. */
const kit = { api, post, mApi, mPost, hold, take, peek, settled };
export type ApiKit = typeof kit;

const subscriptionsApi = createApiSubscriptions(kit);
const invoicesApi = createApiInvoices(kit);
const agentsApi = createApiAgents(kit);

export const apiSource: DataSource = {
  mode: 'api',

  commerce: createApiCommerce(kit),
  financing: createApiFinancing(kit),
  lab: null,

  merchant: {
    settings: () => mApi<MerchantSettings>('/v1/settings'),
    updateSettings: update => mPost<MerchantSettings>('/v1/settings', update),
    feePreview: () => mApi<FeePreview>('/v1/fees/preview'),
    async overview() {
      const [summary, settings] = await Promise.all([
        mApi<DashboardSummary>('/v1/dashboard'),
        mApi<MerchantSettings>('/v1/settings'),
      ]);
      return {
        summary,
        onboarding: [
          { id: 'account', title: 'Connect your business wallet', done: true },
          { id: 'brand', title: 'Add your business name and logo', done: Boolean(settings.brandName) },
          {
            id: 'gas',
            title: 'Fund your gas tank',
            done: summary.gasTank.available && BigInt(summary.gasTank.balanceWei ?? '0') > 0n,
          },
          { id: 'integrate', title: 'Add checkout to your store', done: settings.webhook.configured },
          { id: 'test_payment', title: 'Take a test payment', done: summary.metrics.successfulPayments > 0 },
        ],
        activity: summary.recentActivity.map(e => ({
          id: e.id,
          at: e.createdAt,
          title: e.type.replaceAll('.', ' ').replaceAll('_', ' '),
          detail: e.reason?.replaceAll('_', ' ') ?? e.objectId,
          tone: e.reason ? 'warning' : 'default',
          href: null,
        })),
      };
    },

    products: async () => (await mApi<{ data: Product[] }>('/v1/commerce/products?limit=100')).data,
    product: id => mApi<Product>(`/v1/commerce/products/${encodeURIComponent(id)}`),
    createProduct: input =>
      mPost<Product>('/v1/commerce/products', {
        name: input.name,
        description: input.description,
        status: input.status,
        prices: [{ currency: 'USDT', amountMinor: input.priceMinor }],
        ...(input.checkoutFields?.length ? { checkoutFields: input.checkoutFields } : {}),
      }),
    updateProduct: (id, { priceMinor, ...input }) =>
      mPost<Product>(
        `/v1/commerce/products/${encodeURIComponent(id)}`,
        {
          ...input,
          ...(priceMinor ? { prices: [{ currency: 'USDT', amountMinor: priceMinor }] } : {}),
        },
        'PATCH',
      ),

    orders: async filter => {
      const query = new URLSearchParams({
        limit: '100',
        ...(filter?.customerId ? { customerId: filter.customerId } : {}),
      });
      const [{ data }, manual] = await Promise.all([
        mApi<{ data: Order[] }>(`/v1/commerce/orders?${query}`),
        // Manual orders are hosted payments; they list alongside product orders.
        mApi<{ data: ApiManualOrder[] }>('/v1/manual-orders').catch(() => ({ data: [] as ApiManualOrder[] })),
      ]);
      const manualItems = manual.data
        .filter(o => !filter?.customerId || o.customerId === filter.customerId)
        .map(o => ({ ...o, customerName: o.customerName, customerEmail: o.customerEmail }) as OrderListItem);
      return [...data.map(listItem), ...manualItems]
        .filter(o => !filter?.status || filter.status === 'all' || o.status === filter.status)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async order(id) {
      if (!id.startsWith('0x'))
        return toDetail(await mApi<ApiOrderDetail>(`/v1/commerce/orders/${encodeURIComponent(id)}`));
      const o = await mApi<
        ApiManualOrder & {
          refunds: Array<{
            id: string;
            amountMinor: string;
            reason: string | null;
            status: string;
            txHash: string | null;
            createdAt: string;
          }>;
          refundDeadline: string | null;
        }
      >(`/v1/manual-orders/${encodeURIComponent(id)}`);
      const settings = await mApi<MerchantSettings>('/v1/settings');
      const refunded = o.refunds
        .filter(r => r.status !== 'failed')
        .reduce((t, r) => t + BigInt(r.amountMinor), 0n);
      return toDetail(
        {
          order: o,
          product: {
            id: '',
            merchantId: o.merchantId,
            name: o.productName,
            description: o.note,
            imageUrl: null,
            status: 'active',
            revision: 0,
            prices: [o.total],
          },
          brand: {
            brandName: settings.brandName,
            logoUrl: settings.logoUrl,
            refundWindowSeconds: settings.refundWindowSeconds,
          },
          payment: { txHash: o.txHash, financialStatus: o.status, refundDeadline: o.refundDeadline },
          refunds: o.refunds.map(r => ({ ...r, reason: r.reason ?? '' })),
          events: [{ type: 'order.created', sourceId: o.id, createdAt: o.createdAt }],
        },
        { email: o.customerEmail, name: o.customerName, refunded },
      );
    },
    async prepareRefund(orderId, amountMinor, reason) {
      const amount = `${BigInt(amountMinor) / 1_000_000n}.${(BigInt(amountMinor) % 1_000_000n).toString().padStart(6, '0')}`;
      const prepared = await mPost<{
        typedData: Record<string, unknown>;
        intent: Record<string, unknown>;
        data: string;
        amount: string;
        reason: string;
        paymentId: string;
      }>(
        // A manual order's id is its payment id.
        orderId.startsWith('0x')
          ? `/v1/payments/${encodeURIComponent(orderId)}/refund-intent`
          : `/v1/commerce/orders/${encodeURIComponent(orderId)}/refund-intent`,
        { amount, reason },
      );
      return hold(
        'refund',
        { orderId, ...prepared },
        {
          title: 'Refund',
          lines: [
            { label: 'Refund', value: `${prepared.amount} USDT` },
            { label: 'Reason', value: prepared.reason },
          ],
          typedData: prepared.typedData,
          signer: 'merchant',
        },
      );
    },
    async submitRefund(token, signature) {
      const held = (await take('refund', token)) as {
        orderId: string;
        paymentId: string;
        intent: unknown;
        data: string;
        amount: string;
        reason: string;
      };
      const before = await apiSource.merchant.order(held.orderId).catch(() => null);
      await mApi(`/v1/payments/${encodeURIComponent(held.paymentId)}/refund`, {
        method: 'POST',
        headers: { 'idempotency-key': token },
        body: JSON.stringify({
          intent: held.intent,
          data: held.data,
          amount: held.amount,
          reason: held.reason,
          signature,
        }),
      });
      // The relayer has sent it; wait for the chain so the screen shows the settled refund.
      return settled(
        () => apiSource.merchant.order(held.orderId),
        o => o.refunds.length > (before?.refunds.length ?? 0) && o.refunds.every(r => r.status !== 'pending'),
      );
    },

    customers: async () =>
      (await mApi<{ data: Customer[] }>('/v1/commerce/customers?limit=100')).data.map(c => ({
        ...c,
        company: null,
        orders: 0,
        spentMinor: '0',
        refundedMinor: '0',
        activeSubscriptions: 0,
        lastActivityAt: null,
      })),
    async customer(id) {
      const detail = await mApi<{ customer: Customer }>(`/v1/commerce/customers/${encodeURIComponent(id)}`);
      const orders = await apiSource.merchant.orders({ customerId: id });
      return {
        customer: {
          ...detail.customer,
          company: null,
          orders: orders.length,
          spentMinor: '0',
          refundedMinor: '0',
          activeSubscriptions: 0,
          lastActivityAt: null,
        },
        orders,
        subscriptions: [],
        invoices: [],
      };
    },

    invoices: invoicesApi.merchant.invoices,
    invoice: invoicesApi.merchant.invoice,
    createInvoice: invoicesApi.merchant.createInvoice,
    sendInvoice: invoicesApi.merchant.sendInvoice,
    remindInvoice: invoicesApi.merchant.remindInvoice,
    plans: subscriptionsApi.merchant.plans,
    createPlan: subscriptionsApi.merchant.createPlan,
    subscriptions: subscriptionsApi.merchant.subscriptions,
    subscription: subscriptionsApi.merchant.subscription,
    runRenewal: subscriptionsApi.merchant.runRenewal,
    async refusals(filter) {
      const { data } = await mApi<{
        data: Array<{
          id: string;
          objectId: string;
          reason: string;
          txHash: string | null;
          createdAt: string;
          source: string | null;
          signer: string | null;
          layer: number | null;
        }>;
      }>(`/v1/refusals?expand=detail&limit=${filter?.limit ?? 100}`);
      const kind = (r: {
        reason: string;
        source: string | null;
        objectId: string;
      }): RefusalEvent['source'] =>
        ['refund_limit', 'refund_window_closed'].includes(r.reason)
          ? 'refund'
          : r.objectId.startsWith('sub_')
            ? 'subscription'
            : r.objectId.startsWith('inv_')
              ? 'invoice'
              : 'sponsorship';
      return data
        .map((r): RefusalEvent => ({
          id: r.id,
          objectId: r.objectId,
          reason: r.reason,
          txHash: r.txHash as `0x${string}` | null,
          createdAt: r.createdAt,
          source: kind(r),
          layer: r.layer,
          detail: reasonDetail(r.reason),
          actor: r.signer,
        }))
        .filter(r => !filter?.source || r.source === filter.source);
    },
    gasTank: () => mApi<GasTankDetail>('/v1/gas-tank'),
    gasLedger: async (limit = 50) =>
      (await mApi<{ data: GasLedgerEntry[] }>(`/v1/gas-tank/ledger?limit=${limit}`)).data,
    updateGasPolicy: update =>
      mPost<GasTankDetail>('/v1/gas-tank/policy', {
        ...(update.mode !== undefined && { mode: update.mode }),
        ...(update.surchargeMinor !== undefined && { surchargeMinor: update.surchargeMinor }),
        ...(update.lowRunwayAlertDays !== undefined && { lowRunwayAlertDays: update.lowRunwayAlertDays }),
      }),
    // The faucet and deposits are transactions from the merchant's own wallet, sent in the browser.
    claimFaucet: () =>
      Promise.reject(
        new DataError('wallet_action', 'Claim WBT to your wallet, then deposit it into the tank.', 400),
      ),
    securityLayers: async () => (await mApi<{ data: SecurityLayer[] }>('/v1/security/layers')).data,
    // A live run against this merchant: every attempt is refused before broadcast; nothing is spent.
    runDrainSimulation: () =>
      mApi<DrainRun>('/v1/security/drain-runs', {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.timeout(60_000),
      }),
    paidEndpoints: agentsApi.merchant.paidEndpoints,
    agentCalls: agentsApi.merchant.agentCalls,
    facilitator: agentsApi.merchant.facilitator,
    apiKeys: async () => (await mApi<{ data: ApiKeyRow[] }>('/v1/api-keys')).data.map(keyView),
    async createApiKey(input) {
      const created = await mPost<{ id: string; kind: 'publishable' | 'secret'; key: string }>(
        '/v1/api-keys',
        { kind: input.kind, name: input.name },
      );
      return {
        key: {
          id: created.id,
          name: input.name,
          kind: created.kind,
          preview: `${created.key.slice(0, 8)}…${created.key.slice(-4)}`,
          createdAt: new Date().toISOString(),
          lastUsedAt: null,
          revokedAt: null,
        },
        secret: created.key,
      };
    },
    async revokeApiKey(id) {
      await mPost(`/v1/api-keys/${encodeURIComponent(id)}/revoke`, {});
      const row = (await mApi<{ data: ApiKeyRow[] }>('/v1/api-keys')).data.find(k => k.id === id);
      if (!row) throw new DataError('not_found', 'API key not found.', 404);
      return keyView(row);
    },

    async webhook() {
      const settings = await mApi<MerchantSettings>('/v1/settings');
      return {
        url: settings.webhook.url,
        configured: settings.webhook.configured,
        eventTypes: [],
        secretPreview: null,
      };
    },
    async configureWebhook(url) {
      const result = await mPost<{ url: string; signingSecret: string }>('/v1/webhooks/config', { url });
      return {
        config: { url: result.url, configured: true, eventTypes: [], secretPreview: null },
        signingSecret: result.signingSecret,
      };
    },
    webhookEvents: async () => (await mApi<{ data: WebhookEvent[] }>('/v1/webhooks/events')).data,
    webhookDeliveries: async () => (await mApi<{ data: WebhookDelivery[] }>('/v1/webhooks/deliveries')).data,
    replayWebhook: async eventId => {
      await mPost(`/v1/webhooks/events/${encodeURIComponent(eventId)}/replay`, {});
    },
    notificationPreferences: () => mApi<NotificationPreferences>('/v1/notifications/preferences'),
    updateNotificationPreferences: input => mPost<NotificationPreferences>('/v1/notifications/preferences', input),
    connectTelegram: () => mPost<{ url: string; expiresAt: string }>('/v1/notifications/telegram/connect', {}),
    disconnectTelegram: async () => {
      await mPost('/v1/notifications/telegram/disconnect', {});
    },
    sendTestWebhook: async () => {
      await mPost('/v1/webhooks/test', {});
    },

    exportReport: range =>
      mApi<ExportReport>(
        `/v1/export?${new URLSearchParams({ ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}), format: 'json' })}`,
      ),

    preferences: () => mApi<MerchantPreferences>('/v1/preferences'),
    updatePreferences: update => mPost<MerchantPreferences>('/v1/preferences', update),
    depositGas: () =>
      Promise.reject(new DataError('wallet_action', 'Deposits are sent from your wallet.', 400)),
    sendReminder: invoicesApi.merchant.sendReminder,
    manualReminders: invoicesApi.merchant.manualReminders,
    cancelReminder: invoicesApi.merchant.cancelReminder,
    simulateRenewalFailure: () => Promise.reject(new NotWiredError('Renewal failure simulation')),
    prepareCancelSubscription: () => Promise.reject(new NotWiredError('Merchant-side cancellation')),
    submitCancelSubscription: () => Promise.reject(new NotWiredError('Merchant-side cancellation')),
  },

  customer: {
    notificationPreferences: () => api<NotificationPreferences>('/v1/commerce/me/notifications/preferences'),
    updateNotificationPreferences: input => post<NotificationPreferences>('/v1/commerce/me/notifications/preferences', input),
    connectTelegram: () => post<{ url: string; expiresAt: string }>('/v1/commerce/me/notifications/telegram/connect', {}),
    disconnectTelegram: async () => {
      await post('/v1/commerce/me/notifications/telegram/disconnect', {});
    },
    async account() {
      const me = await api<{
        address: string;
        email: string | null;
        kind: string;
        balanceMinor: string | null;
      }>('/v1/commerce/me/account');
      const local = process.env.PACT_LOCAL_FORK === '1';
      return {
        name: me.email?.split('@')[0] ?? 'Your account',
        email: me.email ?? '',
        company: null,
        address: me.address as `0x${string}`,
        balanceMinor: me.balanceMinor ?? '0',
        passkeys: me.kind === 'privy' ? 1 : 0,
        // On a local fork the test faucet pays USDT; on testnet the business funds its test customer.
        testFunds: { amountMinor: local ? '25000000' : '0', nextClaimAt: null },
      };
    },
    async claimTestFunds() {
      if (process.env.PACT_LOCAL_FORK !== '1')
        throw new DataError(
          'ask_the_business',
          'On testnet, the business sends test USDT to your account from its setup page.',
          400,
        );
      const me = await api<{ address: string }>('/v1/commerce/me/account');
      await post('/v1/dev/faucet', { address: me.address, usdt: '25' });
      return apiSource.customer.account();
    },
    orders: async () => (await api<{ data: Order[] }>('/v1/commerce/me/orders')).data.map(listItem),
    order: async id =>
      toDetail(await api<ApiOrderDetail>(`/v1/commerce/me/orders/${encodeURIComponent(id)}`)),
    subscriptions: subscriptionsApi.customer.subscriptions,
    subscription: subscriptionsApi.customer.subscription,
    availablePlans: subscriptionsApi.customer.availablePlans,
    prepareCancel: subscriptionsApi.customer.prepareCancel,
    submitCancel: subscriptionsApi.customer.submitCancel,
    prepareChangePlan: subscriptionsApi.customer.prepareChangePlan,
    continueSigned: (token, signature) => subscriptionsApi.continueChange(token, signature),
    submitChangePlan: subscriptionsApi.customer.submitChangePlan,
    invoices: invoicesApi.customer.invoices,
    invoice: invoicesApi.customer.invoice,
    prepareAcknowledge: invoicesApi.customer.prepareAcknowledge,
    submitAcknowledge: invoicesApi.customer.submitAcknowledge,
    ...agentsApi.customer,
  },

  checkout: {
    async invoiceBrand(invoiceId) {
      const brand = await publicApi<{ brandName: string; logoUrl: string | null }>(
        `/v1/commerce/invoices/${encodeURIComponent(invoiceId)}/brand`,
      ).catch(() => ({ brandName: '', logoUrl: null }));
      return { brandName: brand.brandName || 'This business', logoUrl: brand.logoUrl };
    },
    async catalog(productId) {
      const response = await fetch(
        `${process.env.PACT_API_URL ?? 'http://localhost:3001'}/v1/commerce/catalog/${encodeURIComponent(productId)}`,
        { cache: 'no-store', signal: AbortSignal.timeout(8000) },
      );
      if (!response.ok)
        throw new DataError(
          response.status === 404 ? 'not_found' : 'service_unavailable',
          'This product is not available.',
          response.status,
        );
      const body = (await response.json()) as {
        product: Product;
        brand: { brandName: string; logoUrl: string | null };
        rails: string[];
      };
      return {
        product: body.product,
        brand: { brandName: body.brand.brandName || 'This business', logoUrl: body.brand.logoUrl },
        available: body.rails.includes('whitechain'),
      };
    },
    async startProductCheckout(productId, discountCode, metadata) {
      const detail = await api<{ session: { id: string } }>('/v1/commerce/checkout-sessions', {
        method: 'POST',
        headers: { 'idempotency-key': randomBytes(16).toString('hex') },
        body: JSON.stringify({ productId, rail: 'whitechain', ...(discountCode?.trim() && { discountCode: discountCode.trim() }), ...(metadata && Object.keys(metadata).length ? { metadata } : {}) }),
      });
      return { sessionId: detail.session.id };
    },
    async startInvoiceCheckout(invoiceId, amountMinor) {
      try {
        const created = await post<{ paymentId: string }>(
          `/v1/commerce/me/invoices/${encodeURIComponent(invoiceId)}/payments`,
          amountMinor ? { amountMinor } : {},
        );
        return { sessionId: `${HOSTED}${created.paymentId}` };
      } catch (error) {
        const message = error instanceof DataError ? INVOICE_START_ERRORS[error.code] : undefined;
        if (error instanceof DataError && message) throw new DataError(error.code, message, error.status);
        throw error;
      }
    },
    async session(id) {
      if (id.startsWith(HOSTED)) return hostedSession(id);
      const detail = await api<
        ApiOrderDetail & { session: { id: string; status: string; expiresAt: string } }
      >(`/v1/commerce/checkout-sessions/${encodeURIComponent(id)}`);
      const readiness = await api<{ status: string; balance: string | null }>(
        `/v1/commerce/checkout-sessions/${encodeURIComponent(id)}/readiness`,
      ).catch(() => null);
      const paid = ['paid', 'partially_refunded', 'refunded'].includes(detail.order.status);
      const state: CheckoutState = {
        id,
        kind: 'product',
        status: paid
          ? 'paid'
          : detail.order.status === 'pending'
            ? 'pending'
            : detail.order.status === 'expired'
              ? 'expired'
              : detail.order.status === 'failed'
                ? 'failed'
                : 'open',
        description: detail.order.productName,
        detail: detail.product.description,
        total: detail.order.total,
        discountCode: detail.order.discountCode,
        amountGross: detail.order.amountGross,
        amountDiscount: detail.order.amountDiscount,
        metadata: detail.order.metadata,
        brand: { brandName: detail.brand.brandName || 'This business', logoUrl: detail.brand.logoUrl },
        productId: detail.order.productId,
        invoiceId: null,
        orderId: detail.order.id,
        expiresAt: detail.session.expiresAt,
        readiness:
          readiness?.status === 'needs_funding'
            ? 'needs_funds'
            : readiness?.status === 'unavailable' || !readiness
              ? 'unavailable'
              : 'ready',
        balanceMinor: readiness?.balance ?? null,
        failure: null,
        receipt: paid ? { paidAt: detail.order.createdAt, txHash: detail.payment?.txHash ?? null } : null,
        advanced: {
          network: 'Whitechain Sepolia (chain 1874)',
          payerAccount: null,
          merchantAccount: '',
          gasPaidBy: detail.brand.brandName
            ? `${detail.brand.brandName}'s gas tank`
            : "The business's gas tank",
          gasWei: null,
        },
        // The API settles from the payer's Pact account only; card, bank and own wallet are demo-only.
        methods: [{ kind: 'account' }],
        method: null,
        returnPath: detail.order.productId ? `/buy/${detail.order.productId}` : null,
      };
      return state;
    },
    async preparePayment(sessionId) {
      const base = sessionBase(sessionId);
      const readiness = await api<Readiness>(`${base}/readiness`);
      if (readiness.status === 'needs_approval') {
        // First payment from this account: a one-time USDT approval, relayed for free, then the payment.
        if (!readiness.message || readiness.approvalNonce === null || !readiness.deadline)
          throw new DataError('approval_unavailable', 'Payment is not ready yet.', 409);
        return hold(
          'payment-approval',
          { sessionId, approvalNonce: readiness.approvalNonce, deadline: readiness.deadline },
          {
            title: 'Confirm payment',
            lines: [],
            typedData: {},
            approval: {
              message: readiness.message,
              delegate: readiness.authorizationRequired ? readiness.delegate : null,
              nonce:
                readiness.authorizationRequired && readiness.authorizationNonce !== null
                  ? Number(readiness.authorizationNonce)
                  : null,
            },
          },
        );
      }
      if (readiness.status === 'pending') return paymentRequest(sessionId, await waitUntilReady(base));
      if (readiness.status === 'needs_funding')
        throw new DataError('needs_funds', 'Your balance is too low for this payment.', 409);
      if (readiness.status !== 'ready')
        throw new DataError(readiness.reason ?? readiness.status, 'Payment is not available right now.', 409);
      return paymentRequest(sessionId, readiness);
    },
    async submitApproval(token, approval) {
      const kind = await peek(token);
      if (kind === 'subscribe-approval') return subscriptionsApi.submitSubscribeApproval(token, approval);
      if (kind === 'change-approval') return subscriptionsApi.submitChangeApproval(token, approval);
      const held = (await take('payment-approval', token)) as {
        sessionId: string;
        approvalNonce: string;
        deadline: string;
      };
      const base = sessionBase(held.sessionId);
      await post(`${base}/approval`, {
        approvalNonce: held.approvalNonce,
        deadline: held.deadline,
        signature: approval.signature,
        ...(approval.authorization && { authorization: approval.authorization }),
      });
      return paymentRequest(held.sessionId, await waitUntilReady(base));
    },
    async submitPayment(token, signature) {
      const held = (await take('payment', token)) as { sessionId: string; data: string; intent: unknown };
      await post(`${sessionBase(held.sessionId)}/intent`, {
        data: held.data,
        intent: held.intent,
        signature,
      });
      return settled(
        () => apiSource.checkout.session(held.sessionId),
        state => state.status === 'paid' || state.status === 'failed',
      );
    },
    payByCard: () => Promise.reject(new NotWiredError('Card payments')),
    confirmTransfer: () => Promise.reject(new NotWiredError('Bank and own-wallet transfers')),
    // The plans of the businesses this customer subscribes to, for a plan change.
    plans: async () => (await api<{ data: PlanSummary[] }>('/v1/commerce/me/plans')).data,
    planOffer: subscriptionsApi.checkout.planOffer,
    prepareSubscribe: subscriptionsApi.checkout.prepareSubscribe,
    submitSubscribe: subscriptionsApi.checkout.submitSubscribe,
  },

  demo: null,
};
