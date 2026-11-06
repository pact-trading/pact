import { validateCheckoutAnswers, type CheckoutField, type CheckoutMetadata } from '@pactagent/core/checkout-fields';
import 'server-only';
import type { OrderListItem } from '@pactagent/core/platform-types';
import { toMinor } from '@/lib/format';
import { publicOrigin } from '../../origin';
import { requireViewer } from '../../viewer';
import { DataError, notFound } from '../errors';
import type {
  CommerceExtrasData,
  Discount,
  ManagedPlan,
  ManualOrderInput,
  OrderLine,
  OrderQuote,
  OrderSource,
  PaymentLink,
  PaymentLinkKind,
  PaymentLinkState,
  RefundListItem,
} from '../parts/commerce';
import { customer as customerRecord, MIN_AMOUNT_MINOR, payOrder, plan as planRecord, USDT } from './engine';
import type { MockKit } from './source';
import {
  DAY,
  HOUR,
  hooks,
  iso,
  now,
  setNow,
  type CheckoutRecord,
  type CustomerRecord,
  type MockStore,
  type OrderRecord,
} from './store';

export interface LinkRecord {
  id: string;
  kind: PaymentLinkKind;
  name: string;
  description: string;
  amountMinor: bigint | null;
  periodSeconds: number | null;
  status: 'active' | 'inactive';
  visits: number;
  createdAt: number;
  singleUse: boolean;
  expiresAt: number | null;
  checkoutFields?: CheckoutField[];
}

export interface ManualOrderRecord {
  lines: Array<{ productId: string | null; description: string; quantity: number; unitMinor: bigint }>;
  note: string;
  createdBy: string;
}

/** Commerce-extras records kept in each visitor's sandbox. */
export interface CommerceExtrasState {
  discounts: Discount[];
  links: LinkRecord[];
  /** Orders started from a payment link: order id → link id. */
  linkOrders: Record<string, string>;
  /** Orders the merchant created by hand, keyed by order id. */
  manualOrders: Record<string, ManualOrderRecord>;
  /** Archived plans: plan id → when (demo clock). */
  archivedPlans: Record<string, number>;
}

/** The same refusal the API gives when a required answer is missing. */
export function checkMockAnswers(fields: readonly CheckoutField[] = [], metadata: CheckoutMetadata = {}) {
  const answers = Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, typeof value === 'number' ? String(value) : value]));
  const { errors, metadata: clean, valid } = validateCheckoutAnswers(fields, answers);
  if (!valid) throw new DataError('checkout_field_required', Object.values(errors)[0], 422);
  return clean;
}

export function mockDiscount(s: MockStore, code: string | undefined, gross: bigint, productId: string) {
  if (!code?.trim()) return { gross, net: gross, discount: 0n, code: null as string | null };
  const row = s.commerceExtras.discounts.find(d => d.code === code.trim().toUpperCase() && d.status === 'active' && (!d.productIds || d.productIds.includes(productId)));
  if (!row) throw new DataError('discount_invalid', 'That discount code is not valid here.', 400);
  if ((row.startsAt && Date.parse(row.startsAt) > now(s)) || (row.expiresAt && Date.parse(row.expiresAt) <= now(s))) throw new DataError('discount_expired', 'That discount code has expired or has not started yet.', 400);
  if (row.maxRedemptions !== null && row.redemptions >= row.maxRedemptions) throw new DataError('discount_exhausted', 'That discount code has reached its limit.', 400);
  const discount = row.kind === 'percent' ? (gross * BigInt(row.value) + 5_000n) / 10_000n : BigInt(row.value) > gross ? gross : BigInt(row.value);
  const net = gross - discount;
  if (net < MIN_AMOUNT_MINOR) throw new DataError('discount_below_minimum', 'This discount brings the price below the minimum.', 400);
  return { gross, net, discount, code: row.code };
}
export function redeemMockDiscount(s: MockStore, code: string | null) {
  if (code) s.commerceExtras.discounts.find(d => d.code === code)!.redemptions += 1;
}

const PAID = ['paid', 'partially_refunded', 'refunded'];
/** Payer-chosen amounts stay inside these bounds. */
const TIP_MAX = USDT(10_000);
const TIP_SUGGESTIONS = [USDT(5), USDT(10), USDT(25)];
const MAX_LINES = 20;
const CHECKOUT_MINUTES = 30;

/** The Router refuses payments below its minimum amount ("dust"). */
const minimum = (_s: MockStore) => MIN_AMOUNT_MINOR;
const dollars = (minor: bigint) =>
  `$${(minor / 1_000_000n).toLocaleString('en-US')}.${((minor % 1_000_000n) / 10_000n).toString().padStart(2, '0')}`;

function ordersForLink(s: MockStore, linkId: string) {
  return s.orders.filter(o => s.commerceExtras.linkOrders[o.order.id] === linkId);
}

function linkState(s: MockStore, link: LinkRecord): PaymentLinkState {
  if (link.status === 'inactive') return 'inactive';
  if (link.expiresAt !== null && link.expiresAt <= now(s)) return 'expired';
  if (link.singleUse && ordersForLink(s, link.id).some(o => [...PAID, 'pending'].includes(o.order.status)))
    return 'used';
  return 'active';
}

function linkView(s: MockStore, link: LinkRecord, origin: string): PaymentLink {
  const paid = ordersForLink(s, link.id).filter(o => PAID.includes(o.order.status));
  return {
    id: link.id,
    kind: link.kind,
    name: link.name,
    amountMinor: link.amountMinor === null ? null : link.amountMinor.toString(),
    periodSeconds: link.periodSeconds,
    status: link.status,
    visits: link.visits,
    createdAt: iso(link.createdAt),
    url: `${origin}/l/${link.id}`,
    description: link.description || null,
    singleUse: link.singleUse,
    expiresAt: link.expiresAt === null ? null : iso(link.expiresAt),
    payments: paid.length,
    collectedMinor: paid
      .reduce((sum, o) => sum + BigInt(o.order.total.amountMinor) - BigInt(o.order.refundedMinor), 0n)
      .toString(),
    state: linkState(s, link),
  };
}

function findLink(s: MockStore, id: string) {
  const link = s.commerceExtras.links.find(l => l.id === id);
  if (!link) throw notFound('Payment link');
  return link;
}

const stateMessage: Record<Exclude<PaymentLinkState, 'active'>, string> = {
  inactive: 'This link is no longer taking payments.',
  expired: 'This link has expired.',
  used: 'This link was already used.',
};

/** An order record in the shape product checkouts create, ready for payOrder. */
function newOrder(
  s: MockStore,
  input: { id: string; customerId: string; productId: string; name: string; amount: bigint; detail: string },
): OrderRecord {
  const at = iso(now(s));
  return {
    order: {
      id: input.id,
      merchantId: s.merchant.id,
      customerId: input.customerId,
      productId: input.productId,
      productRevision: 1,
      productName: input.name,
      total: { currency: 'USDT', amountMinor: input.amount.toString() },
      refundedMinor: '0',
      status: 'open',
      rail: 'whitechain',
      paymentId: s.ids.tx(),
      providerSessionId: null,
      createdAt: at,
    },
    payerAddress: null,
    txHash: null,
    feeMinor: 0n,
    paidAt: null,
    refunds: [],
    activity: [{ type: 'order.created', at, detail: input.detail, txHash: null }],
  };
}

function newCheckout(
  s: MockStore,
  input: Pick<
    CheckoutRecord,
    'kind' | 'customerId' | 'orderId' | 'amountMinor' | 'description' | 'detail'
  > & {
    returnPath: string;
  },
): CheckoutRecord {
  const record: CheckoutRecord = {
    id: `cs_${s.ids.token(10)}`,
    productId: null,
    invoiceId: null,
    status: 'open',
    createdAt: now(s),
    expiresAt: now(s) + CHECKOUT_MINUTES * 60_000,
    confirmsAtReal: null,
    txHash: null,
    paidAt: null,
    failure: null,
    ...input,
  };
  s.checkouts.unshift(record);
  return record;
}

/** An open checkout the same payer already started, so a reload does not open a second order. */
function resumable(s: MockStore, customerId: string, match: (c: CheckoutRecord) => boolean) {
  return s.checkouts.find(
    c => c.customerId === customerId && c.status === 'open' && c.expiresAt > now(s) && match(c),
  );
}

// ----------------------------------------------------------- manual orders

function summaryName(lines: Array<{ description: string }>) {
  return lines.length === 1 ? lines[0].description : `${lines[0].description} and ${lines.length - 1} more`;
}

function lineViews(lines: ManualOrderRecord['lines']): OrderLine[] {
  return lines.map(l => ({
    productId: l.productId,
    description: l.description,
    quantity: l.quantity,
    unitMinor: l.unitMinor.toString(),
    amountMinor: (l.unitMinor * BigInt(l.quantity)).toString(),
  }));
}

/** Validates the editor and prices every line on the server. */
function quote(s: MockStore, input: ManualOrderInput): OrderQuote & { parsed: ManualOrderRecord['lines'] } {
  const errors: Record<string, string> = {};
  const parsed: ManualOrderRecord['lines'] = [];
  const views: Array<OrderLine | null> = [];
  const customer = input.customer;
  if (customer?.kind === 'existing') {
    if (!s.customers.some(c => c.id === customer.id)) errors.customer = 'Choose a customer.';
  } else if (customer?.kind === 'new') {
    const email = String(customer.email ?? '')
      .trim()
      .toLowerCase();
    const name = String(customer.name ?? '').trim();
    if (!name) errors.name = 'Enter the customer’s name.';
    else if (name.length > 120) errors.name = 'Keep the name under 120 characters.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter a valid email address.';
    else if (s.customers.some(c => c.email.toLowerCase() === email))
      errors.email = 'A customer already uses this email. Choose them from your customers instead.';
  } else errors.customer = 'Choose a customer.';

  const lines = input.lines ?? [];
  if (!lines.length) errors.lines = 'Add at least one item.';
  if (lines.length > MAX_LINES) errors.lines = `An order can have up to ${MAX_LINES} items.`;
  lines.slice(0, MAX_LINES).forEach((line, index) => {
    const key = (field: string) => `line.${index}.${field}`;
    let description = String(line.description ?? '').trim();
    let unit: bigint | null = null;
    if (line.productId) {
      const product = s.products.find(p => p.id === line.productId && p.status === 'active');
      if (!product?.prices[0]) errors[key('product')] = 'This product is not on sale. Choose another.';
      else {
        description = product.name;
        unit = BigInt(product.prices[0].amountMinor);
      }
    } else {
      if (!description) errors[key('description')] = 'Describe the item.';
      else if (description.length > 200) errors[key('description')] = 'Keep it under 200 characters.';
      try {
        const value = toMinor(String(line.unitAmount ?? '') || '0');
        if (value > 0n) unit = value;
        else errors[key('price')] = 'Enter a price above $0.';
      } catch {
        errors[key('price')] = 'Use a number with up to 6 decimal places.';
      }
    }
    const typed = String(line.quantity ?? '').trim();
    const quantity = /^\d{1,3}$/.test(typed) ? Number(typed) : 0;
    if (quantity < 1) errors[key('quantity')] = 'Use a whole number from 1 to 999.';
    if (unit !== null && quantity >= 1 && description) {
      parsed.push({ productId: line.productId || null, description, quantity, unitMinor: unit });
      views.push(lineViews([parsed.at(-1)!])[0]);
    } else views.push(null);
  });
  const total = parsed.reduce((sum, l) => sum + l.unitMinor * BigInt(l.quantity), 0n);
  if (!errors.lines && parsed.length === lines.length && total < minimum(s))
    errors.lines = `The order total must be at least ${dollars(minimum(s))}.`;
  if (String(input.note ?? '').length > 1000) errors.note = 'Keep the note under 1,000 characters.';
  return { lines: views, totalMinor: total.toString(), errors, parsed };
}

// ------------------------------------------------------------------ seed

/** Seeds the commerce-extras records after the main story is built. */
export function seedCommerceExtras(s: MockStore): CommerceExtrasState {
  const state: CommerceExtrasState = { links: [], linkOrders: {}, manualOrders: {}, archivedPlans: {}, discounts: [] };
  s.commerceExtras = state;
  const realNow = now(s);
  const link = (
    input: Partial<LinkRecord> & Pick<LinkRecord, 'id' | 'name' | 'description' | 'createdAt'>,
  ): LinkRecord => ({
    kind: 'product',
    amountMinor: null,
    periodSeconds: null,
    status: 'active',
    visits: 0,
    singleUse: false,
    expiresAt: null,
    ...input,
  });
  state.links.push(
    link({
      id: 'link_audit_deposit',
      name: 'Website audit deposit',
      description: 'Reserves your audit slot. The deposit comes off the final invoice.',
      amountMinor: USDT(250),
      createdAt: realNow - 32 * DAY,
      visits: 46,
    }),
    link({
      id: 'link_tip_jar',
      kind: 'tip',
      name: 'Tip jar',
      description: 'Say thanks for the free component toolkit updates. You choose the amount.',
      createdAt: realNow - 26 * DAY,
      visits: 19,
    }),
    link({
      id: 'link_rush_fix',
      name: 'Rush fix for Monograph',
      description: 'Same-day fix for the checkout bug, as agreed by email.',
      amountMinor: USDT(180),
      singleUse: true,
      createdAt: realNow - 9 * DAY,
      visits: 2,
    }),
    link({
      id: 'link_early_bird',
      name: 'Early-bird design sprint',
      description: 'Book a five-day design sprint at the early-bird price.',
      amountMinor: USDT(950),
      expiresAt: realNow - 3 * DAY,
      createdAt: realNow - 21 * DAY,
      visits: 31,
    }),
    link({
      id: 'link_spring_promo',
      name: 'Spring workshop promo',
      description: 'A half-day team workshop at the spring launch price.',
      amountMinor: USDT(390),
      status: 'inactive',
      createdAt: realNow - 38 * DAY,
      visits: 73,
    }),
  );

  // Payments through the links, replayed at their own times. Other parts react to
  // live payments only, so their hooks stay out of the seeded history.
  const paused = hooks.orderPaid.splice(0);
  try {
    const pay = (linkId: string, customerId: string, at: number, amount?: bigint) => {
      setNow(s, at);
      const l = state.links.find(item => item.id === linkId)!;
      const record = newOrder(s, {
        id: s.ids.next('ord', 2000),
        customerId,
        productId: l.id,
        name: l.name,
        amount: amount ?? l.amountMinor!,
        detail: `Checkout started from the payment link “${l.name}”`,
      });
      s.orders.push(record);
      state.linkOrders[record.order.id] = l.id;
      try {
        payOrder(s, record, customerRecord(s, customerId));
      } catch {
        // Refused in history: an abandoned checkout, like the product story's.
        record.order.status = 'expired';
      }
    };
    pay('link_spring_promo', 'cus_northwind', realNow - 30 * DAY + 5 * HOUR);
    pay('link_spring_promo', 'cus_monograph', realNow - 22 * DAY + 3 * HOUR);
    pay('link_early_bird', 'cus_tideworks', realNow - 15 * DAY + 2 * HOUR);
    pay('link_audit_deposit', 'cus_northwind', realNow - 12 * DAY + 3 * HOUR);
    pay('link_rush_fix', 'cus_monograph', realNow - 8 * DAY + 4 * HOUR);
    pay('link_audit_deposit', 'cus_tideworks', realNow - 5 * DAY + 6 * HOUR);
    pay('link_tip_jar', 'cus_monograph', realNow - 3 * DAY + 2 * HOUR, USDT(15));
  } finally {
    hooks.orderPaid.push(...paused);
    setNow(s, realNow);
  }

  // A manual order Jordan has not paid yet.
  setNow(s, realNow - 2 * DAY);
  const audit = s.products.find(p => p.id === 'prod_audit')!;
  const lines: ManualOrderRecord['lines'] = [
    {
      productId: audit.id,
      description: audit.name,
      quantity: 1,
      unitMinor: BigInt(audit.prices[0].amountMinor),
    },
    { productId: null, description: 'Rush turnaround (48 hours)', quantity: 1, unitMinor: USDT(150) },
  ];
  const manual = newOrder(s, {
    id: 'ord_manual_1',
    customerId: 'cus_acme',
    productId: audit.id,
    name: summaryName(lines),
    amount: lines.reduce((sum, l) => sum + l.unitMinor * BigInt(l.quantity), 0n),
    detail: `Created in the dashboard by ${s.merchant.ownerName}`,
  });
  s.orders.push(manual);
  state.manualOrders[manual.order.id] = {
    lines,
    note: 'Thanks, Jordan. This covers the audit we discussed on Monday, with the rush turnaround.',
    createdBy: s.merchant.ownerName,
  };
  setNow(s, realNow);

  // Keep the newest-first lists in order after replaying older events.
  const newestFirst = <T>(items: T[], at: (item: T) => string) =>
    items.sort((a, b) => at(b).localeCompare(at(a)));
  newestFirst(s.orders, o => o.order.createdAt);
  newestFirst(s.webhookEvents, e => e.created_at);
  newestFirst(s.webhookDeliveries, d => d.next_at);
  newestFirst(s.relayed, g => g.createdAt);
  return state;
}

// ---------------------------------------------------------------- source

export function createMockCommerce(kit: MockKit): CommerceExtrasData {
  const optionalCustomer = () => requireViewer(['customer']).catch(() => null);

  const managedPlan = (s: MockStore, id: string): ManagedPlan => {
    const archived = s.commerceExtras.archivedPlans[id];
    return {
      ...kit.planSummary(s, id),
      status: archived === undefined ? 'active' : 'archived',
      archivedAt: archived === undefined ? null : iso(archived),
      createdAt: iso(planRecord(s, id).createdAt),
    };
  };

  const setLinkStatus = async (id: string, status: LinkRecord['status']) => {
    await kit.writeMerchant();
    const s = await kit.current();
    const link = findLink(s, id);
    if (link.status === status)
      throw new DataError(
        'unchanged',
        status === 'active' ? 'This link is already on.' : 'This link is already off.',
        409,
      );
    link.status = status;
    return linkView(s, link, await publicOrigin());
  };

  return {
    async discounts() { await kit.readMerchant(); return (await kit.current()).commerceExtras.discounts; },
    async createDiscount(input) {
      await kit.writeMerchant();
      const s = await kit.current();
      const code = input.code.trim().toUpperCase();
      if (!/^[A-Z0-9]{2,40}$/.test(code) || s.commerceExtras.discounts.some(d => d.code === code)) throw new DataError('discount_invalid', 'Enter a unique code using letters and numbers.', 400);
      const row: Discount = { ...input, code, id: s.ids.next('disc', 100), redemptions: 0, status: 'active', createdAt: iso(now(s)) };
      s.commerceExtras.discounts.unshift(row);
      return row;
    },
    async archiveDiscount(id) {
      await kit.writeMerchant();
      const row = (await kit.current()).commerceExtras.discounts.find(d => d.id === id);
      if (!row) throw notFound('Discount');
      row.status = 'archived';
      return row;
    },
    async paymentLinks(filter) {
      await kit.readMerchant();
      const s = await kit.current();
      const origin = await publicOrigin();
      const query = filter?.query?.trim().toLowerCase();
      return s.commerceExtras.links
        .map(l => linkView(s, l, origin))
        .filter(
          l =>
            (!filter?.status || filter.status === 'all' || l.state === filter.status) &&
            (!query || `${l.id} ${l.name} ${l.description ?? ''}`.toLowerCase().includes(query)),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async paymentLink(id) {
      await kit.readMerchant();
      const s = await kit.current();
      const link = findLink(s, id);
      return {
        link: linkView(s, link, await publicOrigin()),
        payments: ordersForLink(s, id)
          .filter(o => o.order.status !== 'open' || o.paidAt !== null)
          .map((o): OrderListItem => kit.orderItem(s, o)),
      };
    },

    async createPaymentLink(input) {
      await kit.writeMerchant();
      const s = await kit.current();
      if (input.kind !== 'product' && input.kind !== 'tip')
        throw new DataError('invalid_kind', 'Choose a fixed amount or let the payer choose.', 400);
      const name = input.name?.trim() ?? '';
      if (!name) throw new DataError('invalid_name', 'Give the link a name.', 400);
      if (name.length > 200) throw new DataError('invalid_name', 'Keep the name under 200 characters.', 400);
      const description = input.description?.trim() ?? '';
      if (description.length > 500)
        throw new DataError('invalid_description', 'Keep the description under 500 characters.', 400);
      let amount: bigint | null = null;
      if (input.kind === 'product') {
        amount = kit.validateMinor(input.amountMinor ?? '', 'The amount');
        if (amount < minimum(s))
          throw new DataError(
            'invalid_amount',
            `The smallest amount a link can charge is ${dollars(minimum(s))}.`,
            400,
          );
      }
      let expiresAt: number | null = null;
      if (input.expiresOn) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiresOn))
          throw new DataError('invalid_expiry', 'Choose a valid date.', 400);
        expiresAt = new Date(`${input.expiresOn}T23:59:59.999Z`).getTime();
        if (Number.isNaN(expiresAt)) throw new DataError('invalid_expiry', 'Choose a valid date.', 400);
        if (expiresAt <= now(s)) throw new DataError('invalid_expiry', 'Choose a date from today on.', 400);
      }
      const link: LinkRecord = {
        id: s.ids.next('link', 100),
        kind: input.kind,
        name,
        description,
        amountMinor: amount,
        periodSeconds: null,
        status: 'active',
        visits: 0,
        createdAt: now(s),
        singleUse: Boolean(input.singleUse),
        expiresAt,
        checkoutFields: input.checkoutFields ?? [],
      };
      s.commerceExtras.links.unshift(link);
      return linkView(s, link, await publicOrigin());
    },

    deactivatePaymentLink: id => setLinkStatus(id, 'inactive'),
    reactivatePaymentLink: id => setLinkStatus(id, 'active'),

    async publicPaymentLink(id) {
      const s = await kit.current();
      const link = findLink(s, id);
      link.visits += 1;
      const viewer = await optionalCustomer();
      const mine = viewer
        ? ordersForLink(s, id).find(
            o => o.order.customerId === viewer.userId && PAID.includes(o.order.status),
          )
        : undefined;
      return {
        id: link.id,
        kind: link.kind,
        name: link.name,
        description: link.description || null,
        amountMinor: link.amountMinor === null ? null : link.amountMinor.toString(),
        state: linkState(s, link),
        expiresAt: link.expiresAt === null ? null : iso(link.expiresAt),
        singleUse: link.singleUse,
        checkoutFields: link.checkoutFields ?? [],
        brand: kit.brand(s),
        minimumMinor: minimum(s).toString(),
        maximumMinor: TIP_MAX.toString(),
        suggestionsMinor: link.kind === 'tip' ? TIP_SUGGESTIONS.map(String) : [],
        yourPayment:
          mine && mine.paidAt
            ? { orderId: mine.order.id, amountMinor: mine.order.total.amountMinor, paidAt: iso(mine.paidAt) }
            : null,
      };
    },

    async startLinkCheckout(id, amountMinor, discountCode, metadata) {
      const viewer = await kit.asCustomer();
      const s = await kit.current();
      const link = findLink(s, id);
      const state = linkState(s, link);
      if (state !== 'active') throw new DataError(`link_${state}`, stateMessage[state], 409);
      let amount: bigint;
      if (link.kind === 'tip') {
        amount = kit.validateMinor(amountMinor ?? '', 'The amount');
        if (amount < minimum(s) || amount > TIP_MAX)
          throw new DataError(
            'invalid_amount',
            `Choose an amount from ${dollars(minimum(s))} to ${dollars(TIP_MAX)}.`,
            400,
          );
      } else if (link.kind === 'product' && link.amountMinor !== null) amount = link.amountMinor;
      else throw new DataError('unsupported', 'This link cannot be paid here.', 409);
      const answers = checkMockAnswers(link.checkoutFields, metadata);
      const price = mockDiscount(s, discountCode, amount, link.id);

      const existing = resumable(
        s,
        viewer.userId,
        c =>
          c.kind === 'link' &&
          c.amountMinor === price.net &&
          c.orderId !== null &&
          s.commerceExtras.linkOrders[c.orderId] === link.id,
      );
      if (existing) return { sessionId: existing.id };

      const record = newOrder(s, {
        id: s.ids.next('ord', 2000),
        customerId: viewer.userId,
        productId: link.id,
        name: link.name,
        amount: price.net,
        detail: `Checkout started from the payment link “${link.name}”`,
      });
      record.order.discountCode = price.code;
      record.order.metadata = answers;
      record.order.amountGross = `${price.gross / 1_000_000n}.${(price.gross % 1_000_000n).toString().padStart(6, '0')}`;
      record.order.amountDiscount = `${price.discount / 1_000_000n}.${(price.discount % 1_000_000n).toString().padStart(6, '0')}`;
      s.orders.unshift(record);
      s.commerceExtras.linkOrders[record.order.id] = link.id;
      const checkout = newCheckout(s, {
        kind: 'link',
        customerId: viewer.userId,
        orderId: record.order.id,
        amountMinor: price.net,
        description: link.name,
        detail: link.description || (link.kind === 'tip' ? 'The amount you chose' : null),
        returnPath: `/l/${link.id}`,
      });
      redeemMockDiscount(s, price.code);
      return { sessionId: checkout.id };
    },

    async manualOrderOptions() {
      await kit.writeMerchant();
      const s = await kit.current();
      return {
        customers: s.customers
          .map(c => ({ id: c.id, name: c.name, email: c.email, company: c.company }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        products: s.products
          .filter(p => p.status === 'active' && p.prices[0])
          .map(p => ({ id: p.id, name: p.name, priceMinor: p.prices[0].amountMinor })),
        minimumMinor: minimum(s).toString(),
      };
    },

    async quoteOrder(input) {
      await kit.writeMerchant();
      const { lines, totalMinor, errors } = quote(await kit.current(), input);
      return { lines, totalMinor, errors };
    },

    async createManualOrder(input) {
      const viewer = await kit.writeMerchant();
      const s = await kit.current();
      const result = quote(s, input);
      const first = Object.values(result.errors)[0];
      if (first) throw new DataError('invalid_order', first, 400);
      let c: CustomerRecord;
      if (input.customer.kind === 'existing') c = customerRecord(s, input.customer.id);
      else {
        c = {
          id: s.ids.next('cus', 100),
          name: input.customer.name.trim(),
          email: input.customer.email.trim().toLowerCase(),
          company: null,
          address: s.ids.address(),
          balanceMinor: 0n,
          passkeys: 0,
          testFundsClaimedAt: null,
          createdAt: now(s),
        };
        s.customers.push(c);
      }
      const record = newOrder(s, {
        id: s.ids.next('ord', 2000),
        customerId: c.id,
        productId: result.parsed.find(l => l.productId)?.productId ?? 'manual',
        name: summaryName(result.parsed),
        amount: BigInt(result.totalMinor),
        detail: `Created in the dashboard by ${viewer.name}`,
      });
      s.orders.unshift(record);
      s.commerceExtras.manualOrders[record.order.id] = {
        lines: result.parsed,
        note: String(input.note ?? '').trim(),
        createdBy: viewer.name,
      };
      return {
        orderId: record.order.id,
        payUrl: `${await publicOrigin()}/pay/${record.order.id}`,
        totalMinor: result.totalMinor,
        customerName: c.name,
        customerEmail: c.email,
      };
    },

    async orderSources() {
      await kit.readMerchant();
      const s = await kit.current();
      const origin = await publicOrigin();
      const sources: Record<string, OrderSource> = {};
      for (const [orderId, linkId] of Object.entries(s.commerceExtras.linkOrders)) {
        const link = s.commerceExtras.links.find(l => l.id === linkId);
        if (link) sources[orderId] = { kind: 'link', label: link.name, linkId };
      }
      for (const [orderId, manual] of Object.entries(s.commerceExtras.manualOrders))
        sources[orderId] = {
          kind: 'manual',
          label: 'Manual order',
          payUrl: `${origin}/pay/${orderId}`,
          lines: lineViews(manual.lines),
          note: manual.note,
        };
      return sources;
    },

    async payableOrder(orderId) {
      const s = await kit.current();
      const record = s.orders.find(o => o.order.id === orderId);
      const manual = s.commerceExtras.manualOrders[orderId];
      if (!record || !manual) throw notFound('Order');
      const brand = kit.brand(s);
      const viewer = await optionalCustomer();
      if (!viewer) return { brand, access: 'sign_in', order: null };
      if (viewer.userId !== record.order.customerId) return { brand, access: 'other', order: null };
      return {
        brand,
        access: 'payer',
        order: {
          id: record.order.id,
          status: record.order.status,
          description: record.order.productName,
          totalMinor: record.order.total.amountMinor,
          lines: lineViews(manual.lines),
          note: manual.note,
          createdAt: record.order.createdAt,
          paidAt: record.paidAt ? iso(record.paidAt) : null,
        },
      };
    },

    async startOrderCheckout(orderId) {
      const viewer = await kit.asCustomer();
      const s = await kit.current();
      const record = s.orders.find(o => o.order.id === orderId);
      if (!record || !s.commerceExtras.manualOrders[orderId] || record.order.customerId !== viewer.userId)
        throw notFound('Order');
      const status = record.order.status;
      if (PAID.includes(status)) throw new DataError('already_paid', 'This order is already paid.', 409);
      if (status === 'expired' || status === 'failed')
        throw new DataError('order_closed', 'This order is closed. Ask the business for a new one.', 409);
      const mine = s.checkouts.filter(c => c.kind === 'order' && c.orderId === orderId);
      const confirming = mine.find(c => c.status === 'pending');
      if (confirming) return { sessionId: confirming.id };
      // A payment that failed while confirming leaves the order payable again.
      if (status === 'pending') record.order.status = 'open';
      const open = resumable(s, viewer.userId, c => c.kind === 'order' && c.orderId === orderId);
      if (open) return { sessionId: open.id };
      const checkout = newCheckout(s, {
        kind: 'order',
        customerId: viewer.userId,
        orderId,
        amountMinor: BigInt(record.order.total.amountMinor),
        description: record.order.productName,
        detail: `Order ${orderId} from ${s.merchant.name}`,
        returnPath: `/pay/${orderId}`,
      });
      return { sessionId: checkout.id };
    },

    async refunds(filter) {
      await kit.readMerchant();
      const s = await kit.current();
      const query = filter?.query?.trim().toLowerCase();
      return s.orders
        .flatMap(record => {
          const c = s.customers.find(item => item.id === record.order.customerId);
          return record.refunds.map((r): RefundListItem => ({
            id: r.id,
            amountMinor: r.amountMinor,
            status: r.status,
            reason: r.reason || null,
            createdAt: r.createdAt,
            txHash: r.txHash,
            orderId: record.order.id,
            paymentId: record.order.paymentId,
            description: record.order.productName,
            customerId: c?.id ?? null,
            customerName: c?.name ?? null,
            customerEmail: c?.email ?? null,
          }));
        })
        .filter(
          r =>
            (!filter?.status || filter.status === 'all' || r.status === filter.status) &&
            (!filter?.customerId || r.customerId === filter.customerId) &&
            (!query ||
              `${r.id} ${r.orderId} ${r.description} ${r.customerName} ${r.customerEmail} ${r.reason}`
                .toLowerCase()
                .includes(query)),
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },

    async plans() {
      await kit.readMerchant();
      const s = await kit.current();
      return s.plans.map(p => managedPlan(s, p.id));
    },
    async archivePlan(id) {
      await kit.writeMerchant();
      const s = await kit.current();
      planRecord(s, id);
      if (s.commerceExtras.archivedPlans[id] !== undefined)
        throw new DataError('already_archived', 'This plan is already archived.', 409);
      s.commerceExtras.archivedPlans[id] = now(s);
      return managedPlan(s, id);
    },
    async restorePlan(id) {
      await kit.writeMerchant();
      const s = await kit.current();
      planRecord(s, id);
      if (s.commerceExtras.archivedPlans[id] === undefined)
        throw new DataError('not_archived', 'This plan is already taking signups.', 409);
      delete s.commerceExtras.archivedPlans[id];
      return managedPlan(s, id);
    },
  };
}

/** For the checkout source: archived plans take no new signups. */
/**
 * Why an order started from a payment link can no longer be paid, or null. Checked again just before
 * payment, so two payers who both opened a single-use link cannot both complete it.
 */
export function linkOrderProblem(s: MockStore, orderId: string | null): string | null {
  const linkId = orderId ? s.commerceExtras?.linkOrders?.[orderId] : undefined;
  if (!linkId) return null;
  const link = s.commerceExtras.links.find(l => l.id === linkId);
  if (!link) return null;
  const state = linkState(s, link);
  return state === 'active' ? null : stateMessage[state];
}

export function planArchived(s: MockStore, planId: string): boolean {
  return s.commerceExtras?.archivedPlans?.[planId] !== undefined;
}
