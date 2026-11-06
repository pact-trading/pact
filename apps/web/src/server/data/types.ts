import type {
  DashboardSummary,
  ExportReport,
  FeeLedgerEntry,
  FeePreview,
  FeesDetail,
  InvoiceRequest,
  MerchantSettings,
  MerchantSettingsUpdate,
  MerchantSpender,
  SubscriptionPlanRequest,
  WebhookDelivery,
  WebhookEvent,
} from '@pactagent/core/api-types';
import type { CheckoutField, CheckoutMetadata } from '@pactagent/core/checkout-fields';
import type { Money, Order, Product } from '@pactagent/core/commerce-types';
import type {
  AgentCall,
  AgentSession,
  ApiKey,
  CustomerAccount,
  CustomerSummary,
  DrainRun,
  FacilitatorStatus,
  InvoiceDetail,
  OnboardingStep,
  OrderListItem,
  PaidEndpoint,
  PlanSummary,
  RefusalEvent,
  SecurityLayer,
  SubscriptionDetail,
  Viewer,
  WebhookConfig,
} from '@pactagent/core/platform-types';
import type { CommerceExtrasData } from './parts/commerce';
import type { FinancingData } from './parts/financing';
import type { LabData } from './parts/lab';

/**
 * A signature the browser must collect before an action is submitted.
 * The payer or merchant only ever signs a message; the relayer sends the transaction.
 */
export interface SignRequest {
  /** Opaque server token naming the prepared action. */
  token: string;
  title: string;
  /** Plain-language terms shown next to the passkey prompt. */
  lines: Array<{ label: string; value: string }>;
  /** EIP-712 typed data, JSON-safe (bigints as strings). */
  typedData: Record<string, unknown>;
  /** Who signs: the merchant's wallet or the customer's account. Defaults to the customer. */
  signer?: 'merchant' | 'customer' | 'investor' | 'compliance';
  /**
   * The customer's one-time USDT approval, collected in the same confirmation before the payment
   * signature: an EIP-2612 permit (JSON-safe typed data) that Pact's relayer submits.
   */
  approval?: { typedData: Record<string, unknown> };
  /** More EIP-712 messages signed in the same confirmation; the submit receives all signatures as a JSON array. */
  also?: Array<Record<string, unknown>>;
  /** This signature is a first step: `continueSigned` turns it into the next request, in the same confirmation. */
  continues?: boolean;
}

export interface RefundEntry {
  id: string;
  amountMinor: string;
  reason: string;
  status: 'pending' | 'succeeded' | 'failed';
  txHash: string | null;
  createdAt: string;
}

export interface OrderActivity {
  type: string;
  at: string;
  detail: string;
  txHash: string | null;
}

export interface OrderDetail {
  order: Order;
  product: Product | null;
  customer: { id: string; name: string | null; email: string | null; company: string | null };
  merchantName: string;
  payment: {
    id: string;
    txHash: string | null;
    /** Pact's fee, taken out of the payment. */
    feeMinor: string;
    payer: string | null;
    /** How the customer paid. Card, bank and own-wallet payments exist in the demo sandbox only. */
    method?: PaymentMethodUsed;
  } | null;
  refunds: RefundEntry[];
  refusals: RefusalEvent[];
  activity: OrderActivity[];
  refundWindowEndsAt: string | null;
  /** What a new refund may still return, after confirmed and pending refunds. */
  refundableMinor: string;
}

export interface CheckoutBrand {
  brandName: string;
  logoUrl: string | null;
  /** The merchant's accent colour for its payment pages; null keeps Pact's. */
  brandColor?: string | null;
}

/** What a checkout pays for. `link` and `order` are paid like products, through their order. */
export type CheckoutKind = 'product' | 'invoice' | 'link' | 'order';

/**
 * How a checkout is paid. `account` is the payer's Pact balance and the only method the API
 * offers; card, bank transfer and own wallet are simulated in the demo sandbox.
 */
export type CheckoutMethodKind = 'account' | 'card' | 'bank' | 'wallet';

/** The method a payment used, for the receipt and the merchant's order page. */
export interface PaymentMethodUsed {
  kind: CheckoutMethodKind;
  /** Plain words, e.g. "Pact account", "Visa ending 4242", "Bank transfer", "Your own wallet". */
  label: string;
  /** Simulated in the demo sandbox. */
  demo: boolean;
}

/** One way to pay a checkout, with what the payer needs to use it. */
export type CheckoutMethodOption =
  | { kind: 'account' }
  | { kind: 'card'; demo: true; declineNumber: string }
  | {
      kind: 'bank';
      demo: true;
      payee: string;
      bank: string;
      accountNumber: string;
      /** Ties the transfer to this checkout. */
      reference: string;
    }
  | {
      kind: 'wallet';
      demo: true;
      /** Derived for this checkout only. */
      depositAddress: string;
      network: string;
      token: string;
    };

/** Card fields as typed. The source validates them and keeps only the brand and last four digits. */
export interface CardDetails {
  name: string;
  number: string;
  /** MM/YY */
  expiry: string;
  cvc: string;
}

export interface CheckoutState {
  id: string;
  kind: CheckoutKind;
  status: 'open' | 'pending' | 'paid' | 'failed' | 'expired';
  description: string;
  detail: string | null;
  total: Money;
  discountCode?: string | null;
  amountGross?: string | null;
  amountDiscount?: string | null;
  /** The customer's answers, kept when a discount code reopens the checkout. */
  metadata?: CheckoutMetadata;
  brand: CheckoutBrand;
  productId: string | null;
  invoiceId: string | null;
  orderId: string | null;
  expiresAt: string;
  /** Payer readiness, expressed without crypto terms. */
  readiness: 'ready' | 'needs_funds' | 'unavailable';
  balanceMinor: string | null;
  failure: string | null;
  receipt: { paidAt: string; txHash: string | null } | null;
  /** Shown only behind "Advanced details". */
  advanced: {
    network: string;
    payerAccount: string | null;
    merchantAccount: string;
    gasPaidBy: string;
    gasWei: string | null;
  };
  /** Ways to pay, the Pact account first. Absent means the Pact account only. */
  methods?: CheckoutMethodOption[];
  /** How the payment was made, once one is under way. */
  method?: PaymentMethodUsed | null;
  /** Where Back and "Start again" lead, such as the product or invoice page. */
  returnPath?: string | null;
}

export interface CatalogEntry {
  product: Product;
  brand: CheckoutBrand;
  available: boolean;
}

export interface PlanOffer {
  plan: PlanSummary;
  brand: CheckoutBrand;
  /** Present when the signed-in customer already holds this plan. */
  subscriptionId: string | null;
  /** False once the business archives the plan: existing subscribers keep it, nobody new can join. */
  available?: boolean;
}

/** A plan the signed-in customer can join, from a business they already buy from or subscribe to. */
export interface AvailablePlan {
  /** `trialDays` is the trial this customer would get: 0 once they have used it. */
  plan: Omit<PlanSummary, 'activeSubscribers' | 'monthlyRecurringMinor'>;
  merchant: { id: string; name: string; logoUrl: string | null };
}

export interface DashboardOverview {
  summary: DashboardSummary;
  onboarding: OnboardingStep[];
  activity: Array<{
    id: string;
    at: string;
    title: string;
    detail: string;
    tone: 'default' | 'success' | 'warning' | 'danger';
    href: string | null;
  }>;
}

export interface ListFilter {
  status?: string;
  query?: string;
  customerId?: string;
}

export interface AgentRunResult {
  calls: AgentCall[];
  session: AgentSession;
}

export interface DemoState {
  now: string;
  offsetDays: number;
}

/** Which events reach someone by email. `email` is the merchant's chosen address or the customer's account. */
export interface NotificationPreferences {
  email: string | null;
  events: string[];
  available: string[];
  /** Absent when no Telegram bot is set up, which hides the choice. */
  telegram?: { connected: boolean; events: string[] };
}

export interface MerchantData {
  settings(): Promise<MerchantSettings>;
  notificationPreferences(): Promise<NotificationPreferences>;
  updateNotificationPreferences(input: {
    email: string | null;
    events: string[];
    telegramEvents?: string[];
  }): Promise<NotificationPreferences>;
  connectTelegram(): Promise<{ url: string; expiresAt: string }>;
  disconnectTelegram(): Promise<void>;
  updateSettings(update: MerchantSettingsUpdate): Promise<MerchantSettings>;
  feePreview(): Promise<FeePreview>;
  overview(): Promise<DashboardOverview>;

  products(): Promise<Product[]>;
  product(id: string): Promise<Product>;
  createProduct(input: {
    name: string;
    description: string;
    priceMinor: string;
    status: Product['status'];
    checkoutFields?: CheckoutField[];
  }): Promise<Product>;
  updateProduct(
    id: string,
    input: Partial<{
      name: string;
      description: string;
      priceMinor: string;
      status: Product['status'];
      checkoutFields: CheckoutField[];
    }>,
  ): Promise<Product>;

  orders(filter?: ListFilter): Promise<OrderListItem[]>;
  order(id: string): Promise<OrderDetail>;
  prepareRefund(orderId: string, amountMinor: string, reason: string): Promise<SignRequest>;
  submitRefund(token: string, signature: string): Promise<OrderDetail>;

  customers(filter?: ListFilter): Promise<CustomerSummary[]>;
  customer(id: string): Promise<{
    customer: CustomerSummary;
    orders: OrderListItem[];
    subscriptions: SubscriptionDetail[];
    invoices: InvoiceDetail[];
  }>;

  invoices(filter?: ListFilter): Promise<InvoiceDetail[]>;
  invoice(id: string): Promise<InvoiceDetail>;
  createInvoice(input: InvoiceRequest & { customerName?: string }): Promise<InvoiceDetail>;
  sendInvoice(id: string): Promise<InvoiceDetail>;
  remindInvoice(id: string): Promise<InvoiceDetail>;

  plans(): Promise<PlanSummary[]>;
  createPlan(input: SubscriptionPlanRequest & { description?: string }): Promise<PlanSummary>;
  subscriptions(filter?: ListFilter): Promise<SubscriptionDetail[]>;
  subscription(id: string): Promise<SubscriptionDetail>;
  /** Demo control: ask the keeper to pull a renewal now. Refused when early. */
  runRenewal(id: string): Promise<{ subscription: SubscriptionDetail; refusal: RefusalEvent | null }>;

  refusals(filter?: { source?: string; limit?: number }): Promise<RefusalEvent[]>;

  /** Pact's fee terms as the merchant signed them, its standing permits, 30-day totals and fees. */
  fees(): Promise<FeesDetail>;
  feeLedger(limit?: number): Promise<FeeLedgerEntry[]>;
  /** The latest fee terms to sign, once. Pact's relayer submits the signature. */
  prepareAcceptTerms(): Promise<SignRequest>;
  submitAcceptTerms(token: string, signature: string): Promise<FeesDetail>;
  /** One standing USDT permit (refunds, then their network fee). Refused when it is already in place. */
  preparePermit(spender: MerchantSpender): Promise<SignRequest>;
  submitPermit(token: string, signature: string): Promise<FeesDetail>;

  securityLayers(): Promise<SecurityLayer[]>;
  runDrainSimulation(): Promise<DrainRun>;

  paidEndpoints(): Promise<PaidEndpoint[]>;
  agentCalls(limit?: number): Promise<AgentCall[]>;
  facilitator(): Promise<FacilitatorStatus>;

  apiKeys(): Promise<ApiKey[]>;
  createApiKey(input: { name: string; kind: ApiKey['kind'] }): Promise<{ key: ApiKey; secret: string }>;
  revokeApiKey(id: string): Promise<ApiKey>;

  webhook(): Promise<WebhookConfig>;
  configureWebhook(url: string): Promise<{ config: WebhookConfig; signingSecret: string }>;
  webhookEvents(): Promise<WebhookEvent[]>;
  webhookDeliveries(): Promise<WebhookDelivery[]>;
  replayWebhook(eventId: string): Promise<void>;
  sendTestWebhook(): Promise<void>;

  exportReport(range: { from?: string; to?: string }): Promise<ExportReport>;

  // Merchant polish. Mock only until the API has endpoints for them.
  /** Brand colour, which MerchantSettings does not carry. */
  preferences(): Promise<MerchantPreferences>;
  updatePreferences(update: Partial<MerchantPreferences>): Promise<MerchantPreferences>;
  /** A written reminder, sent now or at `sendAt`. */
  sendReminder(id: string, input: { message: string; sendAt: string | null }): Promise<ManualReminder>;
  /** The invoice's written reminders; scheduled ones whose time has come are sent first. */
  manualReminders(id: string): Promise<ManualReminder[]>;
  cancelReminder(id: string, reminderId: string): Promise<ManualReminder>;
  /** Demo control: the next renewal is pulled now as if the customer's balance were too low. */
  simulateRenewalFailure(
    id: string,
  ): Promise<{ subscription: SubscriptionDetail; refusal: RefusalEvent | null }>;
  /** Cancels the mandate now; the subscription ends at the period end or immediately. */
  prepareCancelSubscription(id: string, effective: CancelEffective): Promise<SignRequest>;
  submitCancelSubscription(token: string, signature: string): Promise<SubscriptionDetail>;
}

/** Settings the API's MerchantSettings does not carry (`/v1/preferences`). */
export interface MerchantPreferences {
  /** `#rrggbb`, used as the button colour on customer previews. */
  brandColor: string;
}

/** A reminder the merchant wrote, sent at once or scheduled. */
export interface ManualReminder {
  id: string;
  invoiceId: string;
  message: string;
  to: string;
  sendAt: string;
  sentAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

/**
 * When a cancelled subscription ends: at the end of the period already paid for, or now.
 * Either way the mandate is revoked at once, so nothing is charged after the cancellation.
 */
export type CancelEffective = 'period_end' | 'now';

export interface CustomerData {
  account(): Promise<CustomerAccount>;
  notificationPreferences(): Promise<NotificationPreferences>;
  updateNotificationPreferences(input: {
    events: string[];
    telegramEvents?: string[];
  }): Promise<NotificationPreferences>;
  connectTelegram(): Promise<{ url: string; expiresAt: string }>;
  disconnectTelegram(): Promise<void>;
  claimTestFunds(): Promise<CustomerAccount>;

  orders(): Promise<OrderListItem[]>;
  order(id: string): Promise<OrderDetail>;

  subscriptions(): Promise<SubscriptionDetail[]>;
  subscription(id: string): Promise<SubscriptionDetail>;
  /** Active plans of the businesses this customer already uses: what "Browse plans" lists. */
  availablePlans(): Promise<AvailablePlan[]>;
  prepareCancel(id: string): Promise<SignRequest>;
  submitCancel(token: string, signature: string): Promise<SubscriptionDetail>;
  prepareChangePlan(id: string, planId: string): Promise<SignRequest>;
  submitChangePlan(token: string, signature: string): Promise<SubscriptionDetail>;

  invoices(): Promise<InvoiceDetail[]>;
  invoice(id: string): Promise<InvoiceDetail>;
  prepareAcknowledge(id: string): Promise<SignRequest>;
  submitAcknowledge(token: string, signature: string): Promise<InvoiceDetail>;

  agents(): Promise<AgentSession[]>;
  agent(id: string): Promise<{ session: AgentSession; calls: AgentCall[] }>;
  prepareAgentLimits(
    id: string,
    limits: { perCallCapMinor: string; dailyCapMinor: string },
  ): Promise<SignRequest>;
  submitAgentLimits(token: string, signature: string): Promise<AgentSession>;
  prepareRevokeAgent(id: string): Promise<SignRequest>;
  submitRevokeAgent(token: string, signature: string): Promise<AgentSession>;
  /** Demo control: the agent calls the paid API `count` times with an unmodified x402 client. */
  runAgent(id: string, count: number): Promise<AgentRunResult>;
  /** Live mode: merchants an agent can be allowed to pay (the ones this customer buys from). */
  agentMerchants?(): Promise<Array<{ id: string; address: string; name: string }>>;
  prepareCreateAgent?(input: {
    name: string;
    description?: string;
    perCallCapMinor: string;
    dailyCapMinor: string;
    merchantIds: string[];
  }): Promise<SignRequest>;
  submitCreateAgent?(token: string, signatures: string[]): Promise<AgentSession>;
  /** Local fork only: test USDT for the agent's account. */
  fundAgent?(id: string): Promise<AgentSession>;
  /** Live mode: the next signature request after a first-step signature (see `SignRequest.continues`). */
  continueSigned?(token: string, signature: string): Promise<SignRequest>;
}

export interface CheckoutData {
  catalog(productId: string): Promise<CatalogEntry>;
  /** Public: the brand on a hosted invoice link, so the sign-in gate shows who sent it. */
  invoiceBrand(invoiceId: string): Promise<CheckoutBrand>;
  startProductCheckout(
    productId: string,
    discountCode?: string,
    metadata?: CheckoutMetadata,
  ): Promise<{ sessionId: string }>;
  startInvoiceCheckout(invoiceId: string, amountMinor: string): Promise<{ sessionId: string }>;
  session(id: string): Promise<CheckoutState>;
  preparePayment(sessionId: string): Promise<SignRequest>;
  /**
   * Live mode: submits the customer's signed USDT permit (Pact's relayer pays the gas), waits for it
   * to confirm, and returns the payment signature request that follows it in the same confirmation.
   */
  submitApproval?(token: string, approval: ApprovalSignature): Promise<SignRequest>;
  submitPayment(token: string, signature: string): Promise<CheckoutState>;
  /** Demo sandbox only. A declined card leaves the checkout open; an accepted one settles like any payment. */
  payByCard(sessionId: string, card: CardDetails): Promise<CheckoutState>;
  /** Demo sandbox only. The payer says the transfer was sent; it settles through the same pending → paid path. */
  confirmTransfer(sessionId: string, method: 'bank' | 'wallet'): Promise<CheckoutState>;

  /** The business's public plan list, for plan changes. */
  plans(): Promise<PlanSummary[]>;
  planOffer(planId: string): Promise<PlanOffer>;
  prepareSubscribe(planId: string): Promise<SignRequest>;
  submitSubscribe(token: string, signature: string): Promise<{ subscriptionId: string }>;
}

/** The customer's signature over the permit in `SignRequest.approval`. */
export interface ApprovalSignature {
  signature: string;
}

/** A synthetic transaction, rendered by the mock explorer. */
export interface ExplorerTx {
  hash: string;
  status: 'success' | 'refused';
  block: string;
  at: string;
  method: string;
  summary: string;
  from: string;
  to: string;
  transfers: Array<{ from: string; to: string; amountMinor: string; label: string }>;
  gasWei: string;
  gasPaidBy: string;
  events: Array<{ name: string; detail: string }>;
}

export interface DemoControls {
  state(): Promise<DemoState>;
  transaction(hash: string): Promise<ExplorerTx | null>;
  advance(days: number): Promise<DemoState>;
  reset(): Promise<DemoState>;
  viewers(): Promise<Viewer[]>;
}

export interface DataSource {
  mode: 'mock' | 'api';
  merchant: MerchantData;
  customer: CustomerData;
  checkout: CheckoutData;
  /** Payment links, manual orders, the refunds list and plan management. */
  commerce: CommerceExtrasData;
  /** Invoice financing for merchants and investors, and merchant-side agent budgets. */
  financing: FinancingData;
  demo: DemoControls | null;
  /** Review scenarios and the demo storefront. Mock mode only. */
  lab: LabData | null;
}
