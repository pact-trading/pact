import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';
import { cookies } from 'next/headers';
import type { Address, Hex } from 'viem';
import type { MerchantSettings, WebhookDelivery, WebhookEvent } from '@pactagent/core/api-types';
import type { Order, Product } from '@pactagent/core/commerce-types';
import type {
  AgentCall,
  AgentSession,
  ApiKey,
  DrainRun,
  InvoiceActivity,
  InvoiceReminder,
  OnboardingStep,
  PaidEndpoint,
  RefusalEvent,
  SubscriptionCharge,
  ViewerRole,
} from '@pactagent/core/platform-types';
import type { Invoice, SubscriptionStatus } from '@pactagent/core/api-types';
import type { CheckoutKind, OrderActivity, PaymentMethodUsed, RefundEntry } from '../types';
import type { CommerceExtrasState } from './commerce-extras';
import type { FinancingState } from './financing';
import type { LabState } from './lab';
import { SANDBOX_COOKIE, SANDBOX_ID } from '@/lib/sandbox';
import type { Ids, Random } from './ids';
import { decode, encode, kv } from './persist';

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

export interface MerchantRecord {
  id: string;
  name: string;
  address: Address;
  ownerName: string;
  ownerEmail: string;
  accountantName: string;
  accountantEmail: string;
  settings: MerchantSettings;
  /** Pact fee per x402 settlement, in USDT base units. */
  agentFeeMinor: bigint;
  usdtMinor: bigint;
  webhookSecret: string | null;
  webhookEventTypes: string[];
  onboarding: Record<OnboardingStep['id'], boolean>;
}

export interface CustomerRecord {
  id: string;
  name: string;
  email: string;
  company: string | null;
  address: Address;
  balanceMinor: bigint;
  passkeys: number;
  testFundsClaimedAt: number | null;
  createdAt: number;
}

export interface OrderRecord {
  order: Order;
  payerAddress: Address | null;
  txHash: Hex | null;
  /** Pact's fee, taken out of the payment. */
  feeMinor: bigint;
  paidAt: number | null;
  refunds: RefundEntry[];
  activity: OrderActivity[];
  /** How the order was paid; absent on orders paid from the Pact account before methods existed. */
  method?: PaymentMethodUsed;
}

export interface InvoiceRecord {
  invoice: Invoice;
  number: string;
  customerId: string;
  customerName: string | null;
  acknowledgement: { signedAt: string; signer: Address; txHash: Hex | null } | null;
  reminders: InvoiceReminder[];
  activity: InvoiceActivity[];
}

export interface PlanRecord {
  id: string;
  name: string;
  description: string;
  amountMinor: bigint;
  periodSeconds: number;
  maxPeriods: number | null;
  createdAt: number;
}

export interface SubscriptionRecord {
  id: string;
  chainId: Hex;
  planId: string;
  customerId: string;
  status: SubscriptionStatus;
  nextChargeAt: number;
  createdAt: number;
  signedAt: number;
  periodsCharged: number;
  retryCount: number;
  cancelledAt: number | null;
  replacedBy: string | null;
  charges: SubscriptionCharge[];
}

export interface CheckoutRecord {
  id: string;
  kind: CheckoutKind;
  customerId: string;
  productId: string | null;
  invoiceId: string | null;
  orderId: string | null;
  amountMinor: bigint;
  description: string;
  detail: string | null;
  status: 'open' | 'pending' | 'paid' | 'failed' | 'expired';
  createdAt: number;
  expiresAt: number;
  /** Real (wall-clock) time when a pending payment confirms, so the UI shows a short wait. */
  confirmsAtReal: number | null;
  txHash: Hex | null;
  paidAt: number | null;
  failure: string | null;
  /** The method chosen when the payment started. */
  method?: PaymentMethodUsed;
  /** Where Back and "Start again" lead, e.g. `/l/<id>` for a payment link. Defaults by kind. */
  returnPath?: string;
}

export interface AgentRecord {
  session: AgentSession;
  customerId: string;
  /** Spend per UTC day key (YYYY-MM-DD), in USDT base units. */
  spentByDay: Record<string, bigint>;
  callsByDay: Record<string, number>;
}

export interface AccountingEntry {
  id: string;
  at: number;
  type:
    | 'Payment'
    | 'Refund'
    | 'Subscription'
    | 'Invoice'
    | 'Agent payment'
    | 'Fee'
    | 'Financing advance'
    | 'Financing reserve'
    | 'Financing repayment'
    | 'Financing late fee'
    | 'Financing buy-back';
  objectId: string;
  orderId: string | null;
  customer: string;
  grossMinor: bigint;
  /** Pact's fee on this entry; on a `Fee` entry, a refund's network fee. */
  feeMinor: bigint;
  refundOf: string | null;
  txHash: Hex | null;
}

/** What Pact's relayer sends on someone's behalf. Pact pays the gas. */
export type RelayedAction =
  | 'payment'
  | 'refund'
  | 'subscribe'
  | 'renewal'
  | 'cancel'
  | 'invoice_acknowledge'
  | 'account_setup'
  | 'agent_settlement'
  | 'fee_terms'
  | 'permit';

/** One transaction Pact's relayer sent. */
export interface RelayedTx {
  id: string;
  createdAt: string;
  action: RelayedAction;
  /** Who signed it. */
  payer: string;
  objectId: string;
  label: string;
  gasWei: string;
  txHash: Hex;
}

export interface PendingSignature {
  kind: string;
  role: ViewerRole;
  subjectId: string;
  payload: Record<string, string>;
  createdAt: number;
}

export interface MockStore {
  random: Random;
  ids: Ids;
  /** Demo time at the moment `realBase` was taken; now() advances with wall-clock time. */
  clock: { base: number; realBase: number; offsetDays: number };
  merchant: MerchantRecord;
  /** A second merchant so per-merchant isolation (fee terms, allowlists) is visible. */
  otherMerchant: { name: string; address: Address };
  products: Product[];
  customers: CustomerRecord[];
  orders: OrderRecord[];
  invoices: InvoiceRecord[];
  plans: PlanRecord[];
  subscriptions: SubscriptionRecord[];
  refusals: RefusalEvent[];
  /** Pact's fee terms as this merchant signed them, and its standing USDT permits. */
  fees: {
    /** The FeeSchedule version the merchant signed; 0 until it signs, and Pact cannot take its payments. */
    acceptedVersion: number;
    /** Refunds from the merchant's wallet (escrow) and a refund's network fee in USDT (Router). */
    permits: { escrow: boolean; router: boolean };
    /** USDT base units per 1 WBT: the FeeSchedule's price for a refund's network fee. */
    usdtPerWbtMinor: bigint;
  };
  /** Every transaction Pact's relayer sent in this sandbox, newest first. */
  relayed: RelayedTx[];
  agents: AgentRecord[];
  agentCalls: AgentCall[];
  endpoints: PaidEndpoint[];
  apiKeys: ApiKey[];
  notificationPrefs?: { merchant?: { email: string | null; events: string[] }; customers?: Record<string, string[]> };
  webhookEvents: WebhookEvent[];
  webhookDeliveries: WebhookDelivery[];
  accounting: AccountingEntry[];
  checkouts: CheckoutRecord[];
  pending: Map<string, PendingSignature>;
  drainRuns: DrainRun[];
  /** Customers whose account was deployed by the relayer on first use. */
  deployedAccounts: Set<string>;
  /** Signer nonces already consumed, for replay refusals. */
  usedNonces: Set<string>;
  /** Payment links, manual orders and plan states (mock/commerce-extras.ts). */
  commerceExtras: CommerceExtrasState;
  /** Invoice financing and merchant agent budgets (mock/financing.ts). */
  financing: FinancingState;
  /** Review scenario and demo storefront (mock/lab.ts). */
  lab: LabState;
}

// Each browser gets its own demo store, keyed by the sandbox cookie the middleware issues,
// so one visitor's payments, clock moves and resets never reach another visitor.
// Locally the sandboxes live in this process. With Upstash Redis connected (Vercel), every
// data-source call loads the visitor's sandbox, runs, and saves it back if it changed.
const KEY = Symbol.for('pact.mock.sandboxes');
type Sandbox = { store: MockStore; seenAt: number };
type Holder = { [KEY]?: Map<string, Sandbox> };

/** Bounds memory on a long-running server: least recently used sandboxes go first. */
const MAX_SANDBOXES = 300;
const IDLE_MS = 6 * HOUR;
/** Requests without a valid sandbox cookie (scripts, curl) share this one. */
const SHARED = 'shared';

let factory: (() => MockStore) | null = null;

/** Registered by fixtures.ts to avoid an import cycle. */
export function registerFactory(create: () => MockStore) {
  factory = create;
}

function fresh(): MockStore {
  if (!factory) throw new Error('Mock store factory is not registered');
  return factory();
}

/** The sandbox loaded for the current data-source call when sandboxes are persisted. */
const loaded = new AsyncLocalStorage<{ store: MockStore }>();

function sandboxes(): Map<string, Sandbox> {
  const holder = globalThis as Holder;
  return (holder[KEY] ??= new Map());
}

async function sandboxId(): Promise<string> {
  const value = (await cookies()).get(SANDBOX_COOKIE)?.value;
  return value && SANDBOX_ID.test(value) ? value : SHARED;
}

function seed(all: Map<string, Sandbox>, id: string, at: number): MockStore {
  for (const [key, sandbox] of all) if (at - sandbox.seenAt > IDLE_MS) all.delete(key);
  // Map order is least recently used first, because store() re-inserts on every access.
  while (all.size >= MAX_SANDBOXES) all.delete(all.keys().next().value!);
  const created = fresh();
  all.set(id, { store: created, seenAt: at });
  return created;
}

/** The current visitor's store, seeded on first use. */
export async function store(): Promise<MockStore> {
  const active = loaded.getStore();
  if (active) return active.store;
  const id = await sandboxId();
  const all = sandboxes();
  const at = Date.now();
  const sandbox = all.get(id);
  if (!sandbox) return seed(all, id, at);
  all.delete(id);
  all.set(id, { store: sandbox.store, seenAt: at });
  return sandbox.store;
}

/** Restores the seeded story for the current visitor only. */
export async function resetStore(): Promise<MockStore> {
  const active = loaded.getStore();
  if (active) return (active.store = fresh());
  const id = await sandboxId();
  const all = sandboxes();
  all.delete(id);
  return seed(all, id, Date.now());
}

async function persisted<T>(run: () => Promise<T>): Promise<T> {
  // Nested calls (one source method calling another) share the caller's copy.
  if (!kv || loaded.getStore()) return run();
  const id = await sandboxId();
  const saved = await kv.get(id);
  let initial: MockStore;
  try {
    initial = saved ? decode(saved) : fresh();
  } catch {
    initial = fresh();
  }
  const active = { store: initial };
  try {
    return await loaded.run(active, run);
  } finally {
    // Saved even when the call throws: refusals are recorded before they are raised.
    const next = encode(active.store);
    if (next !== saved) await kv.set(id, next);
  }
}

/** Wraps every data-source method so it runs against the visitor's persisted sandbox. */
export function sandboxed<T extends object>(source: T): T {
  if (!kv) return source;
  const wrap = (part: object): object =>
    Object.fromEntries(
      Object.entries(part).map(([name, value]) => [
        name,
        typeof value === 'function'
          ? (...args: unknown[]) => persisted(() => value.apply(part, args))
          : value && typeof value === 'object'
            ? wrap(value)
            : value,
      ]),
    );
  return wrap(source) as T;
}

export function now(s: MockStore): number {
  return s.clock.base + (Date.now() - s.clock.realBase);
}

export function setNow(s: MockStore, at: number) {
  s.clock.base = at;
  s.clock.realBase = Date.now();
}

/**
 * Extension points for the part sources (financing, lab). Parts register at module load;
 * the engine calls them, so engine.ts never imports a part.
 */
export const hooks = {
  /** After the keeper's scheduled work in tick(). */
  tick: [] as Array<(s: MockStore) => void>,
  /**
   * Collects an invoice payment instead of the merchant when it returns a result: a financed
   * invoice is paid to the holders of its claim. Null leaves the payment to the engine.
   */
  invoiceCollect: [] as Array<
    (
      s: MockStore,
      record: InvoiceRecord,
      c: CustomerRecord,
      amount: bigint,
    ) => { txHash: Hex; feeMinor: bigint } | null
  >,
  /** After an invoice payment is recorded; `amount` is in USDT base units. */
  invoicePaid: [] as Array<(s: MockStore, record: InvoiceRecord, amount: bigint) => void>,
  /** After an order is paid (products, payment links, manual orders, storefront). */
  orderPaid: [] as Array<(s: MockStore, record: OrderRecord) => void>,
};

export const iso = (ms: number) => new Date(ms).toISOString();
export const dayKey = (ms: number) => iso(ms).slice(0, 10);
