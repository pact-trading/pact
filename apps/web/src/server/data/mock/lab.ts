import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { WebhookDelivery, WebhookEvent } from '@pactagent/core/api-types';
import { usd } from '@/lib/format';
import { getViewer } from '../../viewer';
import { DataError, notFound } from '../errors';
import {
  isScenario,
  type LabData,
  type ScenarioId,
  type StoreOrderView,
  type WebhookOutcome,
} from '../parts/lab';
import { agentCall, reminderSchedule, tick } from './engine';
import type { MockKit } from './source';
import { dayKey, hooks, HOUR, iso, now, store, type MockStore, type OrderRecord } from './store';

// These match DEMO in fixtures.ts, which imports this file, so they are repeated here.
const SHOPPER = 'cus_acme';
const STORY_INVOICE = 'inv_1042';
const STORY_AGENT = 'agt_research';
/** Jordan bought this through the store in the seeded story. */
const SEEDED_STORE_PRODUCT = 'prod_toolkit';

/** The store's endpoint receives an order's `order.paid` delivery this long after the payment. */
const STORE_DELIVERY_MS = 5_000;
/** A failed attempt is sent again after this long, like the API's backoff. */
const RETRY_MS = 60_000;
/** After this many attempts Pact stops retrying. */
const MAX_ATTEMPTS = 8;
/** A queued test event waits this long for a simulated answer before Pact sends it itself. */
const TEST_EVENT_MS = 10 * 60_000;
/** The `loading` scenario's wait on every read. */
const READ_DELAY_MS = 1_500;

// ------------------------------------------------------------------ state

export interface StoreOrderRecord {
  orderId: string;
  /** The Pact checkout the store opened; null for the seeded order. */
  sessionId: string | null;
  createdAt: number;
  fulfilledAt: number | null;
  /** The event whose first delivery fulfilled the order. */
  fulfilledBy: string | null;
}

/** One row of the store's dedupe table: an event id it has handled. */
export interface ReceivedEvent {
  eventId: string;
  orderId: string;
  at: number;
  duplicates: number;
}

/** Demo lab records kept in each visitor's sandbox. */
export interface LabState {
  scenario: ScenarioId;
  storeOrders: StoreOrderRecord[];
  received: ReceivedEvent[];
  /** Delivery attempts the store has already handled, so each attempt is handled once. */
  processed: string[];
}

const blank = (): LabState => ({ scenario: 'happy', storeOrders: [], received: [], processed: [] });

/** False while the story is being seeded, before seedLab() has run. */
const ready = (s: MockStore) => Array.isArray((s.lab as Partial<LabState> | undefined)?.processed);

function lab(s: MockStore): LabState {
  if (!ready(s)) s.lab = { ...blank(), ...(s.lab as Partial<LabState> | undefined) };
  return s.lab;
}

export function seedLab(s: MockStore): LabState {
  const state = blank();
  // Jordan bought the Component toolkit through the Kite Labs store five days ago; the
  // order.paid delivery reached the store, which fulfilled it once.
  const record = s.orders.find(
    o => o.order.customerId === SHOPPER && o.order.productId === SEEDED_STORE_PRODUCT && o.paidAt !== null,
  );
  if (!record) return state;
  const order: StoreOrderRecord = {
    orderId: record.order.id,
    sessionId: null,
    createdAt: Date.parse(record.order.createdAt),
    fulfilledAt: null,
    fulfilledBy: null,
  };
  state.storeOrders.push(order);
  const event = s.webhookEvents.find(e => e.type === 'order.paid' && e.object_id === order.orderId);
  const delivered = event
    ? s.webhookDeliveries.filter(d => d.event_id === event.id && d.status === 'delivered')
    : [];
  if (event && delivered.length) {
    const first = delivered[delivered.length - 1];
    const at = Date.parse(first.delivered_at ?? event.created_at);
    state.received.push({ eventId: event.id, orderId: order.orderId, at, duplicates: delivered.length - 1 });
    state.processed.push(...delivered.map(d => d.id));
    order.fulfilledAt = at;
    order.fulfilledBy = event.id;
  }
  return state;
}

// --------------------------------------------------------------- webhooks

function answer(s: MockStore, delivery: WebhookDelivery, status: 'delivered' | 'failed') {
  const at = now(s);
  delivery.status = status;
  delivery.last_http_status = status === 'delivered' ? 200 : 503;
  delivery.last_error = status === 'delivered' ? null : 'Service unavailable';
  delivery.delivered_at = status === 'delivered' ? iso(at) : null;
  delivery.next_at = iso(status === 'failed' ? at + RETRY_MS : at);
}

/** A new attempt for an event, answered at once. */
function sendAgain(s: MockStore, previous: WebhookDelivery, status: 'delivered' | 'failed') {
  const delivery: WebhookDelivery = {
    id: s.ids.next('dlv', 7000),
    event_id: previous.event_id,
    attempt: previous.attempt + 1,
    status: 'pending',
    next_at: iso(now(s)),
    last_http_status: null,
    last_error: null,
    delivered_at: null,
  };
  answer(s, delivery, status);
  s.webhookDeliveries.unshift(delivery);
  return delivery;
}

/** The newest attempt of an event; deliveries are kept newest first. */
const latest = (s: MockStore, eventId: string) => s.webhookDeliveries.find(d => d.event_id === eventId);

/**
 * The demo store's webhook handler, like examples/merchant-store/fulfillment.ts: it dedupes by
 * event id, and a unique order id means an order is fulfilled at most once.
 */
function receive(s: MockStore, state: LabState, eventId: string, orderId: string): 'fulfilled' | 'ignored' {
  const seen = state.received.find(r => r.eventId === eventId);
  if (seen) {
    seen.duplicates += 1;
    return 'ignored';
  }
  state.received.push({ eventId, orderId, at: now(s), duplicates: 0 });
  const order = state.storeOrders.find(o => o.orderId === orderId);
  if (!order || order.fulfilledAt !== null) return 'ignored';
  order.fulfilledAt = now(s);
  order.fulfilledBy = eventId;
  return 'fulfilled';
}

/** Hands every delivered `order.paid` attempt for a store order to the store's handler, once. */
function handleStoreDeliveries(s: MockStore): Map<string, 'fulfilled' | 'ignored'> {
  const results = new Map<string, 'fulfilled' | 'ignored'>();
  const state = lab(s);
  if (!state.storeOrders.length) return results;
  const orders = new Set(state.storeOrders.map(o => o.orderId));
  const events = new Map<string, string>();
  for (const e of s.webhookEvents)
    if (e.type === 'order.paid' && orders.has(e.object_id)) events.set(e.id, e.object_id);
  if (!events.size) return results;
  const handled = new Set(state.processed);
  // Oldest first, so the first delivery fulfils and any later one is the duplicate.
  for (let i = s.webhookDeliveries.length - 1; i >= 0; i--) {
    const d = s.webhookDeliveries[i];
    const orderId = events.get(d.event_id);
    if (d.status !== 'delivered' || !orderId || handled.has(d.id)) continue;
    handled.add(d.id);
    state.processed.push(d.id);
    results.set(d.event_id, receive(s, state, d.event_id, orderId));
  }
  return results;
}

/** Pact's delivery queue: due attempts are sent, and failed ones are retried after the backoff. */
function runQueue(s: MockStore) {
  const at = now(s);
  const newest = new Map<string, WebhookDelivery>();
  for (const d of s.webhookDeliveries) if (!newest.has(d.event_id)) newest.set(d.event_id, d);
  for (const d of newest.values()) {
    if (Date.parse(d.next_at) > at) continue;
    if (d.status === 'pending') answer(s, d, 'delivered');
    else if (d.status === 'failed' && d.attempt < MAX_ATTEMPTS) sendAgain(s, d, 'delivered');
  }
  handleStoreDeliveries(s);
}

function expireOpenCheckouts(s: MockStore) {
  const at = now(s);
  let count = 0;
  for (const checkout of s.checkouts) {
    if (checkout.status !== 'open') continue;
    checkout.status = 'expired';
    checkout.expiresAt = Math.min(checkout.expiresAt, at);
    count += 1;
  }
  return count;
}

// Registered once at module load; both skip while the story is being seeded.
hooks.tick.push(s => {
  if (!ready(s)) return;
  runQueue(s);
  if (s.lab.scenario === 'expired') expireOpenCheckouts(s);
});
hooks.orderPaid.push((s, record) => {
  if (!ready(s) || !s.lab.storeOrders.some(o => o.orderId === record.order.id)) return;
  const event = s.webhookEvents.find(e => e.type === 'order.paid' && e.object_id === record.order.id);
  const delivery = event && latest(s, event.id);
  // Pact queues the delivery; the store's endpoint receives it a few seconds after the payment.
  if (delivery && delivery.status === 'delivered') {
    delivery.status = 'pending';
    delivery.last_http_status = null;
    delivery.delivered_at = null;
    delivery.next_at = iso(now(s) + STORE_DELIVERY_MS);
  }
});

// -------------------------------------------------------------- scenarios

const unpaid = (status: string) => ['sent', 'acknowledged', 'partially_paid'].includes(status);

/** Changes the sandbox for a `data` scenario. Returns what changed, in plain words. */
function applyScenario(s: MockStore, id: ScenarioId): string | null {
  const at = now(s);
  switch (id) {
    case 'insufficient-funds': {
      const c = s.customers.find(item => item.id === SHOPPER);
      if (!c) return null;
      c.balanceMinor = 0n;
      // So "Add funds" works straight away.
      c.testFundsClaimedAt = null;
      return `${c.name}’s balance is now $0.00.`;
    }
    case 'terms-unsigned':
      // As a merchant that never signed: no terms, no refund permits.
      s.fees.acceptedVersion = 0;
      s.fees.permits = { escrow: false, router: false };
      return `${s.merchant.name} has not signed Pact’s fee terms yet.`;
    case 'expired': {
      const count = expireOpenCheckouts(s);
      return count
        ? `${count} open checkout${count === 1 ? '' : 's'} expired. New ones expire as soon as they open.`
        : 'New checkouts expire as soon as they open.';
    }
    case 'overdue': {
      const record =
        s.invoices.find(i => i.invoice.id === STORY_INVOICE && unpaid(i.invoice.status)) ??
        s.invoices.find(i => unpaid(i.invoice.status));
      if (!record) return 'No unpaid invoice is left to move past due.';
      const due = at - HOUR;
      record.invoice.dueAt = iso(due);
      // The due date moved into the past, so the reminders before it no longer apply.
      record.reminders = [
        ...record.reminders.filter(r => r.sentAt !== null),
        ...reminderSchedule(due).filter(r => r.stage === 'overdue'),
      ];
      return `${record.number} was due an hour ago and is now overdue.`;
    }
    case 'renewal-failed': {
      const sub =
        s.subscriptions.find(item => item.customerId === SHOPPER && item.status === 'active') ??
        s.subscriptions
          .filter(item => item.status === 'active')
          .sort((a, b) => a.nextChargeAt - b.nextChargeAt)[0];
      const plan = sub && s.plans.find(p => p.id === sub.planId);
      const c = sub && s.customers.find(item => item.id === sub.customerId);
      if (!sub || !plan || !c) return 'No active subscription is left to renew.';
      if (plan.maxPeriods !== null && sub.periodsCharged >= plan.maxPeriods)
        return `${c.name}’s ${plan.name} has no renewals left.`;
      c.balanceMinor = 0n;
      c.testFundsClaimedAt = null;
      // The keeper pulls the renewal now; the contract refuses it and schedules a retry.
      sub.nextChargeAt = at;
      tick(s);
      return `${c.name}’s balance dropped to $0.00, so the ${plan.name} renewal was refused and a retry is scheduled.`;
    }
    case 'cap-reached': {
      const agent = s.agents.find(a => a.session.id === STORY_AGENT && a.session.status === 'active');
      const endpoint = s.endpoints.find(e => e.scheme === 'exact') ?? s.endpoints[0];
      if (!agent || !endpoint) return 'The research agent is not active.';
      const today = dayKey(at);
      const cap = BigInt(agent.session.dailyCapMinor);
      const price = BigInt(endpoint.priceMinor);
      let calls = 0;
      // Real paid calls, settled like any other, until the next one would pass the cap.
      while ((agent.spentByDay[today] ?? 0n) + price <= cap && calls < 100) {
        calls += 1;
        const call = agentCall(s, agent, endpoint, s.merchant, `${endpoint.path}?invoice=INV-1042`);
        if (call.status !== 'settled') break;
      }
      return `The research agent has spent its ${usd(cap)} daily cap${calls ? ` after ${calls} paid call${calls === 1 ? '' : 's'}` : ''}; its next call is refused.`;
    }
    default:
      return null;
  }
}

// ------------------------------------------------------------- storefront

function storeOrderView(s: MockStore, record: StoreOrderRecord, order: OrderRecord): StoreOrderView {
  const state = lab(s);
  const checkout = record.sessionId ? s.checkouts.find(c => c.id === record.sessionId) : undefined;
  const event = s.webhookEvents.find(e => e.type === 'order.paid' && e.object_id === record.orderId);
  const receipt = event && state.received.find(r => r.eventId === event.id);
  return {
    orderId: record.orderId,
    sessionId: record.sessionId,
    productId: order.order.productId,
    productName: order.order.productName,
    amountMinor: order.order.total.amountMinor,
    orderStatus: order.order.status,
    checkoutStatus: checkout?.status ?? null,
    createdAt: iso(record.createdAt),
    paidAt: order.paidAt ? iso(order.paidAt) : null,
    webhook: {
      configured: s.merchant.settings.webhook.configured,
      event: event ? { ...event } : null,
      deliveries: event ? s.webhookDeliveries.filter(d => d.event_id === event.id).map(d => ({ ...d })) : [],
    },
    fulfilment: {
      fulfilledAt: record.fulfilledAt === null ? null : iso(record.fulfilledAt),
      count: record.fulfilledAt === null ? 0 : 1,
      eventId: record.fulfilledBy,
      duplicatesIgnored: receipt?.duplicates ?? 0,
    },
  };
}

const outcomeMessage = (
  outcome: WebhookOutcome,
  delivery: WebhookDelivery,
  store: 'fulfilled' | 'ignored' | undefined,
) => {
  const handled =
    store === 'fulfilled'
      ? ' The store fulfilled the order.'
      : store === 'ignored'
        ? ' The store saw an event id it already handled and ignored it.'
        : '';
  if (delivery.status === 'failed')
    return `Attempt ${delivery.attempt} failed with 503. Pact retries in a minute; nothing was fulfilled.`;
  if (outcome === 'duplicate')
    return `Sent again with the same event id (attempt ${delivery.attempt}).${handled || ' Deduplicate by event id so it has no effect.'}`;
  return `Attempt ${delivery.attempt} delivered: the endpoint answered 200.${handled}`;
};

export function createMockLab(kit: MockKit): LabData {
  return {
    async scenario() {
      return lab(await kit.store()).scenario;
    },
    async setScenario(id) {
      if (!isScenario(id))
        throw new DataError('invalid_scenario', 'Choose one of the listed scenarios.', 400);
      const s = await kit.current();
      lab(s).scenario = id;
      const changed = applyScenario(s, id);
      tick(s);
      return { scenario: id, changed };
    },

    async queueTestEvent() {
      await kit.writeMerchant();
      const s = await kit.current();
      if (!s.merchant.settings.webhook.configured)
        throw new DataError('no_endpoint', 'Save a webhook endpoint first.', 409);
      const at = now(s);
      const event: WebhookEvent = {
        id: s.ids.next('evt', 4000),
        type: 'webhook.test',
        object_id: 'test',
        created_at: iso(at),
      };
      s.webhookEvents.unshift(event);
      s.webhookDeliveries.unshift({
        id: s.ids.next('dlv', 7000),
        event_id: event.id,
        attempt: 1,
        status: 'pending',
        next_at: iso(at + TEST_EVENT_MS),
        last_http_status: null,
        last_error: null,
        delivered_at: null,
      });
      return { ...event };
    },
    async simulateWebhook(eventId, outcome) {
      const viewer = await getViewer();
      const s = await kit.current();
      const state = lab(s);
      const event = s.webhookEvents.find(e => e.id === eventId);
      if (!event) throw notFound('Event');
      const storeOrder =
        event.type === 'order.paid' ? state.storeOrders.find(o => o.orderId === event.object_id) : undefined;
      // The merchant tests any event; the shopper only the event for their own store order.
      const own =
        viewer?.role === 'customer' &&
        storeOrder !== undefined &&
        s.orders.find(o => o.order.id === storeOrder.orderId)?.order.customerId === viewer.userId;
      if (viewer?.role !== 'merchant' && !own)
        throw new DataError(
          viewer?.role === 'accountant' ? 'read_only' : 'forbidden',
          viewer?.role === 'accountant'
            ? 'The accountant role is read-only.'
            : 'This account cannot do that.',
          403,
        );
      const last = latest(s, eventId);
      if (!last)
        throw new DataError(
          'no_delivery',
          'This event was never sent: there was no webhook endpoint when it happened.',
          409,
        );
      const delivered = () =>
        new DataError(
          'already_delivered',
          'This event was already delivered. A failure cannot undo a delivery; send a duplicate instead.',
          409,
        );
      let delivery: WebhookDelivery;
      switch (outcome) {
        case 'delivered':
          if (last.status === 'delivered') throw delivered();
          if (last.status === 'failed')
            throw new DataError('failed', 'This attempt already failed. Retry it instead.', 409);
          answer(s, last, 'delivered');
          delivery = last;
          break;
        case 'failed':
          if (last.status === 'delivered') throw delivered();
          if (last.status === 'pending') {
            answer(s, last, 'failed');
            delivery = last;
          } else delivery = sendAgain(s, last, 'failed');
          break;
        case 'retry':
          if (last.status === 'delivered') throw delivered();
          if (last.status === 'pending') {
            answer(s, last, 'delivered');
            delivery = last;
          } else delivery = sendAgain(s, last, 'delivered');
          break;
        case 'duplicate':
          if (last.status !== 'delivered')
            throw new DataError(
              'not_delivered',
              'Deliver the event first; a duplicate repeats a delivered event.',
              409,
            );
          delivery = sendAgain(s, last, 'delivered');
          break;
        default:
          throw new DataError('invalid_outcome', 'Choose delivered, failed, retry or duplicate.', 400);
      }
      const results = handleStoreDeliveries(s);
      return { message: outcomeMessage(outcome, delivery, results.get(eventId)) };
    },
    async webhookReceipts() {
      await kit.readMerchant();
      const state = lab(await kit.current());
      return state.received.map(r => ({
        eventId: r.eventId,
        orderId: r.orderId,
        handledAt: iso(r.at),
        duplicatesIgnored: r.duplicates,
      }));
    },

    async storefront() {
      const viewer = await getViewer();
      const s = await kit.current();
      const state = lab(s);
      const shopper = viewer?.role === 'customer' ? s.customers.find(c => c.id === viewer.userId) : undefined;
      const orders = shopper
        ? state.storeOrders.flatMap(record => {
            const order = s.orders.find(o => o.order.id === record.orderId);
            return order && order.order.customerId === shopper.id ? [storeOrderView(s, record, order)] : [];
          })
        : [];
      return {
        brand: kit.brand(s),
        products: s.products
          .filter(p => p.status === 'active')
          .map(p => ({ ...p, prices: p.prices.map(price => ({ ...price })) })),
        shopper: shopper ? { name: shopper.name, email: shopper.email } : null,
        orders: orders.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      };
    },
    async buyFromStore(productId) {
      const viewer = await kit.asCustomer();
      const s = await kit.current();
      const product = s.products.find(p => p.id === productId && p.status === 'active');
      if (!product) throw new DataError('product_unavailable', 'This product is not available.', 404);
      const at = now(s);
      // The store's server creates the order, then opens a Pact checkout for exactly its price.
      const order: OrderRecord = {
        order: {
          id: s.ids.next('ord', 2000),
          merchantId: s.merchant.id,
          customerId: viewer.userId,
          productId,
          productRevision: product.revision,
          productName: product.name,
          total: { ...product.prices[0] },
          refundedMinor: '0',
          status: 'open',
          rail: 'whitechain',
          paymentId: s.ids.tx(),
          providerSessionId: null,
          createdAt: iso(at),
        },
        payerAddress: null,
        txHash: null,
        feeMinor: 0n,
        paidAt: null,
        refunds: [],
        activity: [
          {
            type: 'order.created',
            at: iso(at),
            detail: `Order placed on the ${s.merchant.settings.brandName} store`,
            txHash: null,
          },
        ],
      };
      s.orders.unshift(order);
      const sessionId = `cs_${s.ids.token(10)}`;
      s.checkouts.unshift({
        id: sessionId,
        kind: 'product',
        customerId: viewer.userId,
        productId,
        invoiceId: null,
        orderId: order.order.id,
        amountMinor: BigInt(product.prices[0].amountMinor),
        description: product.name,
        detail: product.description,
        status: 'open',
        createdAt: at,
        expiresAt: at + 30 * 60_000,
        confirmsAtReal: null,
        txHash: null,
        paidAt: null,
        failure: null,
        returnPath: `/demo/store/orders/${order.order.id}`,
      });
      lab(s).storeOrders.unshift({
        orderId: order.order.id,
        sessionId,
        createdAt: at,
        fulfilledAt: null,
        fulfilledBy: null,
      });
      return { orderId: order.order.id, sessionId };
    },
    async storeOrder(orderId) {
      const viewer = await getViewer();
      if (!viewer) throw new DataError('login_required', 'Sign in to continue.', 401);
      const s = await kit.current();
      const record = lab(s).storeOrders.find(o => o.orderId === orderId);
      const order = record && s.orders.find(o => o.order.id === orderId);
      // The buyer sees their own order; the merchant's team may look at any store order.
      const allowed =
        viewer.role === 'customer'
          ? order?.order.customerId === viewer.userId
          : viewer.role === 'merchant' || viewer.role === 'accountant';
      if (!record || !order || !allowed) throw notFound('Order');
      // A payment confirming while the buyer was away settles when they look again.
      const checkout = record.sessionId ? s.checkouts.find(c => c.id === record.sessionId) : undefined;
      if (checkout?.status === 'pending' && viewer.role === 'customer')
        kit.checkoutState(s, checkout.id, viewer);
      return storeOrderView(s, record, order);
    },

    async examples() {
      const s = await kit.store();
      const storeOrderId = lab(s).storeOrders.at(-1)?.orderId ?? null;
      const order = storeOrderId ? s.orders.find(o => o.order.id === storeOrderId) : undefined;
      const sub =
        s.subscriptions.find(item => item.customerId === SHOPPER && item.status !== 'cancelled') ??
        s.subscriptions.find(item => item.customerId === SHOPPER);
      return { storeOrderId, subscriptionId: sub?.id ?? null, txHash: order?.txHash ?? null };
    },
  };
}

// ------------------------------------------------------------- scenarios

/** Context flag: set while a shaped call runs, so the calls it makes inside are left alone. */
const shaping = new AsyncLocalStorage<true>();

/** Demo and lab controls are never shaped, so the reviewer can always switch back. */
const UNSHAPED_PARTS = new Set(['demo', 'lab']);
/** Read by the dashboard layout on every page; failing it would hide the error page itself. */
const UNSHAPED_METHODS = new Set(['merchant.settings']);
/** Method names that change data. Writes are never shaped: no fake success, no fake failure. */
const WRITE =
  /^(?:accept|acknowledge|add|advance|apply|approve|archive|assign|buy|cancel|change|claim|close|complete|configure|confirm|create|deactivate|decline|delete|deliver|deposit|disable|duplicate|edit|enable|fund|invest|issue|mark|pause|pay|prepare|publish|queue|record|refund|reactivate|reject|remind|remove|repay|replay|request|reset|restore|resume|retry|revoke|rotate|run|save|schedule|send|set|sign|simulate|start|submit|toggle|top|transfer|update|upload|void|withdraw)(?![a-z])/;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function currentScenario(): Promise<ScenarioId> {
  const s = await store();
  return ready(s) ? s.lab.scenario : 'happy';
}

type Method = (...args: unknown[]) => Promise<unknown>;

function shapeRead(read: Method, self: object): Method {
  return async (...args) => {
    if (shaping.getStore()) return read.apply(self, args);
    return shaping.run(true, async () => {
      const scenario = await currentScenario();
      if (scenario === 'loading') await sleep(READ_DELAY_MS);
      if (scenario === 'error')
        throw new DataError(
          'service_unavailable',
          'The service is unavailable in the error review scenario. Choose another scenario in the demo bar.',
          503,
        );
      const result = await read.apply(self, args);
      return scenario === 'empty' && Array.isArray(result) ? [] : result;
    });
  };
}

function passWrite(write: Method, self: object): Method {
  return (...args) =>
    shaping.getStore() ? write.apply(self, args) : shaping.run(true, () => write.apply(self, args));
}

/**
 * Wraps the whole mock source so a review scenario (empty, loading, error) shapes every read.
 * Runs inside the visitor's sandbox, so `store()` returns that visitor's data.
 */
export function withScenario<T extends object>(source: T): T {
  const wrap = (part: object, path: string): object =>
    Object.fromEntries(
      Object.entries(part).map(([name, value]) => {
        if (typeof value !== 'function') return [name, value];
        const method = value as Method;
        if (WRITE.test(name)) return [name, passWrite(method, part)];
        if (UNSHAPED_METHODS.has(`${path}.${name}`)) return [name, method.bind(part)];
        return [name, shapeRead(method, part)];
      }),
    );
  return Object.fromEntries(
    Object.entries(source).map(([name, value]) =>
      value && typeof value === 'object' && !UNSHAPED_PARTS.has(name)
        ? [name, wrap(value, name)]
        : [name, value],
    ),
  ) as T;
}
