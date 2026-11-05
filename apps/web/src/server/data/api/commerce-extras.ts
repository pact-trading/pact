import 'server-only';
import type { Order, Product } from '@pactagent/core/commerce-types';
import type { CustomerSummary } from '@pactagent/core/platform-types';
import { toMinor } from '@/lib/format';
import { publicApi, SessionError } from '../../api-client';
import { publicOrigin } from '../../origin';
import { DataError, notFound } from '../errors';
import type {
  CommerceExtrasData,
  Discount,
  ManagedPlan,
  ManualOrderInput,
  ManualOrderOptions,
  OrderLine,
  OrderQuote,
  OrderSource,
  PaymentLink,
  PublicPaymentLink,
  RefundListItem,
} from '../parts/commerce';
import type { ApiKit } from './source';

/** `/v1/payment-links` rows. Amounts are decimal USDT strings ("250.000000"). */
type ApiPaymentLink = {
  id: string;
  kind: PaymentLink['kind'];
  name: string;
  amount: string | null;
  periodSeconds: number | null;
  status: string;
  visits: number;
  createdAt: string;
  url: string;
};
type LinkExtras = Pick<
  PaymentLink,
  'description' | 'singleUse' | 'expiresAt' | 'payments' | 'collectedMinor' | 'state'
>;

/** `/v1/refunds` rows. `customer` is whatever the payment recorded, usually an email. */
type ApiRefund = {
  id: string;
  paymentId: string;
  amount: string;
  customer: string | null;
  reason: string | null;
  status: string;
  txHash: string | null;
  createdAt: string;
};
export type ApiManualOrder = Order & {
  customerName: string;
  customerEmail: string;
  lines: OrderLine[];
  note: string;
  payUrl: string;
  txHash: string | null;
  source: 'manual' | 'link';
  linkId: string | null;
};

/** Base units to the API's decimal string, e.g. 250000000 → "250.000000". */
const decimal = (minor: bigint) =>
  `${minor / 1_000_000n}.${(minor % 1_000_000n).toString().padStart(6, '0')}`;
const MIN_ORDER = 1_000_000n;
const MAX_LINES = 20;

function toLink(row: ApiPaymentLink, origin: string, extras?: LinkExtras): PaymentLink {
  const status = row.status === 'active' ? 'active' : 'inactive';
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    amountMinor: row.amount === null ? null : toMinor(row.amount).toString(),
    periodSeconds: row.periodSeconds,
    status,
    visits: Number(row.visits),
    createdAt: row.createdAt,
    // The pay page is this app's /l/[id], whatever base URL the API was started with.
    url: `${origin}/l/${row.id}`,
    description: extras?.description ?? null,
    singleUse: extras?.singleUse ?? false,
    expiresAt: extras?.expiresAt ?? null,
    payments: extras?.payments ?? null,
    collectedMinor: extras?.collectedMinor ?? null,
    state: extras?.state ?? status,
  };
}

/** Validates the manual-order editor and prices each line from the catalog (same rules as the API). */
export function quoteManualOrder(
  options: ManualOrderOptions,
  input: ManualOrderInput,
): OrderQuote & { parsed: OrderLine[] } {
  const errors: Record<string, string> = {};
  const parsed: OrderLine[] = [];
  const views: Array<OrderLine | null> = [];
  const customer = input.customer;
  if (customer?.kind === 'existing') {
    if (!options.customers.some(c => c.id === customer.id && c.email))
      errors.customer = 'Choose a customer with an email.';
  } else if (customer?.kind === 'new') {
    const name = String(customer.name ?? '').trim();
    if (!name) errors.name = 'Enter the customer’s name.';
    else if (name.length > 120) errors.name = 'Keep the name under 120 characters.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(customer.email ?? '').trim()))
      errors.email = 'Enter a valid email address.';
  } else errors.customer = 'Choose a customer.';
  const lines = input.lines ?? [];
  if (!lines.length) errors.lines = 'Add at least one item.';
  if (lines.length > MAX_LINES) errors.lines = `An order can have up to ${MAX_LINES} items.`;
  lines.slice(0, MAX_LINES).forEach((line, index) => {
    const key = (field: string) => `line.${index}.${field}`;
    let description = String(line.description ?? '').trim();
    let unit: bigint | null = null;
    if (line.productId) {
      const product = options.products.find(p => p.id === line.productId);
      if (!product) errors[key('product')] = 'This product is not on sale. Choose another.';
      else {
        description = product.name;
        unit = BigInt(product.priceMinor);
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
      const view = {
        productId: line.productId || null,
        description,
        quantity,
        unitMinor: unit.toString(),
        amountMinor: (unit * BigInt(quantity)).toString(),
      };
      parsed.push(view);
      views.push(view);
    } else views.push(null);
  });
  const total = parsed.reduce((sum, l) => sum + BigInt(l.amountMinor), 0n);
  if (!errors.lines && parsed.length === lines.length && total < MIN_ORDER)
    errors.lines = 'The order total must be at least $1.00.';
  if (String(input.note ?? '').length > 1000) errors.note = 'Keep the note under 1,000 characters.';
  return { lines: views, totalMinor: total.toString(), errors, parsed };
}

export function createApiCommerce({ api, post, mApi, mPost }: ApiKit): CommerceExtrasData {
  // GET /v1/payment-links/:id counts a visit and answers 410 for an inactive link, so merchant
  // screens read the list instead and leave the visit count to real payers.
  const links = async () => {
    const [{ data }, extras, origin] = await Promise.all([
      mApi<{ data: ApiPaymentLink[] }>('/v1/payment-links'),
      mApi<{ data: Record<string, LinkExtras> }>('/v1/payment-links/extras').catch(() => ({
        data: {} as Record<string, LinkExtras>,
      })),
      publicOrigin(),
    ]);
    return data.map(row => toLink(row, origin, extras.data[row.id]));
  };
  const findLink = async (id: string) => {
    const link = (await links()).find(l => l.id === id);
    if (!link) throw notFound('Payment link');
    return link;
  };
  // The signed-in customer, when there is one; public pages work without.
  const asCustomerOrPublic = async <T>(path: string) => {
    try {
      return await api<T>(path);
    } catch (error) {
      if (error instanceof DataError && (error.status === 401 || error.status === 403))
        return publicApi<T>(path);
      throw error;
    }
  };
  const options = async (): Promise<ManualOrderOptions> => {
    const [customers, products] = await Promise.all([
      mApi<{ data: CustomerSummary[] }>('/v1/commerce/customers?limit=100')
        .then(r => r.data)
        .catch(() => [] as CustomerSummary[]),
      mApi<{ data: Product[] }>('/v1/commerce/products?limit=100').then(r => r.data),
    ]);
    return {
      customers: customers.map(c => ({ id: c.id, name: c.name, email: c.email, company: null })),
      products: products
        .filter(p => p.status === 'active' && p.prices[0])
        .map(p => ({ id: p.id, name: p.name, priceMinor: p.prices[0].amountMinor })),
      minimumMinor: MIN_ORDER.toString(),
    };
  };

  return {
    discounts: async () => (await mApi<{ data: Discount[] }>('/v1/discounts')).data,
    createDiscount: input => mPost<Discount>('/v1/discounts', input),
    archiveDiscount: id => mPost<Discount>(`/v1/discounts/${encodeURIComponent(id)}/archive`, {}),
    async paymentLinks(filter) {
      const query = filter?.query?.trim().toLowerCase();
      return (await links()).filter(
        l =>
          (!filter?.status || filter.status === 'all' || l.state === filter.status) &&
          (!query || `${l.id} ${l.name}`.toLowerCase().includes(query)),
      );
    },
    paymentLink: async id => ({ link: await findLink(id), payments: null }),

    async createPaymentLink(input) {
      if (input.kind !== 'product' && input.kind !== 'tip')
        throw new DataError('invalid_kind', 'Choose a fixed amount or let the payer choose.', 400);
      let amount: string | undefined;
      if (input.kind === 'product') {
        if (!/^\d+$/.test(input.amountMinor ?? '') || BigInt(input.amountMinor!) <= 0n)
          throw new DataError('invalid_amount', 'The amount must be more than zero.', 400);
        amount = decimal(BigInt(input.amountMinor!));
      }
      const created = await mPost<ApiPaymentLink>('/v1/payment-links', {
        kind: input.kind,
        name: input.name,
        ...(amount ? { amount } : {}),
        ...(input.description?.trim() ? { description: input.description.trim() } : {}),
        ...(input.singleUse ? { singleUse: true } : {}),
        ...(input.expiresOn ? { expiresOn: input.expiresOn } : {}),
        ...(input.checkoutFields?.length ? { checkoutFields: input.checkoutFields } : {}),
      });
      return findLink(created.id);
    },
    async deactivatePaymentLink(id) {
      await mPost(`/v1/payment-links/${encodeURIComponent(id)}/deactivate`, {});
      return findLink(id);
    },
    async reactivatePaymentLink(id) {
      await mPost(`/v1/payment-links/${encodeURIComponent(id)}/reactivate`, {});
      return findLink(id);
    },
    async publicPaymentLink(id) {
      const link = await asCustomerOrPublic<PublicPaymentLink>(
        `/v1/commerce/links/${encodeURIComponent(id)}`,
      ).catch(error => {
        throw error instanceof SessionError || (error instanceof DataError && error.status === 404)
          ? notFound('Payment link')
          : error;
      });
      return {
        ...link,
        brand: { brandName: link.brand.brandName || 'This business', logoUrl: link.brand.logoUrl },
      };
    },
    async startLinkCheckout(id, amountMinor, discountCode, metadata) {
      const started = await post<{ paymentId: string }>(
        `/v1/commerce/me/links/${encodeURIComponent(id)}/payments`,
        { ...(amountMinor ? { amountMinor } : {}), ...(discountCode?.trim() ? { discountCode: discountCode.trim() } : {}), ...(metadata && Object.keys(metadata).length ? { metadata } : {}) },
      );
      return { sessionId: `hp_${started.paymentId}` };
    },

    manualOrderOptions: options,
    async quoteOrder(input) {
      const { parsed: _parsed, ...quote } = quoteManualOrder(await options(), input);
      return quote;
    },
    async createManualOrder(input) {
      const quote = quoteManualOrder(await options(), input);
      if (Object.keys(quote.errors).length)
        throw new DataError('invalid_order', Object.values(quote.errors)[0], 400);
      return mPost('/v1/manual-orders', {
        customer:
          input.customer.kind === 'existing'
            ? { kind: 'existing', id: input.customer.id }
            : { kind: 'new', name: input.customer.name.trim(), email: input.customer.email.trim() },
        lines: quote.parsed.map(l => ({
          productId: l.productId,
          description: l.description,
          quantity: l.quantity,
          unitMinor: l.unitMinor,
        })),
        note: input.note,
      });
    },
    async orderSources() {
      const { data } = await mApi<{ data: ApiManualOrder[] }>('/v1/manual-orders');
      return Object.fromEntries(
        data.map((o): [string, OrderSource] => [
          o.id,
          o.source === 'link' && o.linkId
            ? { kind: 'link', label: 'Payment link', linkId: o.linkId }
            : { kind: 'manual', label: 'Manual order', payUrl: o.payUrl, lines: o.lines, note: o.note },
        ]),
      );
    },
    async payableOrder(orderId) {
      const view = await asCustomerOrPublic<{
        brand: { brandName: string; logoUrl: string | null };
        access: 'payer' | 'sign_in' | 'other';
        order: NonNullable<Awaited<ReturnType<CommerceExtrasData['payableOrder']>>['order']> | null;
      }>(`/v1/commerce/orders/${encodeURIComponent(orderId)}/public`);
      return {
        ...view,
        brand: { brandName: view.brand.brandName || 'This business', logoUrl: view.brand.logoUrl },
      };
    },
    async startOrderCheckout(orderId) {
      const started = await post<{ paymentId: string }>(
        `/v1/commerce/me/orders/${encodeURIComponent(orderId)}/pay`,
        {},
      );
      return { sessionId: `hp_${started.paymentId}` };
    },

    async refunds(filter) {
      const [{ data }, orders] = await Promise.all([
        mApi<{ data: ApiRefund[] }>('/v1/refunds'),
        // Orders carry the payment id, which links a refund back to its order and customer.
        mApi<{ data: Order[] }>('/v1/commerce/orders?limit=100')
          .then(r => r.data)
          .catch(() => [] as Order[]),
      ]);
      const byPayment = new Map(orders.filter(o => o.paymentId).map(o => [o.paymentId!, o]));
      const query = filter?.query?.trim().toLowerCase();
      return data
        .map((r): RefundListItem => {
          const order = byPayment.get(r.paymentId);
          const email = r.customer?.includes('@') ? r.customer : null;
          return {
            id: r.id,
            amountMinor: toMinor(r.amount).toString(),
            status: r.status === 'succeeded' ? 'succeeded' : r.status === 'failed' ? 'failed' : 'pending',
            reason: r.reason || null,
            createdAt: r.createdAt,
            txHash: r.txHash,
            orderId: order?.id ?? null,
            paymentId: r.paymentId,
            description: order?.productName ?? null,
            customerId: order?.customerId ?? null,
            customerName: null,
            customerEmail: email,
          };
        })
        .filter(
          r =>
            (!filter?.status || filter.status === 'all' || r.status === filter.status) &&
            (!filter?.customerId || r.customerId === filter.customerId) &&
            (!query ||
              `${r.id} ${r.orderId ?? ''} ${r.paymentId ?? ''} ${r.description ?? ''} ${r.customerEmail ?? ''} ${r.reason ?? ''}`
                .toLowerCase()
                .includes(query)),
        );
    },

    plans: async () => (await mApi<{ data: ManagedPlan[] }>('/v1/subscriptions/plans')).data,
    archivePlan: id => mPost<ManagedPlan>(`/v1/subscriptions/plans/${encodeURIComponent(id)}/archive`, {}),
    restorePlan: id => mPost<ManagedPlan>(`/v1/subscriptions/plans/${encodeURIComponent(id)}/restore`, {}),
  };
}
