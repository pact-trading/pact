import type { WebhookDelivery, WebhookEvent } from '@pactagent/core/api-types';
import type { Order, Product } from '@pactagent/core/commerce-types';
import type { CheckoutBrand } from '../types';

/**
 * Demo lab: review scenarios, the demo storefront and its webhook-driven fulfilment.
 * Implemented by `mock/lab.ts`; the API source has no lab (`null`).
 */

export type ScenarioId =
  | 'happy'
  | 'empty'
  | 'loading'
  | 'error'
  | 'insufficient-funds'
  | 'gas-empty'
  | 'expired'
  | 'overdue'
  | 'renewal-failed'
  | 'cap-reached';

export interface ScenarioInfo {
  id: ScenarioId;
  label: string;
  /** One line, shown in the demo bar. */
  description: string;
  /** `screens` shapes what every screen reads; `data` changes the visitor's demo data once. */
  group: 'screens' | 'data';
}

export const SCENARIOS: readonly ScenarioInfo[] = [
  { id: 'happy', label: 'Happy path', description: 'The seeded story, unchanged.', group: 'screens' },
  {
    id: 'empty',
    label: 'Empty',
    description: 'Every list reads as empty, so each screen shows its empty state.',
    group: 'screens',
  },
  {
    id: 'loading',
    label: 'Slow loading',
    description: 'Every read waits 1.5 seconds, so each screen shows its loading skeleton.',
    group: 'screens',
  },
  {
    id: 'error',
    label: 'Service error',
    description: 'Every read fails with a 503, so each screen shows its error state with Retry.',
    group: 'screens',
  },
  {
    id: 'insufficient-funds',
    label: 'Insufficient funds',
    description: 'Jordan’s balance drops to $0, so checkout asks to add funds.',
    group: 'data',
  },
  {
    id: 'gas-empty',
    label: 'Gas tank empty',
    description: 'Kite Labs’ gas tank drops to 0, so sponsored actions are refused.',
    group: 'data',
  },
  {
    id: 'expired',
    label: 'Checkout expired',
    description: 'Open checkouts expire, and new ones expire as soon as they open.',
    group: 'data',
  },
  {
    id: 'overdue',
    label: 'Invoice overdue',
    description: 'An unpaid invoice moves past its due date.',
    group: 'data',
  },
  {
    id: 'renewal-failed',
    label: 'Renewal failed',
    description: 'Jordan’s next renewal is refused for insufficient funds and a retry is scheduled.',
    group: 'data',
  },
  {
    id: 'cap-reached',
    label: 'Agent cap reached',
    description: 'The research agent spends its daily cap, so its next call is refused.',
    group: 'data',
  },
];

export const isScenario = (value: string): value is ScenarioId => SCENARIOS.some(s => s.id === value);

/**
 * A simulated answer from the merchant's endpoint to one webhook delivery:
 * `delivered` answers a queued attempt with 200, `failed` answers it with 503 and schedules a retry,
 * `retry` sends a failed event again now, `duplicate` sends an already delivered event once more.
 */
export type WebhookOutcome = 'delivered' | 'failed' | 'retry' | 'duplicate';

/** What the demo store's webhook handler did with one event. */
export interface WebhookReceipt {
  eventId: string;
  orderId: string;
  /** When the store first handled the event and fulfilled the order. */
  handledAt: string;
  /** Later deliveries of the same event id the store ignored. */
  duplicatesIgnored: number;
}

/** An order placed on the demo storefront, as the store's own confirmation page sees it. */
export interface StoreOrderView {
  orderId: string;
  sessionId: string | null;
  productId: string;
  productName: string;
  amountMinor: string;
  orderStatus: Order['status'];
  checkoutStatus: 'open' | 'pending' | 'paid' | 'failed' | 'expired' | null;
  createdAt: string;
  paidAt: string | null;
  webhook: {
    /** False when the merchant has no webhook endpoint, so the store never hears about the payment. */
    configured: boolean;
    event: WebhookEvent | null;
    /** Every delivery attempt of the order's `order.paid` event, newest first. */
    deliveries: WebhookDelivery[];
  };
  fulfilment: {
    fulfilledAt: string | null;
    /** How many times the store fulfilled this order: 0 or 1, never more. */
    count: number;
    eventId: string | null;
    duplicatesIgnored: number;
  };
}

export interface Storefront {
  brand: CheckoutBrand;
  /** The merchant's active products. */
  products: Product[];
  /** Who is shopping; null unless the viewer is the demo customer. */
  shopper: { name: string; email: string } | null;
  /** The shopper's store orders, newest first. */
  orders: StoreOrderView[];
}

/** Ids from the visitor's seeded story, for working example links. */
export interface LabExamples {
  /** Jordan's store order, also a paid order on the merchant side. */
  storeOrderId: string | null;
  /** Jordan's subscription. */
  subscriptionId: string | null;
  /** The store order's payment, for the mock explorer. */
  txHash: string | null;
}

export interface LabData {
  /** The visitor's review scenario. */
  scenario(): Promise<ScenarioId>;
  /** Selects a scenario; `data` scenarios change the sandbox and say what changed. */
  setScenario(id: ScenarioId): Promise<{ scenario: ScenarioId; changed: string | null }>;

  /** Queues a `webhook.test` event whose delivery waits for a simulated outcome. */
  queueTestEvent(): Promise<WebhookEvent>;
  /** Simulates the merchant endpoint's answer. A delivered event is never undone. */
  simulateWebhook(eventId: string, outcome: WebhookOutcome): Promise<{ message: string }>;
  /** What the demo store's handler did with each `order.paid` event it received. */
  webhookReceipts(): Promise<WebhookReceipt[]>;

  storefront(): Promise<Storefront>;
  /** Creates the order and a Pact checkout session for it, as the store's server would. */
  buyFromStore(productId: string): Promise<{ orderId: string; sessionId: string }>;
  storeOrder(orderId: string): Promise<StoreOrderView>;

  /** Seeded ids for the screens index. */
  examples(): Promise<LabExamples>;
}
