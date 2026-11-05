/**
 * Response shapes for flows the web app shows but the API does not expose yet.
 * They extend the existing API types so a real
 * endpoint can return them without changing the UI.
 */
import type { Address, Hex } from 'viem';
import type {
  GasTank,
  Invoice,
  RefusalAttempt,
  Subscription,
  SubscriptionPlan,
} from './api-types.js';
import type { Customer, Order } from './commerce-types.js';

/** Accountant is a read-only merchant role. */
export type ViewerRole = 'merchant' | 'accountant' | 'customer' | 'investor' | 'compliance';

export interface Viewer {
  role: ViewerRole;
  userId: string;
  name: string;
  email: string;
  /** Business name for merchant roles, company for customers. */
  organization: string;
}

// ---------------------------------------------------------------- refusals

export type RefusalSource = 'refund' | 'subscription' | 'sponsorship' | 'agent' | 'invoice';

/** A refused action. Refusals never spend the merchant's gas. */
export interface RefusalEvent extends RefusalAttempt {
  source: RefusalSource;
  /** The drain-protection layer (1-8) that refused it, when it was a sponsorship refusal. */
  layer: number | null;
  /** Plain-language explanation shown to merchants and customers. */
  detail: string;
  actor: string | null;
}

// --------------------------------------------------------------------- gas

export type SponsoredAction =
  | 'payment'
  | 'refund'
  | 'subscribe'
  | 'renewal'
  | 'cancel'
  | 'invoice_acknowledge'
  | 'account_setup'
  | 'agent_settlement';

export interface GasLedgerEntry {
  id: string;
  createdAt: string;
  action: SponsoredAction;
  objectId: string;
  /** Customer-facing label of what was sponsored. */
  label: string;
  gasWei: string;
  /** USD estimate of the gas, in USDT base units. */
  gasUsdMinor: string;
  /** Pact fee collected in the same transaction, in USDT base units. */
  feeMinor: string;
  txHash: Hex;
}

export interface GasPolicy {
  /** Who carries gas: the merchant's tank, or a surcharge added to the price. */
  mode: 'absorb' | 'surcharge';
  surchargeMinor: string;
  perPayerDailyActions: number;
  minimumAmountMinor: string;
  maxGasPerCall: number;
  maxFeePerGasWei: string;
  lowRunwayAlertDays: number;
}

export interface GasTankDetail extends GasTank {
  policy: GasPolicy;
  /** Price used for USD estimates: USDT base units per 1 WBT. */
  wbtUsdMinor: string;
  faucet: { amountWei: string; nextClaimAt: string | null; source: string };
  /** Sponsored spend per UTC day, oldest first. */
  history: Array<{ date: string; spentWei: string; actions: number }>;
}

// ---------------------------------------------------------------- security

export interface SecurityLayer {
  id: number;
  name: string;
  enforcedIn: 'contract' | 'relayer';
  stops: string;
  reasons: string[];
  blocked: number;
}

export type DrainAttack =
  | 'replay'
  | 'dust'
  | 'arbitrary_calldata'
  | 'spam_accounts'
  | 'over_daily_cap'
  | 'stale_deadline';

export interface DrainAttempt {
  id: string;
  attack: DrainAttack;
  label: string;
  actor: string;
  result: 'refused' | 'sent';
  reason: string;
  layer: number;
}

export interface DrainRun {
  id: string;
  startedAt: string;
  attempts: DrainAttempt[];
  legitimateSent: number;
  tankBeforeWei: string;
  tankAfterWei: string;
}

// ------------------------------------------------------------------ agents

export interface AgentSession {
  id: string;
  name: string;
  description: string;
  account: Address;
  sessionKey: Address;
  perCallCapMinor: string;
  dailyCapMinor: string;
  allowedMerchants: Array<{ address: Address; name: string }>;
  expiresAt: string;
  status: 'active' | 'revoked' | 'expired';
  spentTodayMinor: string;
  callsToday: number;
  createdAt: string;
}

export type AgentCallStatus = 'settled' | 'refused';

/** One paid HTTP request: request → 402 → signed payment → settlement → response. */
export interface AgentCall {
  id: string;
  agentId: string;
  agentName: string;
  merchantName: string;
  method: 'GET';
  url: string;
  scheme: 'exact' | 'upto';
  priceMinor: string;
  /** Amount actually settled (upto may settle less than the price ceiling). */
  amountMinor: string;
  status: AgentCallStatus;
  /** Refusal code from the agent account or facilitator, e.g. DailyCap. */
  reason: string | null;
  txHash: Hex | null;
  responseStatus: 200 | 402;
  responseBody: string | null;
  createdAt: string;
}

export interface PaidEndpoint {
  id: string;
  method: 'GET';
  path: string;
  description: string;
  priceMinor: string;
  scheme: 'exact' | 'upto';
  callsToday: number;
  revenueTodayMinor: string;
  refusedToday: number;
}

export interface FacilitatorStatus {
  url: string;
  network: 'eip155:1874';
  asset: Address;
  schemes: Array<'exact' | 'upto'>;
  status: 'online' | 'unconfigured';
  verified: number;
  settled: number;
  refused: number;
  failed: number;
}

// ----------------------------------------------------------- developers

export interface ApiKey {
  id: string;
  name: string;
  kind: 'publishable' | 'secret';
  /** Shown once on creation; afterwards only the prefix and last four characters. */
  preview: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface WebhookConfig {
  url: string | null;
  configured: boolean;
  eventTypes: string[];
  secretPreview: string | null;
}

// ------------------------------------------------------------- invoices

export type InvoiceActivityType =
  | 'created'
  | 'sent'
  | 'reminder'
  | 'viewed'
  | 'acknowledged'
  | 'payment'
  | 'overdue'
  | 'paid';

export interface InvoiceActivity {
  type: InvoiceActivityType;
  at: string;
  detail: string;
  amount?: string;
  txHash?: Hex | null;
}

export interface InvoiceReminder {
  stage: 'seven_days' | 'one_day' | 'overdue';
  dueAt: string;
  sentAt: string | null;
  channel: 'email' | 'dashboard' | 'webhook';
}

export interface InvoiceDetail extends Invoice {
  number: string;
  customerName: string | null;
  merchantName: string;
  acknowledgement: { signedAt: string; signer: Address; txHash: Hex | null } | null;
  reminders: InvoiceReminder[];
  activity: InvoiceActivity[];
}

// -------------------------------------------------------- subscriptions

export interface SubscriptionCharge {
  id: string;
  period: number;
  amount: string;
  status: 'charged' | 'refused' | 'retry_scheduled';
  reason: string | null;
  txHash: Hex | null;
  at: string;
}

export interface SubscriptionDetail extends Subscription {
  customerId: string;
  customerName: string | null;
  customerEmail: string | null;
  merchantName: string;
  periodsCharged: number;
  retryCount: number;
  cancelledAt: string | null;
  replacedBy: string | null;
  mandate: { amountCap: string; periodSeconds: number; maxPeriods: number | null; signedAt: string };
  charges: SubscriptionCharge[];
}

export interface PlanSummary extends SubscriptionPlan {
  description: string;
  activeSubscribers: number;
  monthlyRecurringMinor: string;
}

// ------------------------------------------------------------ commerce

export interface CustomerSummary extends Customer {
  company: string | null;
  orders: number;
  spentMinor: string;
  refundedMinor: string;
  activeSubscriptions: number;
  lastActivityAt: string | null;
}

export interface OrderListItem extends Order {
  customerEmail: string | null;
  customerName: string | null;
}

// -------------------------------------------------------------- customer

export interface CustomerAccount {
  name: string;
  email: string;
  company: string | null;
  /** The smart account, shown only behind "Advanced details". */
  address: Address;
  balanceMinor: string;
  passkeys: number;
  testFunds: { amountMinor: string; nextClaimAt: string | null };
}

// ------------------------------------------------------------ onboarding

export interface OnboardingStep {
  id: 'account' | 'brand' | 'gas' | 'integrate' | 'test_payment';
  title: string;
  done: boolean;
}
