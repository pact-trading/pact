import 'server-only';
import type { Address, Hex } from 'viem';
import type { AgentCall, AgentSession, PaidEndpoint, Viewer } from '@pactagent/core/platform-types';
import { date, dateTime, toMinor, usd } from '@/lib/format';
import { requireViewer } from '../../viewer';
import { DataError, notFound } from '../errors';
import type { ExplorerTx } from '../types';
import type {
  AgentRefusalStage,
  AgentRequestTrace,
  AgentScenario,
  ComplianceRegistry,
  Counterparty,
  FinancedInvoice,
  FinancingAssumptions,
  FinancingData,
  FinancingEvent,
  FinancingHolder,
  FinancingStatus,
  InvestorAccount,
  InvestorApproval,
  MerchantAgent,
  MerchantAgentsOverview,
  RegistryInvestor,
  TransferRules,
} from '../parts/financing';
import {
  agentCall,
  customer,
  ensureAccount,
  feeFor,
  gasFeeMinor,
  payInvoice,
  reasonDetail,
  refusal,
  reminderSchedule,
  sponsor,
  USDT,
  webhook,
} from './engine';
import type { MockKit } from './source';
import {
  DAY,
  HOUR,
  dayKey,
  hooks,
  iso,
  now,
  setNow,
  type AccountingEntry,
  type AgentRecord,
  type CustomerRecord,
  type InvoiceRecord,
  type MockStore,
} from './store';

// ------------------------------------------------------------------ rules

/*
 * Demo assumptions, shown as such wherever terms appear. They are the rules the receivables
 * contracts would enforce, not underwriting:
 * - Price: 0.1% off face value per whole day to maturity, plus 1% if the customer has an overdue
 *   or late-paid invoice with this merchant. Locked when the invoice is listed.
 * - Pact keeps 0.5% of face value sold, and the contract holds back 10% as a reserve.
 * - The customer pays as usual; the contract routes the payment to whoever holds the claim.
 * - Paid after maturity: the holders get a 1% late fee from the reserve. Unpaid after a 7-day
 *   grace period: the token freezes, the reserve goes to the holders and the merchant owes the
 *   rest as a buy-back.
 * - Only approved investors can buy, send or receive the token, and it stops moving 24 hours
 *   before maturity (the record date).
 */
const DAY_RATE_BPS = 10;
const LATE_PREMIUM_BPS = 100;
const FEE_BPS = 50;
const RESERVE_BPS = 1_000;
const LATE_FEE_BPS = 100;
const GRACE_DAYS = 7;
const RECORD_DATE_HOURS = 24;
const MIN_SHARE = USDT(100);
const APPROVAL_DAYS = 365;

export const FINANCING_ASSUMPTIONS: FinancingAssumptions = {
  dayRateBps: DAY_RATE_BPS,
  latePremiumBps: LATE_PREMIUM_BPS,
  feeBps: FEE_BPS,
  reserveBps: RESERVE_BPS,
  lateFeeBps: LATE_FEE_BPS,
  graceDays: GRACE_DAYS,
  recordDateHours: RECORD_DATE_HOURS,
  minimumShareMinor: MIN_SHARE.toString(),
};

const NETWORK = 'eip155:1874';
/** Synthetic receivables market and compliance registry the mock signs against (mock only). */
const RECEIVABLES: Address = '0x5ec0b1e7a9d24c6f8e3a1b0d7c4f92e6a8b3d150';
const COMPLIANCE: Address = '0xc0391a5e7b2d4f86a1e3c9d07b5f2a8e4d6c1b93';
const FEE_VAULT = '0x5e3f…fee';
const RELAYER = '0x9b2c…relayer';
/** Gas for investor, compliance and keeper transactions. Pact pays it: nobody else needs WBT. */
const PACT_GAS_WEI = 210_000_000_000_000n;
const INVESTOR_ID = 'inv_lotus';
const HARBOR_ID = 'inv_harbor';
const NORTHGATE_ID = 'inv_northgate';

const bps = (amount: bigint, rate: number) => (amount * BigInt(rate)) / 10_000n;
const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
const sumBig = <T>(items: T[], pick: (item: T) => bigint) =>
  items.reduce((total, item) => total + pick(item), 0n);

/** What `face` of an invoice costs at `discountBps`, and what it brings the merchant. */
function amounts(face: bigint, discountBps: number) {
  const price = face - bps(face, discountBps);
  const fee = bps(face, FEE_BPS);
  const reserve = bps(face, RESERVE_BPS);
  return { price, fee, reserve, net: price - fee, upfront: price - fee - reserve };
}

// ------------------------------------------------------------------ state

type PositionStatus =
  'requested' | 'funded' | 'overdue' | 'defaulted' | 'repaid' | 'bought_back' | 'cancelled' | 'withdrawn';

interface PositionEvent {
  id: string;
  at: number;
  kind: FinancingEvent['kind'];
  title: string;
  detail: string;
  amountMinor: bigint | null;
  txHash: Hex | null;
}

/** One investor's part of the claim: receivable tokens, 1 token = 1 USDT of face value. */
interface Holding {
  investorId: string;
  faceMinor: bigint;
  paidMinor: bigint;
  receivedMinor: bigint;
}

/** One listing of one invoice and the receivable token minted against it. Pricing is locked at listing. */
export interface FinancingPosition {
  id: string;
  invoiceId: string;
  status: PositionStatus;
  faceMinor: bigint;
  dayRateBps: number;
  pricedDays: number;
  latePremiumBps: number;
  discountBps: number;
  maturityAt: number;
  requestedAt: number;
  fundedAt: number | null;
  listingClosedAt: number | null;
  overdueAt: number | null;
  defaultedAt: number | null;
  closedAt: number | null;
  holdings: Holding[];
  /** Totals over every purchase: what investors paid, Pact's fee and the reserve held back. */
  raisedMinor: bigint;
  feeTakenMinor: bigint;
  reserveFundedMinor: bigint;
  /** The reserve the contract holds now, and where the rest of it went. */
  reserveHeldMinor: bigint;
  reserveReleasedMinor: bigint;
  reserveToInvestorsMinor: bigint;
  /** Unpaid at maturity: the late fee applies. */
  late: boolean;
  advanceTx: Hex | null;
  events: PositionEvent[];
}

export interface InvestorRecord {
  id: string;
  name: string;
  organization: string;
  email: string;
  address: Address;
  usdtMinor: bigint;
  /** The compliance registry entry: a testnet stand-in for KYC. */
  approval: {
    status: 'approved' | 'pending' | 'revoked';
    region: string;
    expiresAt: number | null;
    appliedAt: number;
  };
}

/** A financing transaction as the explorer shows it. */
interface ChainRecord {
  hash: Hex;
  at: number;
  method: string;
  summary: string;
  to: string;
  transfers: ExplorerTx['transfers'];
  events: ExplorerTx['events'];
  gasWei: bigint;
  gasPaidBy: string;
}

/** Financing and agent-budget records kept in each visitor's sandbox. */
export interface FinancingState {
  /** Newest first. Cancelled and withdrawn listings stay as history. */
  positions: FinancingPosition[];
  investors: InvestorRecord[];
  /** Newest first. */
  chain: ChainRecord[];
  /** USDT put into each agent account. Its balance is this less everything it has settled. */
  agentFundingMinor: Record<string, bigint>;
}

/** Null while the fixtures are still being built (before seedFinancing runs). */
const state = (s: MockStore): FinancingState | null =>
  (s.financing as Partial<FinancingState> | undefined)?.positions ? s.financing : null;

/** The statuses a listing keeps once it has started; cancelled and withdrawn ones are history. */
const CURRENT: PositionStatus[] = ['requested', 'funded', 'overdue', 'defaulted', 'repaid', 'bought_back'];
/** The token is live: payments on the invoice are routed to its holders. */
const ACTIVE: PositionStatus[] = ['requested', 'funded', 'overdue', 'defaulted'];

function currentPosition(s: MockStore, invoiceId: string) {
  return state(s)?.positions.find(p => p.invoiceId === invoiceId && CURRENT.includes(p.status)) ?? null;
}

function invoiceRecord(s: MockStore, invoiceId: string): InvoiceRecord {
  const record = s.invoices.find(i => i.invoice.id === invoiceId);
  if (!record) throw notFound('Invoice');
  return record;
}

function investorRecord(s: MockStore, id: string): InvestorRecord {
  const found = state(s)?.investors.find(i => i.id === id);
  if (!found) throw new DataError('forbidden', 'This account has no investor profile.', 403);
  return found;
}

const debtorName = (record: InvoiceRecord) => record.customerName ?? 'the customer';
const dueOf = (record: InvoiceRecord) =>
  record.invoice.dueAt ? new Date(record.invoice.dueAt).getTime() : null;
const graceEnd = (p: FinancingPosition) => p.maturityAt + GRACE_DAYS * DAY;
const recordDate = (maturity: number) => maturity - RECORD_DATE_HOURS * HOUR;

function event(
  s: MockStore,
  p: FinancingPosition,
  input: Omit<PositionEvent, 'id' | 'at' | 'amountMinor' | 'txHash'> &
    Partial<Pick<PositionEvent, 'at' | 'amountMinor' | 'txHash'>>,
) {
  p.events.push({
    id: s.ids.next('fev', 1000),
    at: input.at ?? now(s),
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    amountMinor: input.amountMinor ?? null,
    txHash: input.txHash ?? null,
  });
}

function chain(s: MockStore, input: Omit<ChainRecord, 'hash' | 'at'> & { at?: number }): ChainRecord {
  const record: ChainRecord = { hash: s.ids.tx(), at: input.at ?? now(s), ...input };
  state(s)!.chain.unshift(record);
  return record;
}

type FinancingEntryType =
  | 'Financing advance'
  | 'Financing reserve'
  | 'Financing repayment'
  | 'Financing late fee'
  | 'Financing buy-back';

/** Books a financing movement in the merchant's ledger, so the export reconciles to its balance. */
function book(
  s: MockStore,
  entry: Omit<AccountingEntry, 'id' | 'type' | 'orderId' | 'refundOf'> & {
    type: FinancingEntryType;
  },
) {
  s.accounting.push({
    id: s.ids.next('acc', 20000),
    orderId: null,
    refundOf: null,
    ...entry,
  });
}

// ---------------------------------------------------------------- holdings

const sold = (p: FinancingPosition) => sumBig(p.holdings, h => h.faceMinor);
const lateFeeOn = (p: FinancingPosition, face: bigint) => (p.late ? bps(face, LATE_FEE_BPS) : 0n);
function owedTo(p: FinancingPosition, h: Holding) {
  const owed = h.faceMinor + lateFeeOn(p, h.faceMinor) - h.receivedMinor;
  return owed > 0n ? owed : 0n;
}
const owed = (p: FinancingPosition) => sumBig(p.holdings, h => owedTo(p, h));

/**
 * Splits `amount` across the holders in proportion to their face value, never more than each is
 * still owed. Whatever is left over (holders paid in full) is the caller's to return.
 */
function split(p: FinancingPosition, amount: bigint): Array<{ h: Holding; amount: bigint }> {
  const total = sold(p);
  if (total === 0n || amount <= 0n) return [];
  const parts = p.holdings.map(h => ({ h, amount: minBig((amount * h.faceMinor) / total, owedTo(p, h)) }));
  let left = amount - sumBig(parts, part => part.amount);
  for (const part of parts) {
    if (left <= 0n) break;
    const extra = minBig(owedTo(p, part.h) - part.amount, left);
    if (extra > 0n) {
      part.amount += extra;
      left -= extra;
    }
  }
  return parts.filter(part => part.amount > 0n);
}

/** Credits each holder's wallet. Returns the organisations paid, for the timeline. */
function payHolders(s: MockStore, parts: Array<{ h: Holding; amount: bigint }>) {
  for (const { h, amount } of parts) {
    h.receivedMinor += amount;
    investorRecord(s, h.investorId).usdtMinor += amount;
  }
  return parts.map(({ h, amount }) => ({ investor: investorRecord(s, h.investorId), amount }));
}

const names = (list: Array<{ organization: string }>) => {
  const all = list.map(i => i.organization);
  return all.length <= 1 ? (all[0] ?? 'the holders') : `${all.slice(0, -1).join(', ')} and ${all.at(-1)}`;
};

// ------------------------------------------------------------- compliance

const isApproved = (s: MockStore, investor: InvestorRecord) =>
  investor.approval.status === 'approved' &&
  (investor.approval.expiresAt === null || investor.approval.expiresAt > now(s));

function approvalView(s: MockStore, investor: InvestorRecord): InvestorApproval {
  const expired =
    investor.approval.status === 'approved' &&
    investor.approval.expiresAt !== null &&
    investor.approval.expiresAt <= now(s);
  return {
    status: expired ? 'expired' : investor.approval.status,
    region: investor.approval.region,
    expiresAt: investor.approval.expiresAt === null ? null : iso(investor.approval.expiresAt),
  };
}

function notApprovedDetail(s: MockStore, investor: InvestorRecord) {
  const status = approvalView(s, investor).status;
  const why =
    status === 'pending'
      ? 'its application is still pending'
      : status === 'revoked'
        ? 'its approval was revoked'
        : 'its approval expired';
  return `${investor.organization} is not an approved investor: ${why}.`;
}

/** Records a refusal on the listing's timeline and in the registry, then throws it. Nothing moves. */
function refuse(s: MockStore, p: FinancingPosition, code: string, title: string, detail: string): never {
  event(s, p, {
    kind: 'refused',
    title,
    detail: `${detail} Refused before anything was sent; no gas was spent.`,
  });
  throw new DataError(code, `Refused by the receivables contract. ${detail}`, 409);
}

// ------------------------------------------------------------ eligibility

/** Others invoices of the same customer with this merchant: paid, overdue now, and paid after their due date. */
function debtorHistory(s: MockStore, record: InvoiceRecord) {
  const others = s.invoices.filter(
    i => i.customerId === record.customerId && i.invoice.id !== record.invoice.id,
  );
  const paidLate = others.filter(i => {
    const due = dueOf(i);
    const paid = i.activity.findLast(a => a.type === 'paid');
    return i.invoice.status === 'paid' && due !== null && paid && new Date(paid.at).getTime() > due;
  });
  return {
    invoicesPaid: others.filter(i => i.invoice.status === 'paid').length,
    invoicesOverdue: others.filter(i => i.invoice.status === 'overdue').length,
    invoicesPaidLate: paidLate.length,
  };
}

/** The discount for listing `record` at `from`: per day to maturity, plus the late-history premium. */
function pricing(s: MockStore, record: InvoiceRecord, from = now(s)) {
  const maturity = dueOf(record) ?? from;
  const days = Math.max(1, Math.floor((maturity - from) / DAY));
  const history = debtorHistory(s, record);
  const latePremiumBps = history.invoicesOverdue + history.invoicesPaidLate > 0 ? LATE_PREMIUM_BPS : 0;
  return {
    dayRateBps: DAY_RATE_BPS,
    days,
    latePremiumBps,
    discountBps: days * DAY_RATE_BPS + latePremiumBps,
  };
}

/** Eligible means sent, acknowledged, nothing paid yet and more than a day before it is due. */
function ineligible(s: MockStore, record: InvoiceRecord): string | null {
  const inv = record.invoice;
  const due = dueOf(record);
  if (inv.status === 'draft') return 'Send the invoice to the customer before financing it.';
  if (inv.status === 'paid') return 'This invoice is already paid.';
  if (toMinor(inv.paid) > 0n)
    return 'Part of this invoice is already paid. Only unpaid invoices can be financed.';
  if (due === null) return 'Only invoices with a due date can be financed.';
  if (due <= now(s)) return 'This invoice is past its due date.';
  if (recordDate(due) <= now(s))
    return 'This invoice is due within a day: too close to its record date to list.';
  if (!record.acknowledgement)
    return `Waiting for ${debtorName(record)} to acknowledge it. An invoice can be financed only after the customer signs “I owe this invoice”, so investors know the debt is real.`;
  return null;
}

function statusOf(s: MockStore, record: InvoiceRecord): FinancingStatus | null {
  const p = currentPosition(s, record.invoice.id);
  if (p) return p.status as FinancingStatus;
  return ineligible(s, record) ? null : 'eligible';
}

// ------------------------------------------------------------ transitions

function withdraw(s: MockStore, p: FinancingPosition, reason: string, at = now(s)) {
  p.status = 'withdrawn';
  p.closedAt = at;
  event(s, p, { at, kind: 'withdrawn', title: 'Listing withdrawn', detail: `${reason} No money moved.` });
}

/** Ends the listing with part sold. The merchant keeps the unsold part of the claim. */
function closeListing(s: MockStore, p: FinancingPosition, reason: string, at = now(s)) {
  p.status = 'funded';
  p.listingClosedAt = at;
  const kept = p.faceMinor - sold(p);
  event(s, p, {
    at,
    kind: 'closed',
    title: 'Listing closed',
    detail: `${reason} Investors hold ${usd(sold(p))}; ${s.merchant.name} keeps the other ${usd(kept)} and is paid that part directly.`,
  });
}

export function requestFinancing(s: MockStore, invoiceId: string): FinancingPosition {
  const f = state(s);
  if (!f) throw new DataError('unavailable', 'Financing is not set up.', 409);
  const record = invoiceRecord(s, invoiceId);
  if (currentPosition(s, invoiceId))
    throw new DataError('already_requested', 'Financing was already requested for this invoice.', 409);
  const reason = ineligible(s, record);
  if (reason) throw new DataError('not_eligible', reason, 409);
  const face = toMinor(record.invoice.amount);
  const price = pricing(s, record);
  const quoted = amounts(face, price.discountBps);
  const p: FinancingPosition = {
    id: s.ids.next('fin', 1000),
    invoiceId,
    status: 'requested',
    faceMinor: face,
    dayRateBps: price.dayRateBps,
    pricedDays: price.days,
    latePremiumBps: price.latePremiumBps,
    discountBps: price.discountBps,
    maturityAt: dueOf(record)!,
    requestedAt: now(s),
    fundedAt: null,
    listingClosedAt: null,
    overdueAt: null,
    defaultedAt: null,
    closedAt: null,
    holdings: [],
    raisedMinor: 0n,
    feeTakenMinor: 0n,
    reserveFundedMinor: 0n,
    reserveHeldMinor: 0n,
    reserveReleasedMinor: 0n,
    reserveToInvestorsMinor: 0n,
    late: false,
    advanceTx: null,
    events: [],
  };
  const premium = price.latePremiumBps
    ? ` plus ${price.latePremiumBps / 100}% because ${debtorName(record)} has paid late before`
    : '';
  event(s, p, {
    kind: 'requested',
    title: 'Listed for investors',
    detail: `Priced at ${usd(quoted.price)} for the ${usd(face)} face value: ${price.days} days to maturity at ${DAY_RATE_BPS / 100}% a day${premium}. Investors can buy all or part of it.`,
  });
  f.positions.unshift(p);
  return p;
}

export function cancelFinancing(s: MockStore, invoiceId: string): FinancingPosition {
  const p = currentPosition(s, invoiceId);
  if (!p) throw new DataError('not_requested', 'There is no financing request to cancel.', 409);
  if (p.status !== 'requested')
    throw new DataError(
      'already_funded',
      'The listing is already closed, so it can no longer be cancelled.',
      409,
    );
  if (sold(p) > 0n) {
    closeListing(
      s,
      p,
      `${s.merchant.name} took the rest of ${invoiceRecord(s, invoiceId).number} off the marketplace.`,
    );
    return p;
  }
  p.status = 'cancelled';
  p.closedAt = now(s);
  event(s, p, {
    kind: 'cancelled',
    title: 'Request cancelled',
    detail: 'Withdrawn from the marketplace before any investor bought it. No money moved.',
  });
  return p;
}

/** Why `investor` cannot buy `face` of this listing now, or null. Approval refusals are recorded. */
function checkPurchase(s: MockStore, p: FinancingPosition, investor: InvestorRecord, face: bigint) {
  const record = invoiceRecord(s, p.invoiceId);
  if (p.status !== 'requested') throw new DataError('not_listed', 'This invoice is no longer listed.', 409);
  const reason = ineligible(s, record);
  if (reason) {
    if (sold(p) > 0n) closeListing(s, p, reason);
    else withdraw(s, p, reason);
    throw new DataError('not_eligible', `${reason} The listing was closed.`, 409);
  }
  const remaining = p.faceMinor - sold(p);
  if (face <= 0n || face > remaining)
    throw new DataError(
      'invalid_amount',
      `Enter up to ${usd(remaining)}, the face value still for sale.`,
      400,
    );
  if (face < MIN_SHARE && face !== remaining)
    throw new DataError(
      'invalid_amount',
      `The smallest share is ${usd(MIN_SHARE)} of face value, unless you buy all that is left.`,
      400,
    );
  if (!isApproved(s, investor))
    refuse(
      s,
      p,
      'not_approved',
      `Purchase by ${investor.organization} refused`,
      notApprovedDetail(s, investor),
    );
  const { price } = amounts(face, p.discountBps);
  if (investor.usdtMinor < price)
    throw new DataError(
      'insufficient_funds',
      `You have ${usd(investor.usdtMinor)} available; ${usd(face)} of this invoice costs ${usd(price)}.`,
      409,
    );
  return amounts(face, p.discountBps);
}

/**
 * Delivery versus payment, in one transaction: the investor pays the price, the merchant receives
 * it less Pact's fee and the reserve, and the investor receives `face` receivable tokens.
 */
export function purchaseShare(s: MockStore, investorId: string, invoiceId: string, face: bigint) {
  const investor = investorRecord(s, investorId);
  const record = invoiceRecord(s, invoiceId);
  const p = currentPosition(s, invoiceId);
  if (!p) throw new DataError('not_listed', 'This invoice is no longer listed.', 409);
  const a = checkPurchase(s, p, investor, face);
  const at = now(s);
  investor.usdtMinor -= a.price;
  s.merchant.usdtMinor += a.upfront;
  p.reserveHeldMinor += a.reserve;
  p.reserveFundedMinor += a.reserve;
  p.raisedMinor += a.price;
  p.feeTakenMinor += a.fee;
  const existing = p.holdings.find(h => h.investorId === investor.id);
  if (existing) {
    existing.faceMinor += face;
    existing.paidMinor += a.price;
  } else p.holdings.push({ investorId: investor.id, faceMinor: face, paidMinor: a.price, receivedMinor: 0n });
  const tx = chain(s, {
    method: 'fund',
    summary: `${investor.organization} funded ${usd(face)} of ${record.number}`,
    to: RECEIVABLES,
    transfers: [
      {
        from: investor.address,
        to: s.merchant.address,
        amountMinor: a.upfront.toString(),
        label: 'Advance to merchant',
      },
      { from: investor.address, to: FEE_VAULT, amountMinor: a.fee.toString(), label: 'Pact fee' },
      {
        from: investor.address,
        to: RECEIVABLES,
        amountMinor: a.reserve.toString(),
        label: 'Reserve, held until the customer pays',
      },
    ],
    events: [
      {
        name: 'InvoiceFunded',
        detail: `${investor.organization} paid ${usd(a.price)} for ${usd(face)} of ${record.number}`,
      },
      {
        name: 'Transfer',
        detail: `Minted ${usd(face)} of receivable tokens to ${investor.organization}, an approved investor`,
      },
    ],
    gasWei: PACT_GAS_WEI,
    gasPaidBy: 'Pact relayer (investors never need WBT)',
  });
  book(s, {
    at,
    type: 'Financing advance',
    objectId: invoiceId,
    customer: investor.organization,
    grossMinor: a.price,
    feeMinor: a.fee,
    txHash: tx.hash,
  });
  book(s, {
    at,
    type: 'Financing reserve',
    objectId: invoiceId,
    customer: investor.organization,
    grossMinor: -a.reserve,
    feeMinor: 0n,
    txHash: tx.hash,
  });
  p.fundedAt ??= at;
  p.advanceTx ??= tx.hash;
  const full = sold(p) === p.faceMinor;
  event(s, p, {
    kind: 'funded',
    title: `${investor.organization} bought ${usd(face)} of ${record.number}`,
    detail: `Paid ${usd(a.price)} for a ${usd(face)} claim due ${date(iso(p.maturityAt))}. ${full ? 'Fully funded; the listing is closed.' : `${usd(sold(p))} of ${usd(p.faceMinor)} funded so far.`}`,
    amountMinor: a.price,
    txHash: tx.hash,
  });
  event(s, p, {
    kind: 'advance',
    title: `${s.merchant.name} received ${usd(a.upfront)}`,
    detail: `${usd(a.price)} less Pact’s ${usd(a.fee)} fee and a ${usd(a.reserve)} reserve the contract holds until ${debtorName(record)} pays.`,
    amountMinor: a.upfront,
    txHash: tx.hash,
  });
  if (full) {
    p.status = 'funded';
    p.listingClosedAt = at;
    webhook(s, 'invoice.financed', invoiceId);
  }
  return p;
}

/**
 * The holders are owed nothing more from the customer: the contract pays any late fee from the
 * reserve and returns the rest of the reserve to the merchant, in the same transaction.
 */
function settle(s: MockStore, p: FinancingPosition, tx: ChainRecord) {
  const record = invoiceRecord(s, p.invoiceId);
  const lateParts = split(p, minBig(owed(p), p.reserveHeldMinor));
  const lateFee = sumBig(lateParts, part => part.amount);
  const paid = payHolders(s, lateParts);
  p.reserveHeldMinor -= lateFee;
  p.reserveToInvestorsMinor += lateFee;
  const release = p.reserveHeldMinor;
  p.reserveHeldMinor = 0n;
  p.reserveReleasedMinor += release;
  s.merchant.usdtMinor += release;
  for (const { investor, amount } of paid)
    tx.transfers.push({
      from: RECEIVABLES,
      to: investor.address,
      amountMinor: amount.toString(),
      label: `Late fee to ${investor.organization}`,
    });
  if (release > 0n)
    tx.transfers.push({
      from: RECEIVABLES,
      to: s.merchant.address,
      amountMinor: release.toString(),
      label: 'Reserve returned to merchant',
    });
  tx.events.push({
    name: 'Settled',
    detail: `${record.number} is paid in full; the receivable tokens are burned`,
  });
  if (release + lateFee > 0n)
    book(s, {
      at: tx.at,
      type: 'Financing reserve',
      objectId: p.invoiceId,
      customer: 'Receivables contract',
      grossMinor: release + lateFee,
      feeMinor: 0n,
      txHash: tx.hash,
    });
  if (lateFee > 0n)
    book(s, {
      at: tx.at,
      type: 'Financing late fee',
      objectId: p.invoiceId,
      customer: names(paid.map(x => x.investor)),
      grossMinor: -lateFee,
      feeMinor: 0n,
      txHash: tx.hash,
    });
  if (release + lateFee > 0n)
    event(s, p, {
      at: tx.at,
      kind: 'reserve',
      title:
        lateFee > 0n
          ? `Reserve settled: ${usd(lateFee)} late fee, ${usd(release)} back to you`
          : `Reserve of ${usd(release)} returned`,
      detail:
        lateFee > 0n
          ? `${debtorName(record)} paid after maturity, so ${names(paid.map(x => x.investor))} received the ${LATE_FEE_BPS / 100}% late fee from the reserve. The rest went back to ${s.merchant.name}.`
          : `${debtorName(record)} paid on time, so the contract released the whole reserve to ${s.merchant.name}.`,
      amountMinor: release,
      txHash: tx.hash,
    });
  p.status = 'repaid';
  p.closedAt = tx.at;
  event(s, p, {
    at: tx.at,
    kind: 'repaid',
    title: 'Repaid in full',
    detail: `${names(p.holdings.map(h => investorRecord(s, h.investorId)))} received everything they were owed${tx.at > p.maturityAt ? `, ${Math.max(1, Math.round((tx.at - p.maturityAt) / DAY))} days after maturity` : ', before maturity'}.`,
    amountMinor: sumBig(p.holdings, h => h.receivedMinor),
  });
  webhook(s, 'invoice.settled', p.invoiceId);
}

/**
 * The invoice payment, when the invoice is financed: the contract sends the holders' share straight
 * to them. The merchant receives only the part it kept (and anything above what holders are owed),
 * with its usual payment fee. Returns null when the invoice is not financed, so the engine collects
 * it normally.
 */
function collectFinanced(s: MockStore, record: InvoiceRecord, c: CustomerRecord, amount: bigint) {
  const p = currentPosition(s, record.invoice.id);
  if (!p || !ACTIVE.includes(p.status)) return null;
  if (p.status === 'requested' && sold(p) === 0n) {
    withdraw(s, p, 'The customer paid before any investor bought a share.');
    return null;
  }
  if (c.balanceMinor < amount) throw new DataError('insufficient_funds', 'Not enough funds in the account.');
  if (p.status === 'requested') closeListing(s, p, 'The customer paid while the invoice was still listed.');
  const completes = amount >= toMinor(record.invoice.remaining);
  ensureAccount(s, c);
  const parts = split(p, (amount * sold(p)) / p.faceMinor);
  const toHolders = sumBig(parts, part => part.amount);
  const toMerchant = amount - toHolders;
  // Pact's invoice rate, on the merchant's part only.
  const fee = toMerchant >= USDT(1) ? minBig(feeFor(toMerchant, 'invoice'), toMerchant) : 0n;
  // No fee on the holders' share: Pact took its fee when the invoice was funded.
  const sponsored = sponsor(s, {
    action: 'payment',
    objectId: record.invoice.id,
    label: `Invoice ${record.number}`,
    payer: c.address,
    amountMinor: amount,
  });
  if (!sponsored.ok) throw new DataError(sponsored.refusal.reason, sponsored.refusal.detail);
  const at = now(s);
  c.balanceMinor -= amount;
  s.merchant.usdtMinor += toMerchant - fee;
  const paid = payHolders(s, parts);
  const kept = p.faceMinor - sold(p);
  const tx: ChainRecord = {
    hash: sponsored.txHash,
    at,
    method: 'execute',
    summary: `Invoice ${record.number} paid; routed to the claim holders`,
    to: RECEIVABLES,
    transfers: [
      ...paid.map(({ investor, amount: a }) => ({
        from: c.address,
        to: investor.address,
        amountMinor: a.toString(),
        label: `Repayment to ${investor.organization}`,
      })),
      ...(toMerchant - fee > 0n
        ? [
            {
              from: c.address,
              to: s.merchant.address,
              amountMinor: (toMerchant - fee).toString(),
              label:
                kept > 0n ? 'To merchant, for the part it kept' : 'To merchant, above what holders were owed',
            },
          ]
        : []),
      ...(fee > 0n
        ? [{ from: c.address, to: FEE_VAULT, amountMinor: fee.toString(), label: 'Pact fee' }]
        : []),
    ],
    events: [
      { name: 'Executed', detail: `Router executed a sponsored payment for Invoice ${record.number}` },
      {
        name: 'Repaid',
        detail: `The receivables contract routed ${usd(toHolders)} to ${names(paid.map(x => x.investor))}`,
      },
    ],
    gasWei: sponsored.gasWei,
    gasPaidBy: 'Pact relayer (customers never pay gas)',
  };
  state(s)!.chain.unshift(tx);
  // The invoice is paid, so it is income; what went to the holders leaves again as repayments.
  s.accounting.push({
    id: s.ids.next('acc', 20000),
    at,
    type: 'Invoice',
    objectId: record.invoice.id,
    orderId: null,
    customer: c.email,
    grossMinor: amount,
    feeMinor: fee,
    refundOf: null,
    txHash: sponsored.txHash,
  });
  for (const { investor, amount: a } of paid)
    book(s, {
      at,
      type: 'Financing repayment',
      objectId: record.invoice.id,
      customer: investor.organization,
      grossMinor: -a,
      feeMinor: 0n,
      txHash: sponsored.txHash,
    });
  event(s, p, {
    kind: 'payment',
    title: `${c.company ?? c.name} paid ${usd(amount)}`,
    detail: `Through the usual payment link. The contract sent ${usd(toHolders)} straight to ${names(paid.map(x => x.investor))}${toMerchant > 0n ? ` and ${usd(toMerchant)} to ${s.merchant.name}${kept > 0n ? ' for the part it kept' : ', above what the holders were owed'}` : ''}. ${s.merchant.name} never held the holders’ money.`,
    amountMinor: amount,
    txHash: sponsored.txHash,
  });
  // Paid in full: anything still owed is the late fee, which the reserve covers.
  if (completes || owed(p) === 0n) settle(s, p, tx);
  return { txHash: sponsored.txHash, feeMinor: fee };
}

/** Past the grace period and unpaid: freeze the token, pay the reserve to the holders, trigger the buy-back. */
function defaultPosition(s: MockStore, p: FinancingPosition, at: number) {
  const record = invoiceRecord(s, p.invoiceId);
  const before = owed(p);
  const parts = split(p, minBig(p.reserveHeldMinor, before));
  const fromReserve = sumBig(parts, part => part.amount);
  const paid = payHolders(s, parts);
  p.reserveHeldMinor -= fromReserve;
  p.reserveToInvestorsMinor += fromReserve;
  p.status = 'defaulted';
  p.defaultedAt = at;
  const tx = chain(s, {
    at,
    method: 'markDefault',
    summary: `${record.number} defaulted; token frozen`,
    to: RECEIVABLES,
    transfers: paid.map(({ investor, amount }) => ({
      from: RECEIVABLES,
      to: investor.address,
      amountMinor: amount.toString(),
      label: `Reserve to ${investor.organization}`,
    })),
    events: [
      { name: 'Frozen', detail: `The ${record.number} receivable token can no longer be transferred` },
      { name: 'RecourseTriggered', detail: `${s.merchant.name} owes ${usd(owed(p))} as a buy-back` },
    ],
    gasWei: PACT_GAS_WEI,
    gasPaidBy: 'Pact keeper',
  });
  event(s, p, {
    at,
    kind: 'defaulted',
    title: 'Defaulted: the token is frozen',
    detail: `The ${GRACE_DAYS}-day grace period ended with ${usd(before)} unpaid. The contract froze the token and paid the ${usd(fromReserve)} reserve to ${names(paid.map(x => x.investor))}. ${s.merchant.name} owes the remaining ${usd(owed(p))} as a buy-back. ${debtorName(record)} can still pay; that payment goes to the holders first.`,
    amountMinor: fromReserve,
    txHash: tx.hash,
  });
}

/** The merchant pays the holders what a defaulted invoice still owes them; the claim is its own again. */
export function buyBack(s: MockStore, invoiceId: string) {
  const record = invoiceRecord(s, invoiceId);
  const p = currentPosition(s, invoiceId);
  if (!p || p.status !== 'defaulted')
    throw new DataError('not_defaulted', 'Only a defaulted invoice can be bought back.', 409);
  const amount = owed(p);
  // The merchant signs; Pact's relayer sends it and takes the network fee in USDT.
  const networkFee = gasFeeMinor(s, PACT_GAS_WEI);
  if (s.merchant.usdtMinor < amount + networkFee)
    throw new DataError(
      'insufficient_funds',
      `${s.merchant.name} has ${usd(s.merchant.usdtMinor)}; the buy-back is ${usd(amount)} plus up to ${usd(networkFee)} network fee.`,
      409,
    );
  const parts = split(p, amount);
  s.merchant.usdtMinor -= amount + networkFee;
  const paid = payHolders(s, parts);
  const tx = chain(s, {
    method: 'recourse',
    summary: `${s.merchant.name} bought back ${record.number}`,
    to: RECEIVABLES,
    transfers: paid.map(({ investor, amount: a }) => ({
      from: s.merchant.address,
      to: investor.address,
      amountMinor: a.toString(),
      label: `Buy-back to ${investor.organization}`,
    })),
    events: [
      { name: 'BoughtBack', detail: `${s.merchant.name} paid the holders in full; their tokens are burned` },
    ],
    gasWei: PACT_GAS_WEI,
    gasPaidBy: `Pact relayer, charged to ${s.merchant.name} in USDT`,
  });
  for (const { investor, amount: a } of paid)
    book(s, {
      at: tx.at,
      type: 'Financing buy-back',
      objectId: invoiceId,
      customer: investor.organization,
      grossMinor: -a,
      feeMinor: 0n,
      txHash: tx.hash,
    });
  // The buy-back's network fee, paid in USDT through the Router.
  s.accounting.push({
    id: s.ids.next('acc', 20000),
    at: tx.at,
    type: 'Fee',
    objectId: invoiceId,
    orderId: null,
    customer: s.merchant.name,
    grossMinor: 0n,
    feeMinor: networkFee,
    refundOf: null,
    txHash: tx.hash,
  });
  p.status = 'bought_back';
  p.closedAt = tx.at;
  event(s, p, {
    kind: 'bought_back',
    title: `${s.merchant.name} bought the claim back`,
    detail: `Paid ${usd(amount)} to ${names(paid.map(x => x.investor))}, who are now paid in full. ${debtorName(record)}’s payment, if it comes, now goes to ${s.merchant.name}.`,
    amountMinor: amount,
    txHash: tx.hash,
  });
  return p;
}

/** Why the token cannot move now, or null when transfers are open. */
function transferClosed(s: MockStore, p: FinancingPosition): string | null {
  const at = now(s);
  if (p.status === 'defaulted') return 'The token is frozen because the invoice defaulted.';
  if (p.status === 'repaid' || p.status === 'bought_back')
    return 'The claim is settled; the tokens are burned.';
  if (at >= p.maturityAt) return 'Transfers ended at maturity. The claim can only be repaid now.';
  if (at >= recordDate(p.maturityAt))
    return `No transfers in the ${RECORD_DATE_HOURS} hours before maturity (the record date, ${dateTime(iso(recordDate(p.maturityAt)))}), so the list of who gets paid is fixed.`;
  return null;
}

/** Checks a transfer. Rule refusals are recorded and thrown; plain input mistakes are thrown. */
function checkTransfer(
  s: MockStore,
  p: FinancingPosition,
  from: InvestorRecord,
  to: InvestorRecord,
  face: bigint,
) {
  const h = p.holdings.find(x => x.investorId === from.id);
  if (!h) throw new DataError('not_holder', 'You do not hold part of this invoice.', 409);
  if (to.id === from.id) throw new DataError('invalid_recipient', 'Choose another investor.', 400);
  if (face <= 0n || face > h.faceMinor)
    throw new DataError('invalid_amount', `Enter up to ${usd(h.faceMinor)}, the face value you hold.`, 400);
  if (face < MIN_SHARE && face !== h.faceMinor)
    throw new DataError(
      'invalid_amount',
      `The smallest transfer is ${usd(MIN_SHARE)}, unless you send all you hold.`,
      400,
    );
  const title = `Transfer from ${from.organization} to ${to.organization} refused`;
  const closed = transferClosed(s, p);
  if (closed) refuse(s, p, 'transfer_refused', title, closed);
  if (!isApproved(s, from)) refuse(s, p, 'transfer_refused', title, notApprovedDetail(s, from));
  if (!isApproved(s, to))
    refuse(
      s,
      p,
      'transfer_refused',
      title,
      `${notApprovedDetail(s, to)} Only approved investors can hold this token.`,
    );
  return h;
}

function transferShare(s: MockStore, p: FinancingPosition, fromId: string, toId: string, face: bigint) {
  const from = investorRecord(s, fromId);
  const to = investorRecord(s, toId);
  const h = checkTransfer(s, p, from, to, face);
  const record = invoiceRecord(s, p.invoiceId);
  // The cost basis and anything already received travel with the tokens, pro rata.
  const paid = (h.paidMinor * face) / h.faceMinor;
  const received = (h.receivedMinor * face) / h.faceMinor;
  h.faceMinor -= face;
  h.paidMinor -= paid;
  h.receivedMinor -= received;
  const target = p.holdings.find(x => x.investorId === to.id);
  if (target) {
    target.faceMinor += face;
    target.paidMinor += paid;
    target.receivedMinor += received;
  } else p.holdings.push({ investorId: to.id, faceMinor: face, paidMinor: paid, receivedMinor: received });
  p.holdings = p.holdings.filter(x => x.faceMinor > 0n);
  const tx = chain(s, {
    method: 'transfer',
    summary: `${usd(face)} of ${record.number} moved to ${to.organization}`,
    to: RECEIVABLES,
    transfers: [],
    events: [
      {
        name: 'Transfer',
        detail: `${usd(face)} of ${record.number} receivable tokens from ${from.organization} to ${to.organization}`,
      },
      { name: 'AllowlistChecked', detail: 'Sender and recipient are both approved investors' },
    ],
    gasWei: PACT_GAS_WEI,
    gasPaidBy: 'Pact relayer (investors never need WBT)',
  });
  event(s, p, {
    kind: 'transfer',
    title: `${from.organization} transferred ${usd(face)} to ${to.organization}`,
    detail:
      'Both are approved investors, and the record date has not passed. Any price is agreed between them; the token only checks who may hold it.',
    amountMinor: face,
    txHash: tx.hash,
  });
}

function setApproval(s: MockStore, investorId: string, decision: 'approve' | 'revoke') {
  const investor = investorRecord(s, investorId);
  if (decision === 'approve') {
    investor.approval.status = 'approved';
    investor.approval.expiresAt = now(s) + APPROVAL_DAYS * DAY;
  } else investor.approval.status = 'revoked';
  chain(s, {
    method: decision,
    summary: `${investor.organization} ${decision === 'approve' ? 'approved' : 'revoked'} in the investor registry`,
    to: COMPLIANCE,
    transfers: [],
    events: [
      {
        name: decision === 'approve' ? 'InvestorApproved' : 'InvestorRevoked',
        detail:
          decision === 'approve'
            ? `${investor.organization} (${investor.approval.region}) may hold receivable tokens until ${date(iso(investor.approval.expiresAt!))}`
            : `${investor.organization} can no longer buy, send or receive receivable tokens`,
      },
    ],
    gasWei: PACT_GAS_WEI,
    gasPaidBy: 'Pact compliance',
  });
  return investor;
}

/** After the keeper runs: record date closes listings, maturity starts the grace period, its end defaults. */
function onTick(s: MockStore) {
  const f = state(s);
  if (!f) return;
  const at = now(s);
  for (const p of f.positions) {
    if (p.status === 'requested' && recordDate(p.maturityAt) <= at) {
      const when = recordDate(p.maturityAt);
      if (sold(p) > 0n) closeListing(s, p, 'The record date arrived, 24 hours before maturity.', when);
      else
        withdraw(
          s,
          p,
          'The record date arrived, 24 hours before maturity, before any investor bought it.',
          when,
        );
    }
    if (p.status === 'funded' && p.maturityAt < at && owed(p) > 0n) {
      p.late = true;
      p.status = 'overdue';
      p.overdueAt = p.maturityAt;
      event(s, p, {
        at: p.maturityAt,
        kind: 'overdue',
        title: 'Past maturity and unpaid',
        detail: `${usd(owed(p))} is owed to the holders, now including the ${LATE_FEE_BPS / 100}% late fee. If ${debtorName(invoiceRecord(s, p.invoiceId))} pays by ${date(iso(graceEnd(p)))}, the late fee comes out of the reserve. If not, the invoice defaults.`,
      });
    }
    if (p.status === 'overdue' && graceEnd(p) < at && owed(p) > 0n) defaultPosition(s, p, graceEnd(p));
  }
}

hooks.invoiceCollect.push(collectFinanced);
hooks.tick.push(onTick);

/** Demo control: the invoice's customer pays the remaining balance through the normal invoice flow. */
export function customerPays(s: MockStore, invoiceId: string) {
  const record = invoiceRecord(s, invoiceId);
  const p = currentPosition(s, invoiceId);
  if (!p || !ACTIVE.includes(p.status) || sold(p) === 0n)
    throw new DataError('not_funded', 'Only funded invoices can be paid from here.', 409);
  const c = customer(s, record.customerId);
  const remaining = toMinor(record.invoice.remaining);
  try {
    payInvoice(s, record, c, remaining);
  } catch (error) {
    if (error instanceof DataError && error.code === 'insufficient_funds')
      throw new DataError(
        'insufficient_funds',
        `${c.company ?? c.name} does not have ${usd(remaining)} in their account, so nothing was paid.`,
        409,
      );
    throw error;
  }
}

// ------------------------------------------------------------------ views

function holderView(
  s: MockStore,
  p: FinancingPosition,
  h: Holding,
  viewerId: string | null,
): FinancingHolder {
  const investor = investorRecord(s, h.investorId);
  return {
    id: investor.id,
    name: investor.name,
    organization: investor.organization,
    faceMinor: h.faceMinor.toString(),
    paidMinor: h.paidMinor.toString(),
    receivedMinor: h.receivedMinor.toString(),
    owedMinor: (ACTIVE.includes(p.status) ? owedTo(p, h) : 0n).toString(),
    approved: isApproved(s, investor),
    you: investor.id === viewerId,
  };
}

function view(
  s: MockStore,
  record: InvoiceRecord,
  audience: 'merchant' | 'investor',
  viewerId: string | null = null,
): FinancedInvoice {
  const f = state(s);
  const p = currentPosition(s, record.invoice.id);
  const c = s.customers.find(item => item.id === record.customerId);
  const face = p?.faceMinor ?? toMinor(record.invoice.amount);
  const price = p
    ? {
        dayRateBps: p.dayRateBps,
        days: p.pricedDays,
        latePremiumBps: p.latePremiumBps,
        discountBps: p.discountBps,
      }
    : pricing(s, record);
  const quoted = amounts(face, price.discountBps);
  const maturity = p?.maturityAt ?? dueOf(record) ?? now(s);
  const days = Math.max(0, Math.ceil((maturity - (p?.fundedAt ?? now(s))) / DAY));
  const returnBps = quoted.price > 0n ? Number(((face - quoted.price) * 10_000n) / quoted.price) : 0;
  const soldFace = p ? sold(p) : 0n;
  const holdings = p?.holdings ?? [];
  const visible = audience === 'merchant' ? holdings : holdings.filter(h => h.investorId === viewerId);
  const history = (f?.positions ?? []).filter(
    item => item.invoiceId === record.invoice.id && (audience === 'merchant' || item === p),
  );
  const timeline = history
    .flatMap(item => item.events)
    .sort((a, b) => b.at - a.at)
    .map(e => ({
      id: e.id,
      at: iso(e.at),
      kind: e.kind,
      title: e.title,
      detail: e.detail,
      amountMinor: e.amountMinor?.toString() ?? null,
      txHash: e.txHash,
    }));
  const ledger =
    audience === 'merchant'
      ? s.accounting
          .filter(e => e.objectId === record.invoice.id)
          .sort((a, b) => a.at - b.at)
          .map(e => ({
            at: iso(e.at),
            type: e.type,
            grossMinor: e.grossMinor.toString(),
            feeMinor: e.feeMinor.toString(),
            netMinor: (e.grossMinor - e.feeMinor).toString(),
            txHash: e.txHash,
          }))
      : [];
  const closed = p ? transferClosed(s, p) : 'Nothing has been issued yet.';
  const transfers: TransferRules = {
    open: p !== null && (p.status === 'requested' || p.status === 'funded') && closed === null,
    reason: closed,
    recordDateAt: iso(recordDate(maturity)),
  };
  const active = p !== null && ACTIVE.includes(p.status);
  return {
    invoiceId: record.invoice.id,
    number: record.number,
    merchantName: s.merchant.name,
    invoiceStatus: record.invoice.status,
    createdAt: record.invoice.createdAt,
    dueAt: record.invoice.dueAt,
    lines: record.invoice.lines.map(line => ({
      description: line.description,
      quantity: line.quantity,
      amountMinor: toMinor(line.amount).toString(),
    })),
    debtor: {
      name: c?.name ?? record.invoice.customerEmail,
      company: record.customerName ?? c?.company ?? null,
      email: audience === 'merchant' ? record.invoice.customerEmail : null,
    },
    acknowledged: record.acknowledgement !== null,
    debtorHistory: debtorHistory(s, record),
    status: p ? (p.status as FinancingStatus) : ineligible(s, record) ? null : 'eligible',
    ineligibleReason: p ? null : ineligible(s, record),
    terms: {
      faceMinor: face.toString(),
      pricing: { dayRateBps: price.dayRateBps, days: price.days, latePremiumBps: price.latePremiumBps },
      discountBps: price.discountBps,
      feeBps: FEE_BPS,
      reserveBps: RESERVE_BPS,
      lateFeeBps: LATE_FEE_BPS,
      graceDays: GRACE_DAYS,
      priceMinor: quoted.price.toString(),
      discountMinor: (face - quoted.price).toString(),
      feeMinor: quoted.fee.toString(),
      reserveMinor: quoted.reserve.toString(),
      netAdvanceMinor: quoted.net.toString(),
      upfrontMinor: quoted.upfront.toString(),
      lateFeeMinor: bps(face, LATE_FEE_BPS).toString(),
      maturityAt: iso(maturity),
      graceEndsAt: iso(maturity + GRACE_DAYS * DAY),
      recordDateAt: iso(recordDate(maturity)),
      days,
      returnBps,
      annualBps: days > 0 ? Math.round((returnBps * 365) / days) : 0,
    },
    assumptions: FINANCING_ASSUMPTIONS,
    funding: {
      soldMinor: soldFace.toString(),
      unsoldMinor: (p ? face - soldFace : face).toString(),
      open: p?.status === 'requested',
      priceMinor: (p?.raisedMinor ?? 0n).toString(),
      feeMinor: (p?.feeTakenMinor ?? 0n).toString(),
      reserveMinor: (p?.reserveFundedMinor ?? 0n).toString(),
      upfrontMinor: (p ? p.raisedMinor - p.feeTakenMinor - p.reserveFundedMinor : 0n).toString(),
    },
    holders: p ? visible.map(h => holderView(s, p, h, viewerId)) : [],
    otherHolders: audience === 'investor' ? holdings.length - visible.length : 0,
    reserve: {
      heldMinor: (p?.reserveHeldMinor ?? 0n).toString(),
      releasedMinor: (p?.reserveReleasedMinor ?? 0n).toString(),
      toInvestorsMinor: (p?.reserveToInvestorsMinor ?? 0n).toString(),
    },
    late: p?.late ?? false,
    frozen: p?.status === 'defaulted',
    transfers,
    buyBackMinor: (p?.status === 'defaulted' ? owed(p) : 0n).toString(),
    requestedAt: p ? iso(p.requestedAt) : null,
    fundedAt: p?.fundedAt ? iso(p.fundedAt) : null,
    repaidAt: p?.status === 'repaid' && p.closedAt ? iso(p.closedAt) : null,
    overdueAt: p?.overdueAt ? iso(p.overdueAt) : null,
    defaultedAt: p?.defaultedAt ? iso(p.defaultedAt) : null,
    boughtBackAt: p?.status === 'bought_back' && p.closedAt ? iso(p.closedAt) : null,
    customerOwesMinor: toMinor(record.invoice.remaining).toString(),
    receivedMinor: sumBig(holdings, h => h.receivedMinor).toString(),
    outstandingMinor: (active && p ? owed(p) : 0n).toString(),
    advanceTxHash: p?.advanceTx ?? null,
    timeline,
    ledger,
  };
}

function investorAccount(s: MockStore, viewer: Viewer): InvestorAccount {
  const investor = investorRecord(s, viewer.userId);
  return {
    name: investor.name,
    organization: investor.organization,
    availableMinor: investor.usdtMinor.toString(),
    approval: approvalView(s, investor),
  };
}

function registryInvestor(s: MockStore, investor: InvestorRecord): RegistryInvestor {
  const open = state(s)!.positions.filter(p => ACTIVE.includes(p.status));
  const held = open.flatMap(p => p.holdings.filter(h => h.investorId === investor.id));
  return {
    id: investor.id,
    name: investor.name,
    organization: investor.organization,
    email: investor.email,
    address: investor.address,
    approval: approvalView(s, investor),
    appliedAt: iso(investor.approval.appliedAt),
    heldMinor: sumBig(held, h => h.faceMinor).toString(),
    positions: held.length,
  };
}

/** The explorer page for a financing transaction, or null when the hash is not one. */
export function financingTransaction(s: MockStore, hash: string): ExplorerTx | null {
  const lower = hash.toLowerCase();
  const tx = state(s)?.chain.find(item => item.hash.toLowerCase() === lower);
  if (!tx) return null;
  return {
    hash: tx.hash,
    status: 'success',
    block: String(11_930_519 + Math.floor((tx.at - Date.UTC(2026, 10, 1)) / 1000)),
    at: iso(tx.at),
    method: tx.method,
    summary: tx.summary,
    from: RELAYER,
    to: tx.to,
    transfers: tx.transfers,
    gasWei: tx.gasWei.toString(),
    gasPaidBy: tx.gasPaidBy,
    events: tx.events,
  };
}

const STATUS_ORDER: FinancingStatus[] = [
  'defaulted',
  'overdue',
  'requested',
  'funded',
  'eligible',
  'repaid',
  'bought_back',
];

// ------------------------------------------------------------------ agents

const FUNDS_DETAIL =
  'The agent account held less USDT than the price, so the facilitator refused it before settlement.';
/** Refusals from the agent account itself: it will not sign the payment. */
const ACCOUNT_REASONS = ['SessionRevoked', 'SessionExpired', 'MerchantDenied', 'PerCallCap', 'DailyCap'];

const refusalDetail = (reason: string) =>
  reason === 'InsufficientFunds' ? FUNDS_DETAIL : reasonDetail(reason);

/** Funding less everything the agent settled, with any merchant. Null when the account is not tracked. */
function agentBalance(s: MockStore, agentId: string): bigint | null {
  const funded = state(s)?.agentFundingMinor[agentId];
  if (funded === undefined) return null;
  const spent = s.agentCalls
    .filter(c => c.agentId === agentId && c.status === 'settled')
    .reduce((sum, c) => sum + BigInt(c.amountMinor), 0n);
  return funded - spent;
}

function sessionView(s: MockStore, record: AgentRecord): AgentSession {
  const today = dayKey(now(s));
  return {
    ...record.session,
    allowedMerchants: [...record.session.allowedMerchants],
    spentTodayMinor: (record.spentByDay[today] ?? 0n).toString(),
    callsToday: record.callsByDay[today] ?? 0,
  };
}

const merchantCalls = (s: MockStore) => s.agentCalls.filter(c => c.merchantName === s.merchant.name);

function merchantAgent(s: MockStore, record: AgentRecord, calls: AgentCall[]): MerchantAgent {
  const today = dayKey(now(s));
  const owner = s.customers.find(c => c.id === record.customerId);
  const mine = calls.filter(c => c.agentId === record.session.id);
  const todays = mine.filter(c => c.createdAt.startsWith(today));
  return {
    session: sessionView(s, record),
    owner: { id: record.customerId, name: owner?.name ?? 'Unknown owner', company: owner?.company ?? null },
    balanceMinor: agentBalance(s, record.session.id)?.toString() ?? null,
    paidToYouTodayMinor: todays
      .filter(c => c.status === 'settled')
      .reduce((sum, c) => sum + BigInt(c.amountMinor), 0n)
      .toString(),
    settledToday: todays.filter(c => c.status === 'settled').length,
    refusedToday: todays.filter(c => c.status === 'refused').length,
    recent: mine.slice(0, 5),
  };
}

function agentsFor(s: MockStore) {
  const calls = merchantCalls(s);
  return s.agents.filter(
    a =>
      a.session.allowedMerchants.some(m => m.address === s.merchant.address) ||
      calls.some(c => c.agentId === a.session.id),
  );
}

const endpointView = (e: PaidEndpoint) => ({
  id: e.id,
  method: e.method,
  path: e.path,
  description: e.description,
  priceMinor: e.priceMinor,
  scheme: e.scheme,
});

/** The demo presets, described from the live caps and balances so the text matches what the engine will do. */
function scenarios(s: MockStore): AgentScenario[] {
  const pick = (agentId: string, endpointId: string) => {
    const record = s.agents.find(a => a.session.id === agentId);
    const endpoint = s.endpoints.find(e => e.id === endpointId);
    return record && endpoint ? { record, endpoint } : null;
  };
  const owner = (record: AgentRecord) =>
    s.customers.find(c => c.id === record.customerId)?.company ?? 'its owner';
  const price = (e: PaidEndpoint) => (e.scheme === 'upto' ? `up to ${usd(e.priceMinor)}` : usd(e.priceMinor));
  const list: AgentScenario[] = [];
  const paid = pick('agt_claims', 'ep_risk');
  if (paid)
    list.push({
      id: 'paid',
      label: 'Paid and answered',
      description: `${owner(paid.record)}’s ${paid.record.session.name} asks for ${paid.endpoint.path} at ${price(paid.endpoint)}, inside its ${usd(paid.record.session.perCallCapMinor)} per-call cap.`,
      agentId: paid.record.session.id,
      endpointId: paid.endpoint.id,
    });
  const over = pick('agt_claims', 'ep_usage');
  if (over)
    list.push({
      id: 'over_cap',
      label: 'Over the owner’s cap',
      description: `The same agent asks for ${over.endpoint.path}, which costs ${price(over.endpoint)}. ${owner(over.record)} capped it at ${usd(over.record.session.perCallCapMinor)} a call.`,
      agentId: over.record.session.id,
      endpointId: over.endpoint.id,
    });
  const broke = pick('agt_ledger', 'ep_usage');
  if (broke) {
    const balance = agentBalance(s, broke.record.session.id) ?? 0n;
    list.push({
      id: 'insufficient_funds',
      label: 'Not enough funds',
      description: `${owner(broke.record)}’s ${broke.record.session.name} account holds ${usd(balance)}, less than the ${usd(broke.endpoint.priceMinor)} a usage report can cost.`,
      agentId: broke.record.session.id,
      endpointId: broke.endpoint.id,
    });
  }
  return list;
}

/**
 * One paid request through the x402 engine (engine.agentCall). The engine does not track agent
 * balances, so the facilitator's balance check runs first for accounts this part funds.
 */
function paidRequest(s: MockStore, record: AgentRecord, endpoint: PaidEndpoint, url: string): AgentCall {
  const balance = agentBalance(s, record.session.id);
  const price = BigInt(endpoint.priceMinor);
  if (record.session.status === 'active' && balance !== null && balance < price) {
    refusal(s, {
      source: 'agent',
      reason: 'InsufficientFunds',
      objectId: record.session.id,
      actor: record.session.name,
      detail: FUNDS_DETAIL,
    });
    const call: AgentCall = {
      id: s.ids.next('call', 30000),
      agentId: record.session.id,
      agentName: record.session.name,
      merchantName: s.merchant.name,
      method: 'GET',
      url,
      scheme: endpoint.scheme,
      priceMinor: price.toString(),
      amountMinor: '0',
      status: 'refused',
      reason: 'InsufficientFunds',
      txHash: null,
      responseStatus: 402,
      responseBody: null,
      createdAt: iso(now(s)),
    };
    s.agentCalls.unshift(call);
    return call;
  }
  return agentCall(s, record, endpoint, s.merchant, url);
}

function trace(s: MockStore, call: AgentCall): AgentRequestTrace {
  const record = s.agents.find(a => a.session.id === call.agentId);
  if (!record) throw notFound('Agent');
  const endpoint = s.endpoints.find(e => call.url.startsWith(e.path)) ?? null;
  const stage: AgentRefusalStage | null = call.reason
    ? ACCOUNT_REASONS.includes(call.reason)
      ? 'authorise'
      : 'settle'
    : null;
  return {
    call: { ...call },
    agent: merchantAgent(s, record, merchantCalls(s)),
    endpoint: endpoint ? endpointView(endpoint) : null,
    merchant: { name: s.merchant.name, address: s.merchant.address },
    network: NETWORK,
    feeMinor: s.merchant.agentFeeMinor.toString(),
    refusal: call.reason && stage ? { reason: call.reason, detail: refusalDetail(call.reason), stage } : null,
  };
}

const QUERIES: Record<string, string[]> = {
  ep_risk: ['BB-2041', 'BB-2044', 'BB-2047', 'BB-2050', 'BB-2052'],
  ep_usage: ['team=claims', 'team=finance', 'team=ops'],
};

function requestUrl(s: MockStore, endpoint: PaidEndpoint) {
  const options = QUERIES[endpoint.id] ?? [''];
  const pick = s.random.pick(options);
  return endpoint.id === 'ep_risk' ? `${endpoint.path}?invoice=${pick}` : `${endpoint.path}?${pick}`;
}

// ------------------------------------------------------------------- seed

/** Runs `work` with the demo clock at `ms`, then puts the clock back. */
function at<T>(s: MockStore, ms: number, work: () => T): T {
  const saved = now(s);
  setNow(s, ms);
  try {
    return work();
  } finally {
    setNow(s, saved);
  }
}

function seedInvoice(
  s: MockStore,
  input: {
    id: string;
    number: string;
    customerId: string;
    lines: Array<[string, number, number]>;
    createdAt: number;
    dueAt: number;
    memo?: string;
  },
): InvoiceRecord {
  const c = customer(s, input.customerId);
  const total = input.lines.reduce((sum, [, qty, price]) => sum + USDT(price) * BigInt(qty), 0n);
  const dec = (minor: bigint) => `${minor / 1_000_000n}.${(minor % 1_000_000n).toString().padStart(6, '0')}`;
  const record: InvoiceRecord = {
    invoice: {
      id: input.id,
      status: 'sent',
      hostedUrl: `/invoice/${input.id}`,
      customerEmail: c.email,
      amount: dec(total),
      paid: dec(0n),
      remaining: dec(total),
      allowPartial: false,
      dueAt: iso(input.dueAt),
      memo: input.memo ?? '',
      metadata: {},
      createdAt: iso(input.createdAt),
      lines: input.lines.map(([description, quantity, price], index) => ({
        id: `${input.id}_l${index + 1}`,
        description,
        quantity,
        unitAmount: dec(USDT(price)),
        amount: dec(USDT(price) * BigInt(quantity)),
      })),
    },
    number: input.number,
    customerId: c.id,
    customerName: c.company,
    acknowledgement: null,
    reminders: reminderSchedule(input.dueAt),
    activity: [
      { type: 'created', at: iso(input.createdAt), detail: 'Invoice created' },
      { type: 'sent', at: iso(input.createdAt + 20 * 60_000), detail: `Sent to ${c.email}` },
    ],
  };
  s.invoices.unshift(record);
  return record;
}

function acknowledge(s: MockStore, record: InvoiceRecord, ms: number) {
  at(s, ms, () => {
    const c = customer(s, record.customerId);
    const signed = sponsor(s, {
      action: 'invoice_acknowledge',
      objectId: `${record.invoice.id}:ack`,
      label: `Acknowledgement of ${record.number}`,
      payer: c.address,
    });
    if (!signed.ok) return;
    record.acknowledgement = { signedAt: iso(ms), signer: c.address, txHash: signed.txHash };
    record.invoice.status = 'acknowledged';
    record.activity.push({
      type: 'acknowledged',
      at: iso(ms),
      detail: `${c.name} signed “I owe this invoice”`,
      txHash: signed.txHash,
    });
  });
}

/** Marks the reminders the keeper would have sent before `until`. */
function remindUntil(record: InvoiceRecord, until: number) {
  for (const reminder of record.reminders) {
    if (reminder.sentAt || new Date(reminder.dueAt).getTime() > until) continue;
    reminder.sentAt = reminder.dueAt;
    record.activity.push({
      type: 'reminder',
      at: reminder.dueAt,
      detail: `Reminder sent (${reminder.stage === 'seven_days' ? '7 days' : '1 day'} before due)`,
    });
  }
}

function seedAgent(
  s: MockStore,
  input: {
    id: string;
    customerId: string;
    name: string;
    description: string;
    perCall: number;
    daily: number;
    createdAt: number;
  },
): AgentRecord {
  const record: AgentRecord = {
    session: {
      id: input.id,
      name: input.name,
      description: input.description,
      account: s.ids.address(),
      sessionKey: s.ids.address(),
      perCallCapMinor: USDT(input.perCall).toString(),
      dailyCapMinor: USDT(input.daily).toString(),
      allowedMerchants: [{ address: s.merchant.address, name: s.merchant.name }],
      expiresAt: iso(now(s) + 30 * DAY),
      status: 'active',
      spentTodayMinor: '0',
      callsToday: 0,
      createdAt: iso(input.createdAt),
    },
    customerId: input.customerId,
    spentByDay: {},
    callsByDay: {},
  };
  s.agents.push(record);
  return record;
}

/** Seeds a paid invoice, paid `lateDays` after it was due, so the customer has a late-payment record. */
function seedPaidLate(
  s: MockStore,
  input: { id: string; number: string; customerId: string; amount: number; dueAt: number; lateDays: number },
) {
  const record = seedInvoice(s, {
    id: input.id,
    number: input.number,
    customerId: input.customerId,
    lines: [['Discovery workshop', 1, input.amount]],
    createdAt: input.dueAt - 14 * DAY,
    dueAt: input.dueAt,
  });
  at(s, input.dueAt + input.lateDays * DAY, () => {
    try {
      payInvoice(s, record, customer(s, input.customerId), toMinor(record.invoice.remaining));
    } catch {
      // Refused in history: the invoice simply stays unpaid.
    }
  });
  return record;
}

/**
 * Seeds the financing story after the main fixtures, with three investors in the registry
 * (two approved, one pending):
 * - INV-1048 repaid on time by Monograph; Lotus Capital got face value and the reserve went back.
 * - INV-1051 split between Harbor Street and Lotus, past maturity and in its grace period.
 * - INV-1055 split between Lotus and Harbor Street, due in 18 days. Bluebird's balance is low.
 * - INV-1057 listed, Harbor Street bought part; priced higher because Tideworks paid late before.
 * - INV-1060 acknowledged and ready to finance. INV-1042 is not acknowledged yet, so it cannot be.
 * Then two more agents paying Kite Labs, and request `req_001`.
 */
export function seedFinancing(s: MockStore): FinancingState {
  const base = now(s);
  const f: FinancingState = {
    positions: [],
    chain: [],
    investors: [
      {
        id: INVESTOR_ID,
        name: 'Arjun Mehta',
        organization: 'Lotus Capital',
        email: 'arjun@lotuscapital.example',
        address: s.ids.address(),
        usdtMinor: USDT(60_000),
        approval: {
          status: 'approved',
          region: 'IN',
          expiresAt: base + 300 * DAY,
          appliedAt: base - 65 * DAY,
        },
      },
      {
        id: HARBOR_ID,
        name: 'Mei Tan',
        organization: 'Harbor Street Partners',
        email: 'mei@harborstreet.example',
        address: s.ids.address(),
        usdtMinor: USDT(40_000),
        approval: {
          status: 'approved',
          region: 'SG',
          expiresAt: base + 200 * DAY,
          appliedAt: base - 120 * DAY,
        },
      },
      {
        id: NORTHGATE_ID,
        name: 'Oliver Grant',
        organization: 'Northgate Fund',
        email: 'oliver@northgate.example',
        address: s.ids.address(),
        usdtMinor: USDT(25_000),
        approval: { status: 'pending', region: 'GB', expiresAt: null, appliedAt: base - 2 * DAY },
      },
    ],
    agentFundingMinor: {
      agt_research: USDT(20),
      agt_procurement: USDT(5),
      agt_pricing: USDT(40),
      agt_claims: USDT(5),
      agt_ledger: USDT(0.03),
    },
  };
  // The hooks read the state, so it is attached before the history below runs.
  s.financing = f;
  const dueEndOfDay = (ms: number) => new Date(ms).setUTCHours(23, 59, 0, 0);
  const buy = (investorId: string, invoiceId: string, dollars: number) =>
    purchaseShare(s, investorId, invoiceId, USDT(dollars));

  // Tideworks paid an earlier invoice six days late, so its next one is priced 1% lower.
  seedPaidLate(s, {
    id: 'inv_1033',
    number: 'INV-1033',
    customerId: 'cus_tideworks',
    amount: 600,
    dueAt: dueEndOfDay(base - 40 * DAY),
    lateDays: 6,
  });

  // Repaid: financed a month ago, paid by the customer before maturity.
  const repaid = seedInvoice(s, {
    id: 'inv_1048',
    number: 'INV-1048',
    customerId: 'cus_monograph',
    lines: [
      ['Brand guidelines, print edition', 1, 1_400],
      ['Packaging templates', 2, 200],
    ],
    createdAt: base - 34 * DAY,
    dueAt: dueEndOfDay(base - 3 * DAY),
  });
  acknowledge(s, repaid, base - 33 * DAY);
  at(s, base - 33 * DAY + 2 * HOUR, () => requestFinancing(s, repaid.invoice.id));
  at(s, base - 32 * DAY, () => buy(INVESTOR_ID, repaid.invoice.id, 1_800));
  remindUntil(repaid, base - 5 * DAY);
  at(s, base - 5 * DAY, () => {
    try {
      customerPays(s, repaid.invoice.id);
    } catch {
      // Refused in history (for example, not enough funds): the position simply stays funded.
    }
  });

  // In grace: split between two investors, due three days ago and unpaid. Orbit's balance is small.
  const grace = seedInvoice(s, {
    id: 'inv_1051',
    number: 'INV-1051',
    customerId: 'cus_orbit',
    lines: [
      ['Inventory sync integration', 1, 2_000],
      ['Warehouse staff training', 2, 200],
    ],
    createdAt: base - 40 * DAY,
    dueAt: dueEndOfDay(base - 3 * DAY),
  });
  acknowledge(s, grace, base - 39 * DAY);
  at(s, base - 39 * DAY + 3 * HOUR, () => requestFinancing(s, grace.invoice.id));
  at(s, base - 38 * DAY, () => buy(HARBOR_ID, grace.invoice.id, 1_400));
  at(s, base - 37 * DAY, () => buy(INVESTOR_ID, grace.invoice.id, 1_000));
  remindUntil(grace, base - 3 * DAY);

  // Funded: split between Lotus and Harbor Street, due in two and a half weeks. Bluebird's balance is low.
  const funded = seedInvoice(s, {
    id: 'inv_1055',
    number: 'INV-1055',
    customerId: 'cus_bluebird',
    lines: [['Patient portal, phase 2 build', 1, 3_200]],
    createdAt: base - 12 * DAY,
    dueAt: dueEndOfDay(base + 18 * DAY),
  });
  acknowledge(s, funded, base - 11 * DAY);
  at(s, base - 11 * DAY + 3 * HOUR, () => requestFinancing(s, funded.invoice.id));
  at(s, base - 10 * DAY, () => buy(INVESTOR_ID, funded.invoice.id, 2_000));
  at(s, base - 9 * DAY, () => buy(HARBOR_ID, funded.invoice.id, 1_200));

  // Listed: requested yesterday, Harbor Street bought part, the rest is for sale.
  const listed = seedInvoice(s, {
    id: 'inv_1057',
    number: 'INV-1057',
    customerId: 'cus_tideworks',
    lines: [
      ['Booking flow redesign', 1, 1_850],
      ['Usability testing, two rounds', 2, 200],
    ],
    createdAt: base - 4 * DAY,
    dueAt: dueEndOfDay(base + 25 * DAY),
  });
  acknowledge(s, listed, base - 3 * DAY);
  at(s, base - DAY, () => requestFinancing(s, listed.invoice.id));
  at(s, base - 20 * HOUR, () => buy(HARBOR_ID, listed.invoice.id, 1_000));

  // INV-1060: sent, acknowledged, unpaid and due in 30 days, so it starts eligible.
  const ready = seedInvoice(s, {
    id: 'inv_1060',
    number: 'INV-1060',
    customerId: 'cus_northwind',
    lines: [
      ['Checkout redesign, phase 2', 1, 4_000],
      ['Accessibility review', 1, 800],
    ],
    createdAt: base - 2 * DAY,
    dueAt: dueEndOfDay(base + 30 * DAY),
    memo: 'Phase 2 covers the new checkout and an accessibility review before launch.',
  });
  acknowledge(s, ready, base - DAY);

  // Two more agents paying Kite Labs: one inside a tight cap, one with an almost empty account.
  const claims = seedAgent(s, {
    id: 'agt_claims',
    customerId: 'cus_bluebird',
    name: 'Claims assistant',
    description: 'Scores supplier invoices before Bluebird approves a claim',
    perCall: 0.02,
    daily: 0.2,
    createdAt: base - 9 * DAY,
  });
  seedAgent(s, {
    id: 'agt_ledger',
    customerId: 'cus_monograph',
    name: 'Ledger sync',
    description: 'Pulls usage reports into Monograph’s books',
    perCall: 0.05,
    daily: 0.5,
    createdAt: base - 3 * DAY,
  });
  const risk = s.endpoints.find(e => e.id === 'ep_risk');
  const usage = s.endpoints.find(e => e.id === 'ep_usage');
  if (risk && usage) {
    const history: Array<[number, PaidEndpoint, string]> = [
      [base - 6 * DAY + 3 * HOUR, risk, `${risk.path}?invoice=BB-2031`],
      [base - 4 * DAY + 5 * HOUR, risk, `${risk.path}?invoice=BB-2036`],
      [base - 2 * DAY + 4 * HOUR, usage, `${usage.path}?team=claims`],
      [base - 2 * DAY + 4 * HOUR + 60_000, risk, `${risk.path}?invoice=BB-2039`],
    ];
    for (const [ms, endpoint, url] of history) at(s, ms, () => paidRequest(s, claims, endpoint, url));
  }

  // History ran with the clock set back, so put the shared newest-first lists back in order.
  const newestFirst = <T>(list: T[], key: (item: T) => string) =>
    list.sort((a, b) => key(b).localeCompare(key(a)));
  newestFirst(s.relayed, e => e.createdAt);
  newestFirst(s.webhookEvents, e => e.created_at);
  newestFirst(s.webhookDeliveries, d => d.next_at);
  newestFirst(s.agentCalls, c => c.createdAt);
  newestFirst(s.refusals, r => r.createdAt);
  newestFirst(s.invoices, i => i.invoice.createdAt);
  f.chain.sort((a, b) => b.at - a.at);

  // req_001: a completed 402 → paid → responded request from Acme's research agent, before today.
  const today = dayKey(base);
  const settled = s.agentCalls.filter(c => c.merchantName === s.merchant.name && c.status === 'settled');
  const story =
    settled.find(c => c.agentId === 'agt_research' && !c.createdAt.startsWith(today)) ?? settled[0];
  if (story) story.id = 'req_001';
  return f;
}

// ---------------------------------------------------------------- source

export function createMockFinancing(kit: MockKit): FinancingData {
  const asInvestor = () => requireViewer(['investor']);
  const asCompliance = () => requireViewer(['compliance']);
  const financing = async () => {
    const s = await kit.current();
    if (!state(s)) throw new DataError('unavailable', 'Financing is not set up.', 409);
    return s;
  };
  /** A listing any investor may see, or a position the viewer holds part of. */
  const visible = (s: MockStore, viewer: Viewer, invoiceId: string) => {
    const p = currentPosition(s, invoiceId);
    const holds = Boolean(p?.holdings.some(h => h.investorId === viewer.userId));
    if (!p || (p.status !== 'requested' && !holds)) throw notFound('Listing');
    return { p, record: invoiceRecord(s, invoiceId), holds };
  };
  const minor = (value: string, label: string) => {
    if (!/^\d+$/.test(value) || BigInt(value) <= 0n)
      throw new DataError('invalid_amount', `${label} must be more than zero.`, 400);
    return BigInt(value);
  };
  const deadline = (s: MockStore) => String(Math.floor(now(s) / 1000) + 300);

  return {
    async overview() {
      await kit.readMerchant();
      const s = await financing();
      const f = state(s)!;
      const rows = s.invoices
        .map(record => ({ record, status: statusOf(s, record) }))
        .filter((row): row is { record: InvoiceRecord; status: FinancingStatus } => row.status !== null)
        .map(row => view(s, row.record, 'merchant'))
        .sort(
          (a, b) =>
            STATUS_ORDER.indexOf(a.status!) - STATUS_ORDER.indexOf(b.status!) ||
            (a.dueAt ?? '').localeCompare(b.dueAt ?? ''),
        );
      const totals = Object.fromEntries(
        STATUS_ORDER.map(status => {
          const matching = rows.filter(r => r.status === status);
          return [
            status,
            {
              count: matching.length,
              faceMinor: matching.reduce((sum, r) => sum + BigInt(r.terms.faceMinor), 0n).toString(),
            },
          ];
        }),
      ) as Record<FinancingStatus, { count: number; faceMinor: string }>;
      const started = f.positions.filter(p => CURRENT.includes(p.status));
      return {
        invoices: rows,
        totals,
        advancedMinor: sumBig(
          started,
          p => p.raisedMinor - p.feeTakenMinor - p.reserveFundedMinor,
        ).toString(),
        reserveHeldMinor: sumBig(started, p => p.reserveHeldMinor).toString(),
        forwardedMinor: sumBig(
          s.accounting.filter(e => e.type === 'Financing repayment'),
          e => -e.grossMinor,
        ).toString(),
        buyBackOwedMinor: sumBig(
          started.filter(p => p.status === 'defaulted'),
          p => owed(p),
        ).toString(),
        ineligibleCount: s.invoices.filter(r => r.invoice.status !== 'paid' && statusOf(s, r) === null)
          .length,
        assumptions: FINANCING_ASSUMPTIONS,
      };
    },
    async invoice(invoiceId) {
      await kit.readMerchant();
      const s = await financing();
      return view(s, invoiceRecord(s, invoiceId), 'merchant');
    },
    async prepareRequest(invoiceId) {
      const viewer = await kit.writeMerchant();
      const s = await financing();
      const record = invoiceRecord(s, invoiceId);
      if (currentPosition(s, invoiceId))
        throw new DataError('already_requested', 'Financing was already requested for this invoice.', 409);
      const reason = ineligible(s, record);
      if (reason) throw new DataError('not_eligible', reason, 409);
      const face = toMinor(record.invoice.amount);
      const price = pricing(s, record);
      const quoted = amounts(face, price.discountBps);
      return kit.prepare(
        s,
        viewer,
        'invoice_listing',
        { invoiceId },
        {
          title: `List ${record.number} for investors`,
          signer: 'merchant',
          lines: [
            { label: 'Face value', value: usd(face) },
            { label: 'Investors pay', value: `${usd(quoted.price)} (${price.discountBps / 100}% off)` },
            { label: 'You receive at once', value: `${usd(quoted.upfront)} if all of it sells` },
            { label: 'Customer pays', value: 'The contract, which pays the investors' },
          ],
        },
        kit.typedData('Pact Receivables', RECEIVABLES, 'List', {
          invoice: record.invoice.id,
          merchant: s.merchant.address,
          faceValue: face.toString(),
          discountBps: String(price.discountBps),
          deadline: deadline(s),
        }),
      );
    },
    async submitRequest(token, signature) {
      const viewer = await kit.writeMerchant();
      const s = await financing();
      const { invoiceId } = kit.consume(s, viewer, 'invoice_listing', token, signature);
      requestFinancing(s, invoiceId);
      return view(s, invoiceRecord(s, invoiceId), 'merchant');
    },
    async prepareCancel(invoiceId) {
      const viewer = await kit.writeMerchant();
      const s = await financing();
      const record = invoiceRecord(s, invoiceId);
      const p = currentPosition(s, invoiceId);
      if (!p) throw new DataError('not_requested', 'There is no financing request to cancel.', 409);
      if (p.status !== 'requested')
        throw new DataError(
          'already_funded',
          'The listing is already closed, so it can no longer be cancelled.',
          409,
        );
      return kit.prepare(
        s,
        viewer,
        'invoice_listing_cancel',
        { invoiceId },
        {
          title:
            sold(p) > 0n ? `Close the listing for ${record.number}` : `Cancel financing for ${record.number}`,
          signer: 'merchant',
          lines:
            sold(p) > 0n
              ? [
                  { label: 'Investors keep', value: usd(sold(p)) },
                  { label: 'You keep', value: usd(p.faceMinor - sold(p)) },
                ]
              : [{ label: 'Effect', value: 'Taken off the marketplace. No money has moved.' }],
        },
        kit.typedData('Pact Receivables', RECEIVABLES, 'Cancel', {
          invoice: record.invoice.id,
          merchant: s.merchant.address,
          deadline: deadline(s),
        }),
      );
    },
    async submitCancel(token, signature) {
      const viewer = await kit.writeMerchant();
      const s = await financing();
      const { invoiceId } = kit.consume(s, viewer, 'invoice_listing_cancel', token, signature);
      cancelFinancing(s, invoiceId);
      return view(s, invoiceRecord(s, invoiceId), 'merchant');
    },
    async prepareBuyBack(invoiceId) {
      const viewer = await kit.writeMerchant();
      const s = await financing();
      const record = invoiceRecord(s, invoiceId);
      const p = currentPosition(s, invoiceId);
      if (!p || p.status !== 'defaulted')
        throw new DataError('not_defaulted', 'Only a defaulted invoice can be bought back.', 409);
      const amount = owed(p);
      if (s.merchant.usdtMinor < amount)
        throw new DataError(
          'insufficient_funds',
          `You have ${usd(s.merchant.usdtMinor)}; the buy-back is ${usd(amount)}.`,
          409,
        );
      return kit.prepare(
        s,
        viewer,
        'invoice_buy_back',
        { invoiceId },
        {
          title: `Buy back ${record.number}`,
          signer: 'merchant',
          lines: [
            { label: 'You pay', value: usd(amount) },
            { label: 'To', value: names(p.holdings.map(h => investorRecord(s, h.investorId))) },
            { label: 'Then', value: `${debtorName(record)}’s payment comes to you` },
          ],
        },
        kit.typedData('Pact Receivables', RECEIVABLES, 'Recourse', {
          invoice: record.invoice.id,
          merchant: s.merchant.address,
          amount: amount.toString(),
          deadline: deadline(s),
        }),
      );
    },
    async submitBuyBack(token, signature) {
      const viewer = await kit.writeMerchant();
      const s = await financing();
      const { invoiceId } = kit.consume(s, viewer, 'invoice_buy_back', token, signature);
      buyBack(s, invoiceId);
      return view(s, invoiceRecord(s, invoiceId), 'merchant');
    },

    async marketplace() {
      const viewer = await asInvestor();
      const s = await financing();
      const listings = state(s)!
        .positions.filter(p => p.status === 'requested')
        .sort((a, b) => a.maturityAt - b.maturityAt)
        .map(p => view(s, invoiceRecord(s, p.invoiceId), 'investor', viewer.userId));
      return { investor: investorAccount(s, viewer), listings, assumptions: FINANCING_ASSUMPTIONS };
    },
    async listing(invoiceId) {
      const viewer = await asInvestor();
      const s = await financing();
      const { record, holds } = visible(s, viewer, invoiceId);
      const counterparties: Counterparty[] = state(s)!
        .investors.filter(i => i.id !== viewer.userId)
        .map(i => ({ id: i.id, organization: i.organization, approved: isApproved(s, i) }));
      return {
        investor: investorAccount(s, viewer),
        invoice: view(s, record, 'investor', viewer.userId),
        owned: holds,
        counterparties,
        assumptions: FINANCING_ASSUMPTIONS,
      };
    },
    async preparePurchase(invoiceId, faceMinor) {
      const viewer = await asInvestor();
      const s = await financing();
      const { p, record } = visible(s, viewer, invoiceId);
      const face = minor(faceMinor, 'The face value to buy');
      const investor = investorRecord(s, viewer.userId);
      const a = checkPurchase(s, p, investor, face);
      return kit.prepare(
        s,
        viewer,
        'invoice_purchase',
        { invoiceId, faceMinor: face.toString() },
        {
          title: `Buy ${usd(face)} of ${record.number}`,
          lines: [
            { label: 'You pay now', value: usd(a.price) },
            { label: 'You receive', value: `${usd(face)} when ${debtorName(record)} pays` },
            { label: 'Maturity', value: date(iso(p.maturityAt)) },
            {
              label: 'If unpaid',
              value: `${GRACE_DAYS}-day grace with a ${LATE_FEE_BPS / 100}% late fee, then the reserve and ${s.merchant.name}’s buy-back`,
            },
          ],
        },
        kit.typedData('Pact Receivables', RECEIVABLES, 'Purchase', {
          invoice: record.invoice.id,
          merchant: s.merchant.address,
          faceValue: face.toString(),
          price: a.price.toString(),
          maturity: iso(p.maturityAt),
          buyer: investor.address,
          deadline: deadline(s),
        }),
      );
    },
    async submitPurchase(token, signature) {
      const viewer = await asInvestor();
      const s = await financing();
      const { invoiceId, faceMinor } = kit.consume(s, viewer, 'invoice_purchase', token, signature);
      purchaseShare(s, viewer.userId, invoiceId, BigInt(faceMinor));
      return view(s, invoiceRecord(s, invoiceId), 'investor', viewer.userId);
    },
    async prepareTransfer(invoiceId, toInvestorId, faceMinor) {
      const viewer = await asInvestor();
      const s = await financing();
      const { p, record, holds } = visible(s, viewer, invoiceId);
      if (!holds) throw new DataError('not_holder', 'You do not hold part of this invoice.', 409);
      const face = minor(faceMinor, 'The face value to transfer');
      const from = investorRecord(s, viewer.userId);
      const to = state(s)!.investors.find(i => i.id === toInvestorId);
      if (!to) throw notFound('Investor');
      checkTransfer(s, p, from, to, face);
      return kit.prepare(
        s,
        viewer,
        'claim_transfer',
        { invoiceId, toInvestorId: to.id, faceMinor: face.toString() },
        {
          title: `Transfer ${usd(face)} of ${record.number}`,
          lines: [
            { label: 'To', value: to.organization },
            { label: 'Face value', value: usd(face) },
            { label: 'Price', value: 'Agreed between you; Pact does not handle it' },
          ],
        },
        kit.typedData('Pact Receivables', RECEIVABLES, 'Transfer', {
          invoice: record.invoice.id,
          from: from.address,
          to: to.address,
          amount: face.toString(),
          deadline: deadline(s),
        }),
      );
    },
    async submitTransfer(token, signature) {
      const viewer = await asInvestor();
      const s = await financing();
      const { invoiceId, toInvestorId, faceMinor } = kit.consume(
        s,
        viewer,
        'claim_transfer',
        token,
        signature,
      );
      const { p, record } = visible(s, viewer, invoiceId);
      transferShare(s, p, viewer.userId, toInvestorId, BigInt(faceMinor));
      return view(s, record, 'investor', viewer.userId);
    },
    async portfolio() {
      const viewer = await asInvestor();
      const s = await financing();
      const mine = state(s)!
        .positions.filter(p => CURRENT.includes(p.status))
        .map(p => ({ p, h: p.holdings.find(h => h.investorId === viewer.userId) }))
        .filter((row): row is { p: FinancingPosition; h: Holding } => row.h !== undefined);
      const positions = mine
        .map(({ p }) => view(s, invoiceRecord(s, p.invoiceId), 'investor', viewer.userId))
        .sort(
          (a, b) =>
            STATUS_ORDER.indexOf(a.status!) - STATUS_ORDER.indexOf(b.status!) ||
            a.terms.maturityAt.localeCompare(b.terms.maturityAt),
        );
      const open = mine.filter(({ p }) => p.status === 'requested' || p.status === 'funded');
      const late = mine.filter(({ p }) => p.status === 'overdue' || p.status === 'defaulted');
      return {
        investor: investorAccount(s, viewer),
        positions,
        totals: {
          investedMinor: sumBig(mine, ({ h }) => h.paidMinor).toString(),
          expectedMinor: sumBig(open, ({ p, h }) => owedTo(p, h)).toString(),
          receivedMinor: sumBig(mine, ({ h }) => h.receivedMinor).toString(),
          overdueMinor: sumBig(late, ({ p, h }) => owedTo(p, h)).toString(),
          open: open.length,
          overdue: mine.filter(({ p }) => p.status === 'overdue').length,
          defaulted: mine.filter(({ p }) => p.status === 'defaulted').length,
          closed: mine.filter(({ p }) => p.status === 'repaid' || p.status === 'bought_back').length,
        },
      };
    },

    async apply() {
      const viewer = await asInvestor();
      const s = await financing();
      // The demo's investors applied when the sample data was made.
      return investorAccount(s, viewer);
    },

    async registry(): Promise<ComplianceRegistry> {
      await asCompliance();
      const s = await financing();
      const f = state(s)!;
      const refusals = f.positions
        .flatMap(p =>
          p.events
            .filter(e => e.kind === 'refused')
            .map(e => ({
              id: e.id,
              at: e.at,
              invoiceId: p.invoiceId,
              invoiceNumber: invoiceRecord(s, p.invoiceId).number,
              title: e.title,
              detail: e.detail,
            })),
        )
        .sort((a, b) => b.at - a.at)
        .map(r => ({ ...r, at: iso(r.at) }));
      return {
        investors: f.investors.map(i => registryInvestor(s, i)),
        refusals,
        assumptions: FINANCING_ASSUMPTIONS,
      };
    },
    async prepareApproval(investorId, decision) {
      const viewer = await asCompliance();
      const s = await financing();
      const investor = state(s)!.investors.find(i => i.id === investorId);
      if (!investor) throw notFound('Investor');
      if (decision !== 'approve' && decision !== 'revoke')
        throw new DataError('invalid_decision', 'Choose approve or revoke.', 400);
      const approved = isApproved(s, investor);
      if (decision === 'approve' && approved)
        throw new DataError('already_approved', `${investor.organization} is already approved.`, 409);
      if (decision === 'revoke' && !approved)
        throw new DataError('not_approved', `${investor.organization} is not approved.`, 409);
      const expires = now(s) + APPROVAL_DAYS * DAY;
      return kit.prepare(
        s,
        viewer,
        'investor_approval',
        { investorId, decision },
        {
          title:
            decision === 'approve' ? `Approve ${investor.organization}` : `Revoke ${investor.organization}`,
          lines:
            decision === 'approve'
              ? [
                  { label: 'Region', value: investor.approval.region },
                  { label: 'Approved until', value: date(iso(expires)) },
                  { label: 'Allows', value: 'Buying, sending and receiving receivable tokens' },
                ]
              : [
                  { label: 'Effect', value: 'Can no longer buy, send or receive receivable tokens' },
                  { label: 'Unchanged', value: 'Repayments on what it already holds still arrive' },
                ],
        },
        kit.typedData('Pact Compliance', COMPLIANCE, decision === 'approve' ? 'Approve' : 'Revoke', {
          investor: investor.address,
          region: investor.approval.region,
          expires: decision === 'approve' ? iso(expires) : '',
          deadline: deadline(s),
        }),
      );
    },
    async submitApproval(token, signature) {
      const viewer = await asCompliance();
      const s = await financing();
      const { investorId, decision } = kit.consume(s, viewer, 'investor_approval', token, signature);
      return registryInvestor(s, setApproval(s, investorId, decision as 'approve' | 'revoke'));
    },

    async prepareCancelOrders(role) {
      const viewer = await (role === 'investor' ? asInvestor() : asCompliance());
      const s = await financing();
      return kit.prepare(
        s,
        viewer,
        'cancel_orders',
        { role },
        {
          title: 'Cancel signed orders that did not go through',
          lines: [
            {
              label: 'Effect',
              value:
                role === 'investor'
                  ? 'A purchase or transfer you signed but that was not completed can never run'
                  : 'A decision you signed but that was not completed can never run',
            },
          ],
        },
        kit.typedData(
          role === 'investor' ? 'Pact Receivables' : 'Pact Compliance',
          role === 'investor' ? RECEIVABLES : COMPLIANCE,
          'Cancel',
          { signer: viewer.userId, deadline: deadline(s) },
        ),
      );
    },
    async submitCancelOrders(token, signature) {
      const viewer = await requireViewer(['investor', 'compliance']);
      const s = await financing();
      kit.consume(s, viewer, 'cancel_orders', token, signature);
      // The demo keeps no signed orders: nothing is waiting to run.
      return { cancelled: true as const };
    },

    async simulateCustomerPayment(invoiceId) {
      const viewer = await requireViewer(['merchant', 'investor']);
      const s = await financing();
      if (viewer.role === 'investor') visible(s, viewer, invoiceId);
      customerPays(s, invoiceId);
      return viewer.role === 'investor'
        ? view(s, invoiceRecord(s, invoiceId), 'investor', viewer.userId)
        : view(s, invoiceRecord(s, invoiceId), 'merchant');
    },

    async agents(): Promise<MerchantAgentsOverview> {
      await kit.readMerchant();
      const s = await financing();
      const calls = merchantCalls(s);
      return {
        agents: agentsFor(s).map(record => merchantAgent(s, record, calls)),
        endpoints: s.endpoints.map(endpointView),
        recent: calls.slice(0, 25),
        scenarios: scenarios(s),
        merchant: { name: s.merchant.name, address: s.merchant.address },
      };
    },
    async agentRequest(id) {
      await kit.readMerchant();
      const s = await financing();
      const call = merchantCalls(s).find(c => c.id === id);
      if (!call) throw notFound('Request');
      return trace(s, call);
    },
    async simulateAgentRequest(scenarioId) {
      await kit.writeMerchant();
      const s = await financing();
      const scenario = scenarios(s).find(item => item.id === scenarioId);
      if (!scenario) throw new DataError('invalid_scenario', 'Choose one of the demo requests.', 400);
      const record = s.agents.find(a => a.session.id === scenario.agentId)!;
      const endpoint = s.endpoints.find(e => e.id === scenario.endpointId)!;
      return trace(s, paidRequest(s, record, endpoint, requestUrl(s, endpoint)));
    },
  };
}
