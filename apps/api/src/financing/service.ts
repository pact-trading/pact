import { encodeFunctionData, erc20Abi, getAddress, isAddress, parseSignature, stringToHex, type Address, type Hex } from 'viem';
import { id, now as nowIso, type Db } from '../db.js';
import { pendingPaymentIntent } from '../payment-state.js';
import { invoiceDetail } from '../invoices-live.js';
import { USDT } from '../token.js';
import { Refusal } from '../types.js';
import { CLAIM_STATUSES, receivablesAbi, registryAbi, type FinancingChain, type FinancingEvent } from './chain.js';
import { APPROVAL_DAYS, FINANCING_PRICING, FINANCING_TERMS, paymentGas } from './terms.js';
import {
  activeClaim, applyFinancingEvents, claimRow, currentClaim, eventRows, holdingRows, initFinancing, invoiceRef,
  type ClaimRow, type EventRow, type HoldingRow,
} from './store.js';

type Row = Record<string, string | number | null>;
type Audience = 'merchant' | 'investor';
type FinancingStatus = 'eligible' | 'requested' | 'funded' | 'overdue' | 'defaulted' | 'repaid' | 'bought_back';
/** Transactions the signer's wallet sends itself (the merchant: listing, cancelling, buying back). */
export interface PreparedTransactions {
  title: string;
  lines: Array<{ label: string; value: string }>;
  transactions: Array<{ to: Address; data: Hex; label: string }>;
}
/**
 * EIP-712 messages an investor or officer signs, in order (the order first, then any USDT permit), and
 * the order to send back with the signatures. Pact's relayer submits it and pays the gas.
 */
export interface PreparedSignature {
  title: string;
  lines: Array<{ label: string; value: string }>;
  typedData: Array<Record<string, unknown>>;
  order: Record<string, string>;
}

/** How long a signed order stays valid. */
const ORDER_SECONDS = 10 * 60;
/** Gas the relayer allows each signed order; the call is simulated first. */
const RELAY_GAS = { purchase: 450_000n, transfer: 250_000n, decision: 150_000n, cancel: 100_000n } as const;
/** Signed orders Pact relays for one wallet in an hour, on top of the relayer's own spend limit. */
const RELAYS_PER_HOUR = 20;
/** The contracts' errors, in words. */
const RELAY_REFUSALS: Record<string, [string, string]> = {
  NotApproved: ['not_approved', 'Refused by the receivables contract: an investor in this order is not approved in the registry.'],
  InvalidSignature: ['invalid_signature', 'The signature does not match this order. Prepare it again.'],
  SignatureExpired: ['order_expired', 'This signed order expired. Prepare it again.'],
  PriceAboveLimit: ['price_changed', 'The price is above what you signed for.'],
  WrongStatus: ['not_listed', 'This invoice is no longer listed.'],
  TransfersClosed: ['transfer_refused', 'Refused by the receivables contract: transfers are closed for this claim.'],
  TooManyHolders: ['too_many_holders', `This invoice already has ${FINANCING_TERMS.maxHolders} investors, the most one invoice can have.`],
  InvalidAmount: ['invalid_amount', 'The contract refused this amount.'],
  InvalidRecipient: ['invalid_recipient', 'Choose another investor.'],
  NotOfficer: ['not_compliance_officer', 'This wallet is not a compliance officer in the investor registry.'],
  InvalidExpiry: ['invalid_expiry', 'The approval period is not allowed.'],
  InvalidInvestor: ['investor_not_found', 'Investor not found.'],
  reverted: ['refused', 'The contract refused this order, and the USDT allowance may be missing. Nothing was sent.'],
};

const DAY = 86_400;
const BPS = 10_000n;
const T = FINANCING_TERMS;
const STATUS_ORDER: FinancingStatus[] = ['defaulted', 'overdue', 'requested', 'funded', 'eligible', 'repaid', 'bought_back'];
const bps = (amount: bigint, rate: number) => (amount * BigInt(rate)) / BPS;
const sum = <X>(items: X[], pick: (item: X) => bigint) => items.reduce((total, item) => total + pick(item), 0n);
const big = (value: unknown) => BigInt(String(value ?? 0));
/** A six-decimal amount string ("1.500000") in minor units, zero included. */
const minorOf = (value: string) => {
  const [whole, decimal = ''] = value.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(decimal.padEnd(6, '0').slice(0, 6));
};
const lower = (value: string) => value.toLowerCase();
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
/** Plain-language amounts for timeline text: $1,234.56. */
export const usd = (minor: bigint) => {
  const negative = minor < 0n, value = negative ? -minor : minor;
  const cents = (value + 5_000n) / 10_000n;
  const dollars = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}$${dollars}.${(cents % 100n).toString().padStart(2, '0')}`;
};
const date = (seconds: number) => new Date(seconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const percent = (rate: number) => `${rate / 100}%`;
const names = (list: string[]) => list.length <= 1 ? (list[0] ?? 'the holders') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`;

/** What `face` of an invoice costs at `discountBps`, and what it brings the merchant (the contract's rounding). */
export function amounts(face: bigint, discountBps: number) {
  const price = face - bps(face, discountBps);
  const fee = bps(face, T.feeBps);
  const reserve = bps(face, T.reserveBps);
  return { price, fee, reserve, net: price - fee, upfront: price - fee - reserve };
}

export const FINANCING_ASSUMPTIONS = {
  dayRateBps: FINANCING_PRICING.dayRateBps,
  latePremiumBps: FINANCING_PRICING.latePremiumBps,
  feeBps: T.feeBps,
  reserveBps: T.reserveBps,
  lateFeeBps: T.lateFeeBps,
  graceDays: T.gracePeriodSeconds / DAY,
  recordDateHours: T.recordPeriodSeconds / 3600,
  minimumShareMinor: T.minShareMinor.toString(),
};

/**
 * Invoice financing for merchants, investors and compliance. Reads the indexed contract state, prices
 * and checks requests the way the contract will, and prepares the transactions each party sends from
 * its own wallet. The contract enforces every rule again.
 */
export class FinancingService {
  private clock = { at: 0, fetchedAt: 0 };
  private keeperBackoff = new Map<string, number>();
  private baseUrl: string;
  private escrow: Address;
  private startBlock: bigint;
  private confirmations: bigint;
  private clockCacheMs: number;
  constructor(readonly db: Db, readonly chain: FinancingChain, options: { baseUrl: string; escrow: Address; startBlock?: bigint; confirmations?: bigint; clockCacheMs?: number }) {
    initFinancing(db);
    this.baseUrl = options.baseUrl;
    this.escrow = options.escrow;
    this.startBlock = options.startBlock ?? 0n;
    this.confirmations = options.confirmations ?? 1n;
    this.clockCacheMs = options.clockCacheMs ?? 3_000;
  }
  get addresses() { return this.chain.addresses; }

  /** Chain time, refreshed every few seconds. Status follows the clock the contract enforces. */
  async now() {
    if (Date.now() - this.clock.fetchedAt >= this.clockCacheMs) {
      try { this.clock = { at: await this.chain.now(), fetchedAt: Date.now() }; }
      catch { if (!this.clock.at) this.clock = { at: Math.floor(Date.now() / 1000), fetchedAt: Date.now() }; }
    }
    return this.clock.at + Math.floor((Date.now() - this.clock.fetchedAt) / 1000);
  }

  // ------------------------------------------------------------ indexing and keeper

  /** Applies confirmed receivables and registry events since the last run. */
  async poll() {
    const latest = await this.chain.latestBlock();
    if (latest < this.confirmations) return 0;
    const safe = latest - this.confirmations;
    const row = this.db.prepare("SELECT block FROM fin_cursor WHERE name='financing'").get() as { block: string } | undefined;
    let from = row ? BigInt(row.block) + 1n : this.startBlock;
    let applied = 0;
    while (from <= safe) {
      // Same window and back-off as the main indexer: public RPCs cap log ranges and rate-limit.
      const to = from + 99n < safe ? from + 99n : safe;
      let events: FinancingEvent[] = [];
      for (let retry = 0; ; retry++) {
        try { events = await this.chain.events(from, to); break; }
        catch (error) {
          if (!/429|rate.limit|too many requests/i.test(String(error)) || retry === 4) throw error;
          await new Promise(r => setTimeout(r, 250 * 2 ** retry));
        }
      }
      this.db.transaction(() => {
        applied += applyFinancingEvents(this.db, events);
        this.db.prepare("INSERT INTO fin_cursor VALUES ('financing',?) ON CONFLICT(name) DO UPDATE SET block=excluded.block").run(to.toString());
      })();
      from = to + 1n;
    }
    return applied;
  }

  /** Closes listings at their record date and marks defaults after the grace period. Anyone may; Pact pays the gas. */
  async keep() {
    const t = await this.now();
    const due = this.db.prepare("SELECT * FROM fin_claims WHERE (status='listed' AND maturity-?<=?) OR (status='funded' AND maturity+?<?)")
      .all(T.recordPeriodSeconds, t, T.gracePeriodSeconds, t) as ClaimRow[];
    let sent = 0;
    for (const c of due) {
      const key = `${c.id}:${c.status}`;
      if ((this.keeperBackoff.get(key) ?? 0) > Date.now()) continue;
      this.keeperBackoff.set(key, Date.now() + 60_000);
      try {
        const onChain = await this.chain.claim(BigInt(c.id));
        if (onChain.status !== c.status) continue; // The indexer has not caught up; next round.
        const hash = await this.chain.keeper(c.status === 'listed' ? 'closeListing' : 'markDefault', BigInt(c.id));
        await this.settle([hash]);
        sent++;
      } catch { /* Retried after the backoff. */ }
    }
    return sent;
  }

  /** Applies the financing events of confirmed transactions now, without waiting for the indexer. */
  async settle(hashes: Hex[], expectFrom?: Address) {
    const events: FinancingEvent[] = [];
    for (const hash of hashes) {
      let receipt = null;
      for (let i = 0; i < 40 && !receipt; i++) {
        receipt = await this.chain.receipt(hash).catch(() => null);
        if (!receipt) await new Promise(r => setTimeout(r, 500));
      }
      if (!receipt) throw new Refusal('transaction_not_found');
      if (expectFrom && lower(receipt.from) !== lower(expectFrom)) throw new Refusal('transaction_sender_mismatch');
      const allowed = [this.addresses.receivables, this.addresses.registry, USDT].map(lower);
      if (!receipt.to || !allowed.includes(lower(receipt.to))) throw new Refusal('transaction_target_mismatch');
      if (receipt.status !== 'success') throw new Refusal('transaction_reverted');
      events.push(...receipt.events);
    }
    applyFinancingEvents(this.db, events);
    return events;
  }

  // ------------------------------------------------------------ payment routing

  /**
   * Where a payment for this invoice must go. While a claim is open the receivables contract takes it,
   * so investors are paid; never the escrow. The chain is asked too, in case the indexer is behind.
   */
  async route(invoiceId: string, merchant: Address): Promise<{ claimId: bigint; holders: number } | null> {
    const row = activeClaim(this.db, invoiceId);
    let claimId = row ? BigInt(row.id) : 0n;
    try {
      const onChain = await this.chain.activeClaimId(merchant, invoiceRef(invoiceId));
      if (onChain !== 0n) claimId = onChain;
      else if (row) {
        const state = await this.chain.claim(claimId);
        if (!['listed', 'funded', 'defaulted'].includes(state.status)) claimId = 0n;
      }
    } catch {
      // An unreadable chain must not send a financed invoice's payment to the escrow.
      if (!row) throw new Refusal('financing_unavailable');
    }
    if (claimId === 0n) return null;
    return { claimId, holders: Math.max(1, holdingRows(this.db, claimId.toString()).length) };
  }
  paymentGas = paymentGas;
  /**
   * The contract's rules for a financed invoice's payment: while the listing is open only the customer
   * who acknowledged it may pay; a payment is at least the minimum share and leaves nothing or at least
   * the minimum share owed, unless it pays exactly what is left.
   */
  checkPayment(claimId: bigint, amount: bigint, payer: Address) {
    const c = claimRow(this.db, claimId.toString());
    if (!c) return;
    if (c.status === 'listed' && c.invoice_id) {
      const ack = this.db.prepare('SELECT signer FROM invoice_acknowledgements WHERE invoice_id=?').get(c.invoice_id) as { signer: string } | undefined;
      if (ack && lower(ack.signer) !== lower(payer))
        throw new Refusal('financed_payer_not_debtor', 'While this invoice is listed for investors, it can only be paid from the account that acknowledged it.');
    }
    const left = big(c.face) - big(c.collected);
    if (amount === left) return;
    if (amount > left || amount < T.minShareMinor || left - amount < T.minShareMinor)
      throw new Refusal('financed_payment_amount', `Pay ${usd(left)}, or at least ${usd(T.minShareMinor)} while leaving at least ${usd(T.minShareMinor)} owed.`);
  }

  // ------------------------------------------------------------ eligibility and pricing

  private invoiceRow(invoiceId: string, merchantId?: string) {
    const row = (merchantId
      ? this.db.prepare('SELECT * FROM invoices WHERE id=? AND merchant_id=?').get(invoiceId, merchantId)
      : this.db.prepare('SELECT * FROM invoices WHERE id=?').get(invoiceId)) as Row | undefined;
    if (!row) throw new Refusal('invoice_not_found');
    return row;
  }
  private dueOf(row: Row) { return row.due_at ? Math.floor(new Date(String(row.due_at)).getTime() / 1000) : null; }
  private debtorHistory(row: Row) {
    const others = this.db.prepare('SELECT * FROM invoices WHERE merchant_id=? AND lower(customer_email)=lower(?) AND id!=?').all(row.merchant_id, row.customer_email, row.id) as Row[];
    const paidLate = others.filter(o => {
      if (o.status !== 'paid' || !o.due_at) return false;
      const paid = this.db.prepare("SELECT created_at FROM webhook_events WHERE object_id=? AND type='invoice.paid' ORDER BY created_at DESC LIMIT 1").get(o.id) as { created_at: string } | undefined;
      return !!paid && paid.created_at > String(o.due_at);
    });
    return { invoicesPaid: others.filter(o => o.status === 'paid').length, invoicesOverdue: others.filter(o => o.status === 'overdue').length, invoicesPaidLate: paidLate.length };
  }
  private pricing(row: Row, from: number) {
    const maturity = this.dueOf(row) ?? from;
    const days = Math.max(1, Math.floor((maturity - from) / DAY));
    const history = this.debtorHistory(row);
    const latePremiumBps = history.invoicesOverdue + history.invoicesPaidLate > 0 ? FINANCING_PRICING.latePremiumBps : 0;
    const discountBps = Math.min(T.maxDiscountBps, days * FINANCING_PRICING.dayRateBps + latePremiumBps);
    return { dayRateBps: FINANCING_PRICING.dayRateBps, days, latePremiumBps, discountBps };
  }
  private debtorName(row: Row) {
    return (this.db.prepare('SELECT customer_name FROM invoice_details WHERE invoice_id=?').get(row.id) as { customer_name: string | null } | undefined)?.customer_name ?? 'the customer';
  }
  /** Why an invoice cannot be listed now, or null. Eligible: sent, acknowledged, unpaid, due after the record date. */
  private ineligible(row: Row, t: number): string | null {
    const due = this.dueOf(row);
    if (row.status === 'draft') return 'Send the invoice to the customer before financing it.';
    if (row.status === 'paid') return 'This invoice is already paid.';
    if (big(row.paid_minor) > 0n) return 'Part of this invoice is already paid. Only unpaid invoices can be financed.';
    if (due === null) return 'Only invoices with a due date can be financed.';
    if (due <= t) return 'This invoice is past its due date.';
    if (due - T.recordPeriodSeconds <= t + 60) return 'This invoice is due within a day: too close to its record date to list.';
    if (due - t > 400 * DAY) return 'This invoice is due more than 400 days from now, longer than a listing may run.';
    if (big(row.amount_minor) < T.minShareMinor) return `Only invoices of at least ${usd(T.minShareMinor)} can be financed.`;
    if (!this.db.prepare('SELECT 1 FROM invoice_acknowledgements WHERE invoice_id=?').get(row.id))
      return `Waiting for ${this.debtorName(row)} to acknowledge it. An invoice can be financed only after the customer signs “I owe this invoice”, so investors know the debt is real.`;
    const open = this.db.prepare("SELECT id FROM payments WHERE merchant_id=? AND status IN ('open','failed','reconciliation_required') AND json_extract(metadata,'$.invoiceId')=?").all(row.merchant_id, row.id) as Array<{ id: string }>;
    if (open.some(p => pendingPaymentIntent(this.db, p.id, this.escrow, this.addresses.receivables)))
      return 'A payment on this invoice is still processing. Try again once it settles.';
    return null;
  }

  // ------------------------------------------------------------ views

  /** Effective status at time `t`: the contract's state plus what the clock has already decided. */
  private statusOf(c: ClaimRow, t: number): FinancingStatus | 'withdrawn' | 'cancelled' {
    if (c.status === 'listed') {
      if (t < c.maturity - T.recordPeriodSeconds) return 'requested';
      if (big(c.sold) === 0n) return 'withdrawn';
      return t > c.maturity ? 'overdue' : 'funded';
    }
    if (c.status === 'funded') return t > c.maturity ? 'overdue' : 'funded';
    return c.status as FinancingStatus | 'withdrawn' | 'cancelled';
  }
  private isLate(c: ClaimRow, t: number) {
    return !!c.late || (['funded', 'listed'].includes(c.status) && t > c.maturity);
  }
  private owedTo(c: ClaimRow, h: HoldingRow, t: number) {
    const units = big(h.units);
    const due = units + (this.isLate(c, t) ? bps(units, T.lateFeeBps) : 0n) - big(h.received);
    return due > 0n ? due : 0n;
  }
  private owed(c: ClaimRow, t: number) { return sum(holdingRows(this.db, c.id), h => this.owedTo(c, h, t)); }

  private registryRow(address: string) {
    return this.db.prepare('SELECT * FROM fin_registry WHERE address=?').get(lower(address)) as { approved: number; expires_at: number; region: string } | undefined;
  }
  private profile(address: string) {
    return this.db.prepare('SELECT * FROM fin_investors WHERE address=?').get(lower(address)) as { address: string; name: string; organization: string; email: string; region: string; applied_at: string } | undefined;
  }
  private approval(address: string, t: number) {
    const r = this.registryRow(address), p = this.profile(address);
    const status: 'approved' | 'pending' | 'revoked' | 'expired' = !r ? 'pending' : !r.approved ? 'revoked' : r.expires_at <= t ? 'expired' : 'approved';
    return { status, region: r?.region || p?.region || '', expiresAt: r && r.approved ? iso(r.expires_at) : null };
  }
  private holderLabel(address: string) {
    const p = this.profile(address);
    return { name: p?.name ?? short(address), organization: p?.organization ?? short(address) };
  }

  private timeline(c: ClaimRow, row: Row, t: number) {
    const debtor = this.debtorName(row);
    const merchant = this.merchantName(String(row.merchant_id));
    const number = this.number(row);
    const face = big(c.face);
    const out: Array<{ id: string; at: string; kind: string; title: string; detail: string; amountMinor: string | null; txHash: string | null }> = [];
    const push = (e: EventRow | null, kind: string, title: string, detail: string, amount: bigint | null = null, at?: number) =>
      out.push({ id: e ? `${e.id}:${kind}` : `${c.id}:${kind}`, at: iso(at ?? e!.at), kind, title, detail, amountMinor: amount === null ? null : amount.toString(), txHash: e?.tx_hash ?? null });
    let sold = 0n;
    const holders = (list: string[]) => names(list.map(a => this.holderLabel(a).organization));
    const all = eventRows(this.db, c.id);
    for (const e of all) {
      const a = JSON.parse(e.args) as Record<string, string>;
      switch (e.name) {
        case 'Listed': {
          const quoted = amounts(face, c.discount_bps);
          const premium = c.late_premium_bps ? ` plus ${percent(c.late_premium_bps)} because ${debtor} has paid late before` : '';
          push(e, 'requested', 'Listed for investors', `Priced at ${usd(quoted.price)} for the ${usd(face)} face value: ${c.priced_days} days to maturity at ${percent(c.day_rate_bps || FINANCING_PRICING.dayRateBps)} a day${premium}. Investors can buy all or part of it.`);
          break;
        }
        case 'Purchased': {
          sold += big(a.units);
          const who = this.holderLabel(a.investor).organization;
          const full = sold === face;
          push(e, 'funded', `${who} bought ${usd(big(a.units))} of ${number}`, `Paid ${usd(big(a.price))} for a ${usd(big(a.units))} claim due ${date(c.maturity)}. ${full ? 'Fully funded; the listing is closed.' : `${usd(sold)} of ${usd(face)} funded so far.`}`, big(a.price));
          push(e, 'advance', `${merchant} received ${usd(big(a.upfront))}`, `${usd(big(a.price))} less Pact’s ${usd(big(a.fee))} fee and a ${usd(big(a.reserve))} reserve the contract holds until ${debtor} pays.`, big(a.upfront));
          break;
        }
        case 'ListingClosed':
          if (big(a.sold) !== face) push(e, 'closed', 'Listing closed', `Investors hold ${usd(big(a.sold))}; ${merchant} keeps the other ${usd(face - big(a.sold))} and is paid that part directly.`);
          break;
        case 'Cancelled':
          push(e, 'cancelled', 'Request cancelled', 'Withdrawn from the marketplace before any investor bought it. No money moved.');
          break;
        case 'Withdrawn':
          push(e, 'withdrawn', 'Listing withdrawn', `${big(c.collected) > 0n ? 'The customer paid before any investor bought a share.' : 'The record date arrived before any investor bought it.'} No money moved to investors.`);
          break;
        case 'Transferred':
          push(e, 'transfer', `${this.holderLabel(a.from).organization} transferred ${usd(big(a.units))} to ${this.holderLabel(a.to).organization}`, 'Both are approved investors, and the record date has not passed. Any price is agreed between them; the token only checks who may hold it.', big(a.units));
          break;
        case 'Paid': {
          const paidTo = all.filter(x => x.tx_hash === e.tx_hash && x.name === 'HolderPaid' && (JSON.parse(x.args) as Record<string, string>).source === '0').map(x => (JSON.parse(x.args) as Record<string, string>).holder);
          const toHolders = big(a.toHolders), toMerchant = big(a.toMerchant);
          const kept = face - big(c.sold);
          push(e, 'payment', `${debtor} paid ${usd(big(a.amount))}`, toHolders === 0n
            ? `Paid to ${merchant} as usual: no investor held part of the invoice yet.`
            : `Through the usual payment link. The contract sent ${usd(toHolders)} straight to ${holders(paidTo)}${toMerchant > 0n ? ` and ${usd(toMerchant)} to ${merchant}${kept > 0n ? ' for the part it kept' : ', above what the holders were owed'}` : ''}. ${merchant} never held the holders’ money.`, big(a.amount));
          break;
        }
        case 'Settled': {
          const fromReserve = big(a.fromReserve), released = big(a.reserveReleased);
          if (fromReserve + released > 0n)
            push(e, 'reserve', fromReserve > 0n ? `Reserve settled: ${usd(fromReserve)} late fee, ${usd(released)} back to you` : `Reserve of ${usd(released)} returned`,
              fromReserve > 0n ? `${debtor} paid after maturity, so the holders received the ${percent(T.lateFeeBps)} late fee from the reserve. The rest went back to ${merchant}.` : `${debtor} paid on time, so the contract released the whole reserve to ${merchant}.`, released);
          const received = sum(holdingRows(this.db, c.id), h => big(h.received));
          push(e, 'repaid', 'Repaid in full', `${holders(holdingRows(this.db, c.id).map(h => h.holder))} received everything they were owed${e.at > c.maturity ? `, ${Math.max(1, Math.round((e.at - c.maturity) / DAY))} days after maturity` : ', before maturity'}.`, received);
          break;
        }
        case 'Defaulted':
          push(e, 'defaulted', 'Defaulted: the token is frozen', `The ${T.gracePeriodSeconds / DAY}-day grace period ended unpaid. The contract froze the token and paid the ${usd(big(a.fromReserve))} reserve to the holders. ${merchant} owes the remaining ${usd(big(a.buyBackOwed))} as a buy-back. ${debtor} can still pay; that payment goes to the holders first.`, big(a.fromReserve));
          break;
        case 'BoughtBack':
          push(e, 'bought_back', `${merchant} bought the claim back`, `Paid ${usd(big(a.amount))} to the holders, who are now paid in full. ${debtor}’s payment, if it comes, now goes to ${merchant}.`, big(a.amount));
          break;
      }
    }
    if (this.isLate(c, t) && t > c.maturity && big(c.sold) > 0n && !(c.status === 'repaid' && (c.closed_at ?? 0) <= c.maturity))
      push(null, 'overdue', 'Past maturity and unpaid', `The holders are owed the face value plus the ${percent(T.lateFeeBps)} late fee. If ${debtor} pays by ${date(c.maturity + T.gracePeriodSeconds)}, the late fee comes out of the reserve. If not, the invoice defaults.`, null, c.maturity);
    for (const r of this.db.prepare('SELECT * FROM fin_refusals WHERE claim_id=?').all(c.id) as Array<{ id: string; at: string; title: string; detail: string }>)
      out.push({ id: r.id, at: r.at, kind: 'refused', title: r.title, detail: `${r.detail} Refused before anything was sent; no gas was spent.`, amountMinor: null, txHash: null });
    return out;
  }

  private merchantName(merchantId: string) {
    return (this.db.prepare('SELECT brand_name FROM merchant_settings WHERE merchant_id=?').get(merchantId) as { brand_name: string } | undefined)?.brand_name || 'This business';
  }
  private number(row: Row) {
    const rank = (this.db.prepare('SELECT count(*) n FROM invoices WHERE merchant_id=? AND created_at<=?').get(row.merchant_id, row.created_at) as { n: number }).n;
    return `INV-${String(rank).padStart(4, '0')}`;
  }

  private ledger(row: Row) {
    type Entry = { occurred_at: string; kind: string; amount_minor: string; fee_minor: string; tx_hash: string };
    const financing = this.db.prepare("SELECT * FROM accounting_entries WHERE merchant_id=? AND object_id=? ORDER BY occurred_at").all(row.merchant_id, row.id) as Entry[];
    // The invoice's payments, booked under their payment ids.
    const payments = (this.db.prepare("SELECT a.* FROM accounting_entries a JOIN payments p ON p.id=a.object_id WHERE a.merchant_id=? AND a.kind='Payment' AND json_extract(p.metadata,'$.invoiceId')=?").all(row.merchant_id, row.id) as Entry[])
      .map(e => ({ ...e, kind: 'Invoice' }));
    return [...financing, ...payments].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)).map(e => ({
      at: e.occurred_at, type: e.kind, grossMinor: e.amount_minor, feeMinor: e.fee_minor, netMinor: (big(e.amount_minor) - big(e.fee_minor)).toString(), txHash: e.tx_hash,
    }));
  }

  /** The web's FinancedInvoice for one invoice, as the merchant or an investor sees it. */
  view(row: Row, audience: Audience, viewer: string | null, t: number) {
    const detail = invoiceDetail(this.db, row, this.baseUrl) as Record<string, unknown> & { number: string; customerName: string | null; merchantName: string; acknowledgement: unknown; lines: Array<{ description: string; quantity: number; amount: string }>; remaining: string };
    const c = currentClaim(this.db, String(row.id)) ?? null;
    const effective = c ? this.statusOf(c, t) : null;
    const position = c && effective !== 'withdrawn' && effective !== 'cancelled' ? c : null;
    const face = position ? big(position.face) : big(row.amount_minor);
    const price = position
      ? { dayRateBps: position.day_rate_bps || FINANCING_PRICING.dayRateBps, days: position.priced_days, latePremiumBps: position.late_premium_bps, discountBps: position.discount_bps }
      : this.pricing(row, t);
    const quoted = amounts(face, price.discountBps);
    const maturity = position?.maturity ?? this.dueOf(row) ?? t;
    const days = Math.max(0, Math.ceil((maturity - (position?.funded_at ?? t)) / DAY));
    const returnBps = quoted.price > 0n ? Number(((face - quoted.price) * BPS) / quoted.price) : 0;
    const holdings = position ? holdingRows(this.db, position.id) : [];
    const visible = audience === 'merchant' ? holdings : holdings.filter(h => viewer && lower(h.holder) === lower(viewer));
    const status: FinancingStatus | null = position ? (effective as FinancingStatus) : this.ineligible(row, t) ? null : 'eligible';
    const active = !!position && ['requested', 'funded', 'overdue', 'defaulted'].includes(status!);
    const sold = position ? big(position.sold) : 0n;
    const recordDate = maturity - T.recordPeriodSeconds;
    const closed = !position ? 'Nothing has been issued yet.'
      : status === 'defaulted' ? 'The token is frozen because the invoice defaulted.'
      : status === 'repaid' || status === 'bought_back' ? 'The claim is settled; the tokens are burned.'
      : t >= maturity ? 'Transfers ended at maturity. The claim can only be repaid now.'
      : t >= recordDate ? `No transfers in the ${T.recordPeriodSeconds / 3600} hours before maturity (the record date, ${date(recordDate)}), so the list of who gets paid is fixed.`
      : null;
    const history = audience === 'merchant'
      ? (this.db.prepare('SELECT * FROM fin_claims WHERE invoice_id=? ORDER BY CAST(id AS INTEGER)').all(row.id) as ClaimRow[])
      : position ? [position] : [];
    const late = position ? this.isLate(position, t) : false;
    const customerName = detail.customerName;
    return {
      invoiceId: String(row.id), number: detail.number, merchantName: detail.merchantName, invoiceStatus: String(row.status),
      createdAt: String(row.created_at), dueAt: (row.due_at as string | null) ?? null,
      lines: detail.lines.map(line => ({ description: line.description, quantity: line.quantity, amountMinor: minorOf(line.amount).toString() })),
      debtor: {
        name: customerName ?? (audience === 'merchant' ? String(row.customer_email) : 'The customer'),
        company: customerName,
        email: audience === 'merchant' ? String(row.customer_email) : null,
      },
      acknowledged: !!detail.acknowledgement,
      debtorHistory: this.debtorHistory(row),
      status,
      ineligibleReason: position ? null : this.ineligible(row, t),
      terms: {
        faceMinor: face.toString(), pricing: { dayRateBps: price.dayRateBps, days: price.days, latePremiumBps: price.latePremiumBps },
        discountBps: price.discountBps, feeBps: T.feeBps, reserveBps: T.reserveBps, lateFeeBps: T.lateFeeBps, graceDays: T.gracePeriodSeconds / DAY,
        priceMinor: quoted.price.toString(), discountMinor: (face - quoted.price).toString(), feeMinor: quoted.fee.toString(), reserveMinor: quoted.reserve.toString(),
        netAdvanceMinor: quoted.net.toString(), upfrontMinor: quoted.upfront.toString(), lateFeeMinor: bps(face, T.lateFeeBps).toString(),
        maturityAt: iso(maturity), graceEndsAt: iso(maturity + T.gracePeriodSeconds), recordDateAt: iso(recordDate),
        days, returnBps, annualBps: days > 0 ? Math.round((returnBps * 365) / days) : 0,
      },
      assumptions: FINANCING_ASSUMPTIONS,
      funding: {
        soldMinor: sold.toString(), unsoldMinor: (face - sold).toString(), open: status === 'requested',
        priceMinor: (position?.raised ?? '0'), feeMinor: (position?.fee_taken ?? '0'), reserveMinor: (position?.reserve_funded ?? '0'),
        upfrontMinor: (position ? big(position.raised) - big(position.fee_taken) - big(position.reserve_funded) : 0n).toString(),
      },
      holders: visible.map(h => {
        const label = this.holderLabel(h.holder);
        return {
          id: h.holder, name: label.name, organization: label.organization, faceMinor: h.units, paidMinor: h.paid, receivedMinor: h.received,
          owedMinor: (active && position ? this.owedTo(position, h, t) : 0n).toString(),
          approved: this.approval(h.holder, t).status === 'approved', you: !!viewer && lower(h.holder) === lower(viewer),
        };
      }),
      otherHolders: audience === 'investor' ? holdings.length - visible.length : 0,
      reserve: { heldMinor: position?.reserve ?? '0', releasedMinor: position?.reserve_released ?? '0', toInvestorsMinor: position?.reserve_to_holders ?? '0' },
      late,
      frozen: status === 'defaulted',
      transfers: { open: !!position && (status === 'requested' || status === 'funded') && closed === null, reason: closed, recordDateAt: iso(recordDate) },
      buyBackMinor: (status === 'defaulted' && position ? this.owed(position, t) : 0n).toString(),
      requestedAt: position ? iso(position.listed_at) : null,
      fundedAt: position?.funded_at ? iso(position.funded_at) : null,
      repaidAt: status === 'repaid' && position?.closed_at ? iso(position.closed_at) : null,
      overdueAt: position && late && t > maturity ? iso(maturity) : null,
      defaultedAt: position?.defaulted_at ? iso(position.defaulted_at) : null,
      boughtBackAt: status === 'bought_back' && position?.closed_at ? iso(position.closed_at) : null,
      customerOwesMinor: minorOf(detail.remaining).toString(),
      receivedMinor: sum(holdings, h => big(h.received)).toString(),
      outstandingMinor: (active && position ? this.owed(position, t) : 0n).toString(),
      advanceTxHash: position?.advance_tx ?? null,
      timeline: history.flatMap(item => this.timeline(item, row, t)).sort((a, b) => b.at.localeCompare(a.at)),
      ledger: audience === 'merchant' ? this.ledger(row) : [],
    };
  }

  // ------------------------------------------------------------ merchant

  async overview(merchantId: string) {
    const t = await this.now();
    const rows = this.db.prepare('SELECT * FROM invoices WHERE merchant_id=? ORDER BY created_at DESC LIMIT 200').all(merchantId) as Row[];
    const views = rows.map(row => this.view(row, 'merchant', null, t));
    const listed = views.filter(v => v.status !== null).sort((a, b) => STATUS_ORDER.indexOf(a.status!) - STATUS_ORDER.indexOf(b.status!) || (a.dueAt ?? '').localeCompare(b.dueAt ?? ''));
    const totals = Object.fromEntries(STATUS_ORDER.map(status => {
      const matching = listed.filter(v => v.status === status);
      return [status, { count: matching.length, faceMinor: sum(matching, v => big(v.terms.faceMinor)).toString() }];
    }));
    const started = (this.db.prepare(`SELECT * FROM fin_claims WHERE merchant_id=? AND status IN ('listed','funded','defaulted','repaid','bought_back')`).all(merchantId) as ClaimRow[]);
    return {
      invoices: listed, totals,
      advancedMinor: sum(started, c => big(c.raised) - big(c.fee_taken) - big(c.reserve_funded)).toString(),
      reserveHeldMinor: sum(started, c => big(c.reserve)).toString(),
      forwardedMinor: sum(started, c => big(c.forwarded)).toString(),
      buyBackOwedMinor: sum(started.filter(c => c.status === 'defaulted'), c => this.owed(c, t)).toString(),
      ineligibleCount: views.filter(v => v.invoiceStatus !== 'paid' && v.status === null).length,
      assumptions: FINANCING_ASSUMPTIONS,
    };
  }
  async invoice(merchantId: string, invoiceId: string) {
    return this.view(this.invoiceRow(invoiceId, merchantId), "merchant", null, await this.now());
  }

  async prepareList(merchant: { merchantId: string; address: Address }, invoiceId: string): Promise<PreparedTransactions> {
    const t = await this.now();
    const row = this.invoiceRow(invoiceId, merchant.merchantId);
    const current = currentClaim(this.db, invoiceId);
    if (current && ['requested', 'funded', 'overdue', 'defaulted'].includes(this.statusOf(current, t))) throw new Refusal('already_requested', 'Financing was already requested for this invoice.');
    const reason = this.ineligible(row, t);
    if (reason) throw new Refusal('not_eligible', reason);
    const ack = this.db.prepare('SELECT typed_hash,signature,signer FROM invoice_acknowledgements WHERE invoice_id=?').get(invoiceId) as { typed_hash: Hex; signature: Hex; signer: Address };
    const ref = invoiceRef(invoiceId);
    if (await this.chain.activeClaimId(merchant.address, ref) !== 0n) throw new Refusal('already_requested', 'This invoice already has an open listing.');
    if (await this.chain.invoicePledged(merchant.address, ref)) throw new Refusal('already_financed', 'This invoice was already sold to investors or paid while listed; it cannot be financed again.');
    if (await this.chain.acknowledgementClaim(ack.typed_hash) !== 0n)
      throw new Refusal('acknowledgement_used', 'This acknowledgement already backs a listing: the customer’s debt was sold before.');
    const price = this.pricing(row, t);
    const face = big(row.amount_minor);
    const quoted = amounts(face, price.discountBps);
    this.db.prepare('INSERT INTO fin_refs VALUES (?,?,?) ON CONFLICT(invoice_ref) DO NOTHING').run(ref.toLowerCase(), invoiceId, merchant.merchantId);
    this.db.prepare('INSERT INTO fin_quotes VALUES (?,?,?,?,?,?) ON CONFLICT(invoice_ref,discount_bps) DO UPDATE SET day_rate_bps=excluded.day_rate_bps,days=excluded.days,late_premium_bps=excluded.late_premium_bps,created_at=excluded.created_at')
      .run(ref.toLowerCase(), price.discountBps, price.dayRateBps, price.days, price.latePremiumBps, nowIso());
    const maturity = BigInt(this.dueOf(row)!);
    return {
      title: `List ${this.number(row)} for investors`,
      lines: [
        { label: 'Face value', value: usd(face) },
        { label: 'Investors pay', value: `${usd(quoted.price)} (${percent(price.discountBps)} off)` },
        { label: 'You receive at once', value: `${usd(quoted.upfront)} if all of it sells` },
        { label: 'Then', value: `${usd(quoted.reserve)} reserve when ${this.debtorName(row)} pays` },
        { label: 'Customer pays', value: 'The contract, which pays the investors' },
      ],
      // The contract checks the customer's acknowledgement itself: this invoice, amount, due date and merchant.
      transactions: [{ to: this.addresses.receivables, label: 'List the invoice', data: encodeFunctionData({ abi: receivablesAbi, functionName: 'list', args: [invoiceId, getAddress(ack.signer), face, maturity, price.discountBps, ack.signature] }) }],
    };
  }

  async prepareCancel(merchant: { merchantId: string; address: Address }, invoiceId: string): Promise<PreparedTransactions> {
    const t = await this.now();
    const row = this.invoiceRow(invoiceId, merchant.merchantId);
    const c = currentClaim(this.db, invoiceId);
    if (!c) throw new Refusal('not_requested', 'There is no financing request to cancel.');
    if (c.status !== 'listed' || this.statusOf(c, t) !== 'requested') throw new Refusal('already_funded', 'The listing is already closed, so it can no longer be cancelled.');
    const sold = big(c.sold);
    return {
      title: sold > 0n ? `Close the listing for ${this.number(row)}` : `Cancel financing for ${this.number(row)}`,
      lines: sold > 0n
        ? [{ label: 'Investors keep', value: usd(sold) }, { label: 'You keep', value: usd(big(c.face) - sold) }]
        : [{ label: 'Effect', value: 'Taken off the marketplace. No money has moved.' }],
      transactions: [{ to: this.addresses.receivables, label: sold > 0n ? 'Close the listing' : 'Cancel the listing', data: encodeFunctionData({ abi: receivablesAbi, functionName: 'cancel', args: [BigInt(c.id)] }) }],
    };
  }

  async prepareBuyBack(merchant: { merchantId: string; address: Address }, invoiceId: string): Promise<PreparedTransactions> {
    const row = this.invoiceRow(invoiceId, merchant.merchantId);
    const c = currentClaim(this.db, invoiceId);
    if (!c || c.status !== 'defaulted') throw new Refusal('not_defaulted', 'Only a defaulted invoice can be bought back.');
    const owed = await this.chain.owed(BigInt(c.id));
    const balance = await this.chain.usdtBalance(merchant.address);
    if (balance < owed) throw new Refusal('insufficient_funds', `Your wallet holds ${usd(balance)}; the buy-back is ${usd(owed)}.`);
    const allowance = await this.chain.allowance(merchant.address, this.addresses.receivables);
    const holders = holdingRows(this.db, c.id).map(h => this.holderLabel(h.holder).organization);
    return {
      title: `Buy back ${this.number(row)}`,
      lines: [{ label: 'You pay', value: usd(owed) }, { label: 'To', value: names(holders) }, { label: 'Then', value: `${this.debtorName(row)}’s payment comes to you` }],
      transactions: [
        ...(allowance < owed ? [{ to: USDT, label: `Allow the contract to take ${usd(owed)}`, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [this.addresses.receivables, owed] }) }] : []),
        { to: this.addresses.receivables, label: 'Pay the holders', data: encodeFunctionData({ abi: receivablesAbi, functionName: 'buyBack', args: [BigInt(c.id)] }) },
      ],
    };
  }

  // ------------------------------------------------------------ investors

  private refuse(c: ClaimRow, address: string, code: string, title: string, detail: string): never {
    // One record per refusal and wallet within ten minutes: retrying the same refused purchase does
    // not flood the compliance view.
    const recent = this.db.prepare('SELECT 1 FROM fin_refusals WHERE claim_id=? AND address=? AND title=? AND detail=? AND at>?')
      .get(c.id, lower(address), title, detail, new Date(Date.now() - 10 * 60_000).toISOString());
    if (!recent) this.db.prepare('INSERT INTO fin_refusals VALUES (?,?,?,?,?,?,?)').run(id('fref'), nowIso(), c.id, c.invoice_id, lower(address), title, detail);
    throw new Refusal(code, `Refused by the receivables contract. ${detail}`);
  }
  private notApprovedDetail(address: string, t: number) {
    const a = this.approval(address, t);
    const who = this.holderLabel(address).organization;
    const why = a.status === 'pending' ? 'its application is still pending' : a.status === 'revoked' ? 'its approval was revoked' : 'its approval expired';
    return `${who} is not an approved investor: ${why}.`;
  }
  async account(address: Address) {
    const t = await this.now();
    const p = this.profile(address);
    const available = await this.chain.usdtBalance(address).catch(() => 0n);
    return { name: p?.name ?? short(address), organization: p?.organization ?? short(address), availableMinor: available.toString(), approval: this.approval(address, t), applied: !!p, address: lower(address) };
  }
  apply(address: Address, body: Record<string, unknown>) {
    const text = (value: unknown, field: string, max: number) => {
      if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Refusal('invalid_application', `Enter ${field}.`);
      return value.trim();
    };
    const name = text(body.name, 'your name', 120), organization = text(body.organization, 'your organization', 160);
    const email = text(body.email, 'an email address', 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Refusal('invalid_application', 'Enter a valid email address.');
    const region = text(body.region, 'a two-letter country code', 2).toUpperCase();
    if (!/^[A-Z]{2}$/.test(region)) throw new Refusal('invalid_application', 'Enter a two-letter country code, such as GB.');
    this.db.prepare('INSERT INTO fin_investors VALUES (?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET name=excluded.name,organization=excluded.organization,email=excluded.email,region=excluded.region')
      .run(lower(address), name, organization, email.toLowerCase(), region, nowIso());
    return this.account(address);
  }
  private listedClaims(t: number) {
    return (this.db.prepare("SELECT * FROM fin_claims WHERE status='listed' AND invoice_id IS NOT NULL ORDER BY maturity").all() as ClaimRow[]).filter(c => this.statusOf(c, t) === 'requested');
  }
  async marketplace(address: Address) {
    const t = await this.now();
    return {
      investor: await this.account(address),
      listings: this.listedClaims(t).map(c => this.view(this.invoiceRow(c.invoice_id!), 'investor', address, t)),
      assumptions: FINANCING_ASSUMPTIONS,
    };
  }
  private visible(invoiceId: string, address: string, t: number) {
    const c = currentClaim(this.db, invoiceId);
    const holds = !!c && holdingRows(this.db, c.id).some(h => lower(h.holder) === lower(address));
    if (!c || (this.statusOf(c, t) !== 'requested' && !holds)) throw new Refusal('listing_not_found', 'This listing is not available.');
    return { c, row: this.invoiceRow(invoiceId), holds };
  }
  private counterparties(address: string, t: number) {
    const addresses = new Set<string>([
      ...(this.db.prepare('SELECT address FROM fin_investors').all() as Array<{ address: string }>).map(r => r.address),
      ...(this.db.prepare('SELECT address FROM fin_registry').all() as Array<{ address: string }>).map(r => r.address),
    ]);
    addresses.delete(lower(address));
    return [...addresses].map(a => ({ id: a, organization: this.holderLabel(a).organization, approved: this.approval(a, t).status === 'approved' }));
  }
  async listing(address: Address, invoiceId: string) {
    const t = await this.now();
    const { row, holds } = this.visible(invoiceId, address, t);
    return { investor: await this.account(address), invoice: this.view(row, 'investor', address, t), owned: holds, counterparties: this.counterparties(address, t), assumptions: FINANCING_ASSUMPTIONS };
  }
  async preparePurchase(address: Address, invoiceId: string, faceMinor: unknown): Promise<PreparedSignature> {
    const t = await this.now();
    const { c, row } = this.visible(invoiceId, address, t);
    if (this.statusOf(c, t) !== 'requested') throw new Refusal('not_listed', 'This invoice is no longer listed.');
    const face = this.minor(faceMinor, 'The face value to buy');
    const remaining = big(c.face) - big(c.sold);
    if (face > remaining) throw new Refusal('invalid_amount', `Enter up to ${usd(remaining)}, the face value still for sale.`);
    if (face < T.minShareMinor && face !== remaining) throw new Refusal('invalid_amount', `The smallest share is ${usd(T.minShareMinor)} of face value, unless you buy all that is left.`);
    if (lower(address) === lower(c.merchant)) throw new Refusal('invalid_buyer', 'A business cannot buy its own invoice.');
    const holders = holdingRows(this.db, c.id);
    if (!holders.some(h => lower(h.holder) === lower(address)) && holders.length >= T.maxHolders)
      throw new Refusal('too_many_holders', `This invoice already has ${T.maxHolders} investors, the most one invoice can have.`);
    const who = this.holderLabel(address).organization;
    if (!(await this.chain.isApproved(address))) this.refuse(c, address, 'not_approved', `Purchase by ${who} refused`, this.notApprovedDetail(address, t));
    const { price } = amounts(face, c.discount_bps);
    const balance = await this.chain.usdtBalance(address);
    if (balance < price) throw new Refusal('insufficient_funds', `You have ${usd(balance)} available; ${usd(face)} of this invoice costs ${usd(price)}.`);
    const allowance = await this.chain.allowance(address, this.addresses.receivables);
    // A signed order (and, the first time, a USDT permit) that Pact's relayer submits: no gas for the investor.
    const deadline = t + ORDER_SECONDS;
    const nonce = await this.chain.nonce('receivables', address);
    const order = { claimId: c.id, investor: lower(address), units: face.toString(), maxPrice: price.toString(), deadline: String(deadline) };
    const typedData: Array<Record<string, unknown>> = [{
      domain: this.receivablesDomain(), primaryType: 'Purchase',
      types: { Purchase: [{ name: 'claimId', type: 'uint256' }, { name: 'investor', type: 'address' }, { name: 'units', type: 'uint256' }, { name: 'maxPrice', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
      message: { ...order, nonce: nonce.toString() },
    }];
    let permitValue = '0';
    if (allowance < price) {
      const permit = await this.chain.permit(address);
      permitValue = price.toString();
      typedData.push({
        domain: permit.domain, primaryType: 'Permit',
        types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
        message: { owner: lower(address), spender: lower(this.addresses.receivables), value: permitValue, nonce: permit.nonce.toString(), deadline: String(deadline) },
      });
    }
    return {
      title: `Buy ${usd(face)} of ${this.number(row)}`,
      lines: [
        { label: 'You pay now', value: usd(price) },
        { label: 'You receive', value: `${usd(face)} when ${this.debtorName(row)} pays` },
        { label: 'Maturity', value: date(c.maturity) },
        { label: 'If unpaid', value: `${T.gracePeriodSeconds / DAY}-day grace with a ${percent(T.lateFeeBps)} late fee, then the reserve and ${this.merchantName(String(row.merchant_id))}’s buy-back` },
        { label: 'Gas', value: 'Paid by Pact: you only sign' },
      ],
      typedData,
      order: { ...order, permitValue },
    };
  }

  /** Submits an investor's signed purchase (and permit) from Pact's relayer. */
  async relayPurchase(address: Address, invoiceId: string, body: Record<string, unknown>) {
    const t = await this.now();
    const { c } = this.visible(invoiceId, address, t);
    const order = this.orderOf(body, ['claimId', 'investor', 'units', 'maxPrice', 'deadline', 'permitValue']);
    const signatures = this.signaturesOf(body, BigInt(order.permitValue) > 0n ? 2 : 1);
    if (order.claimId !== c.id || lower(order.investor) !== lower(address)) throw new Refusal('order_mismatch', 'This order is for another listing or investor.');
    const units = BigInt(order.units);
    if (amounts(units, c.discount_bps).price > BigInt(order.maxPrice)) throw new Refusal('price_changed', 'The price is above what you signed for.');
    const who = this.holderLabel(address).organization;
    const permit = BigInt(order.permitValue) > 0n
      ? { value: BigInt(order.permitValue), deadline: BigInt(order.deadline), ...splitSignature(signatures[1]) }
      : { value: 0n, deadline: 0n, v: 0, r: `0x${'0'.repeat(64)}` as Hex, s: `0x${'0'.repeat(64)}` as Hex };
    const data = encodeFunctionData({ abi: receivablesAbi, functionName: 'buyWithSig', args: [{ claimId: BigInt(c.id), investor: getAddress(order.investor), units, maxPrice: BigInt(order.maxPrice), deadline: BigInt(order.deadline) }, signatures[0], { value: permit.value, deadline: permit.deadline, v: Number(permit.v), r: permit.r, s: permit.s }] });
    await this.relayed(address, 'receivables', data, RELAY_GAS.purchase, name =>
      name === 'NotApproved' ? this.refuse(c, address, 'not_approved', `Purchase by ${who} refused`, this.notApprovedDetail(address, t)) : undefined);
    return (await this.listing(address, invoiceId)).invoice;
  }
  async prepareTransfer(address: Address, invoiceId: string, toInvestor: unknown, faceMinor: unknown): Promise<PreparedSignature> {
    const t = await this.now();
    const { c, row, holds } = this.visible(invoiceId, address, t);
    if (!holds) throw new Refusal('not_holder', 'You do not hold part of this invoice.');
    if (typeof toInvestor !== 'string' || !isAddress(toInvestor)) throw new Refusal('invalid_recipient', 'Choose another investor.');
    const to = getAddress(toInvestor);
    if (lower(to) === lower(address)) throw new Refusal('invalid_recipient', 'Choose another investor.');
    const h = holdingRows(this.db, c.id).find(x => lower(x.holder) === lower(address))!;
    const face = this.minor(faceMinor, 'The face value to transfer');
    if (face > big(h.units)) throw new Refusal('invalid_amount', `Enter up to ${usd(big(h.units))}, the face value you hold.`);
    if (face < T.minShareMinor && face !== big(h.units)) throw new Refusal('invalid_amount', `The smallest transfer is ${usd(T.minShareMinor)}, unless you send all you hold.`);
    const from = this.holderLabel(address).organization, toName = this.holderLabel(to).organization;
    const title = `Transfer from ${from} to ${toName} refused`;
    const status = this.statusOf(c, t);
    const closed = status === 'defaulted' ? 'The token is frozen because the invoice defaulted.'
      : status === 'repaid' || status === 'bought_back' ? 'The claim is settled; the tokens are burned.'
      : t >= c.maturity ? 'Transfers ended at maturity. The claim can only be repaid now.'
      : t >= c.maturity - T.recordPeriodSeconds ? `No transfers in the ${T.recordPeriodSeconds / 3600} hours before maturity (the record date), so the list of who gets paid is fixed.`
      : null;
    if (closed) this.refuse(c, address, 'transfer_refused', title, closed);
    if (!(await this.chain.isApproved(address))) this.refuse(c, address, 'transfer_refused', title, this.notApprovedDetail(address, t));
    if (!(await this.chain.isApproved(to))) this.refuse(c, address, 'transfer_refused', title, `${this.notApprovedDetail(to, t)} Only approved investors can hold this token.`);
    const holders = holdingRows(this.db, c.id);
    if (!holders.some(x => lower(x.holder) === lower(to)) && holders.length >= T.maxHolders && face !== big(h.units))
      throw new Refusal('too_many_holders', `This invoice already has ${T.maxHolders} investors, the most one invoice can have.`);
    const deadline = t + ORDER_SECONDS;
    const nonce = await this.chain.nonce('receivables', address);
    const order = { claimId: c.id, from: lower(address), to: lower(to), units: face.toString(), deadline: String(deadline) };
    return {
      title: `Transfer ${usd(face)} of ${this.number(row)}`,
      lines: [{ label: 'To', value: toName }, { label: 'Face value', value: usd(face) }, { label: 'Price', value: 'Agreed between you; Pact does not handle it' }, { label: 'Gas', value: 'Paid by Pact: you only sign' }],
      typedData: [{
        domain: this.receivablesDomain(), primaryType: 'Transfer',
        types: { Transfer: [{ name: 'claimId', type: 'uint256' }, { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'units', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
        message: { ...order, nonce: nonce.toString() },
      }],
      order,
    };
  }

  /** Submits an investor's signed transfer from Pact's relayer. */
  async relayTransfer(address: Address, invoiceId: string, body: Record<string, unknown>) {
    const t = await this.now();
    const { c } = this.visible(invoiceId, address, t);
    const order = this.orderOf(body, ['claimId', 'from', 'to', 'units', 'deadline']);
    const [signature] = this.signaturesOf(body, 1);
    if (order.claimId !== c.id || lower(order.from) !== lower(address) || !isAddress(order.to)) throw new Refusal('order_mismatch', 'This order is for another listing or investor.');
    const title = `Transfer from ${this.holderLabel(address).organization} to ${this.holderLabel(order.to).organization} refused`;
    const data = encodeFunctionData({ abi: receivablesAbi, functionName: 'transferWithSig', args: [{ claimId: BigInt(c.id), from: getAddress(order.from), to: getAddress(order.to), units: BigInt(order.units), deadline: BigInt(order.deadline) }, signature] });
    await this.relayed(address, 'receivables', data, RELAY_GAS.transfer, name =>
      name === 'NotApproved' ? this.refuse(c, address, 'transfer_refused', title, 'The registry refused the sender or the recipient.')
      : name === 'TransfersClosed' ? this.refuse(c, address, 'transfer_refused', title, 'Transfers are closed for this claim.') : undefined);
    return (await this.listing(address, invoiceId)).invoice;
  }

  /**
   * Cancels the signer's current order nonce, so a signed order that did not go through can never run
   * later. Signed like any order; Pact relays it.
   */
  async prepareCancelOrders(address: Address, contract: 'receivables' | 'registry'): Promise<PreparedSignature> {
    if (contract === 'registry') await this.requireOfficer(address);
    const t = await this.now();
    const nonce = await this.chain.nonce(contract, address);
    const order = { signer: lower(address), deadline: String(t + ORDER_SECONDS) };
    return {
      title: 'Cancel signed orders that did not go through',
      lines: [{ label: 'Effect', value: contract === 'receivables' ? 'A purchase or transfer you signed but that was not completed can never run' : 'A decision you signed but that was not completed can never run' }, { label: 'Gas', value: 'Paid by Pact: you only sign' }],
      typedData: [{
        domain: contract === 'receivables' ? this.receivablesDomain() : { name: 'Pact Investor Registry', version: '1', chainId: 1874, verifyingContract: this.addresses.registry },
        primaryType: 'Cancel',
        types: { Cancel: [{ name: 'signer', type: 'address' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
        message: { signer: order.signer, nonce: nonce.toString(), deadline: order.deadline },
      }],
      order,
    };
  }
  async relayCancelOrders(address: Address, contract: 'receivables' | 'registry', body: Record<string, unknown>) {
    if (contract === 'registry') await this.requireOfficer(address);
    const order = this.orderOf(body, ['signer', 'deadline']);
    const [signature] = this.signaturesOf(body, 1);
    if (lower(order.signer) !== lower(address)) throw new Refusal('order_mismatch', 'This cancellation is for another wallet.');
    const data = encodeFunctionData({ abi: contract === 'receivables' ? receivablesAbi : registryAbi, functionName: 'cancelNonceWithSig', args: [getAddress(order.signer), BigInt(order.deadline), signature] });
    await this.relayed(address, contract, data, RELAY_GAS.cancel, () => undefined);
    return { cancelled: true, nonce: (await this.chain.nonce(contract, address)).toString() };
  }

  private receivablesDomain() {
    return { name: 'Pact Receivables', version: '1', chainId: 1874, verifyingContract: this.addresses.receivables };
  }
  private orderOf(body: Record<string, unknown>, fields: string[]) {
    const order = body.order as Record<string, unknown> | undefined;
    if (!order || typeof order !== 'object' || fields.some(f => typeof order[f] !== 'string' || !String(order[f]).trim())) throw new Refusal('invalid_order', 'The signed order is incomplete.');
    for (const f of fields) if (!['investor', 'from', 'to', 'officer', 'region', 'signer'].includes(f) && !/^\d{1,78}$/.test(String(order[f]))) throw new Refusal('invalid_order', 'The signed order is malformed.');
    return order as Record<string, string>;
  }
  private signaturesOf(body: Record<string, unknown>, count: number) {
    const signatures = body.signatures;
    if (!Array.isArray(signatures) || signatures.length !== count || !signatures.every(s => typeof s === 'string' && /^0x[0-9a-fA-F]{130,}$/.test(s))) throw new Refusal('invalid_signature', 'The wallet’s signatures are missing.');
    return signatures as Hex[];
  }
  /**
   * Sends a signed order from Pact's relayer, within a per-wallet allowance, and applies its events.
   * A contract refusal found by the simulation is mapped by `refusal` (which may record it) or
   * reported plainly; nothing is sent and no gas is spent.
   */
  private async relayed(address: Address, contract: 'receivables' | 'registry', data: Hex, gas: bigint, refusal: (name: string) => void) {
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const used = (this.db.prepare('SELECT count(*) n FROM fin_relays WHERE address=? AND at>?').get(lower(address), since) as { n: number }).n;
    if (used >= RELAYS_PER_HOUR) throw new Refusal('relay_limit', `Pact relays up to ${RELAYS_PER_HOUR} signed orders an hour for each wallet. Try again later.`);
    let hash: Hex;
    try { hash = await this.chain.relay(contract, data, gas); }
    catch (error) {
      if (error instanceof Refusal && error.code === 'relay_refused') {
        refusal(error.message);
        throw new Refusal(RELAY_REFUSALS[error.message]?.[0] ?? 'refused', RELAY_REFUSALS[error.message]?.[1] ?? 'The contract refused this order.');
      }
      throw error;
    }
    this.db.prepare('INSERT INTO fin_relays VALUES (?,?,?,?)').run(id('frel'), lower(address), hash, nowIso());
    await this.settle([hash]);
    return hash;
  }
  async portfolio(address: Address) {
    const t = await this.now();
    const mine = (this.db.prepare("SELECT c.*, h.units AS h_units, h.received AS h_received, h.paid AS h_paid, h.holder AS h_holder FROM fin_claims c JOIN fin_holdings h ON h.claim_id=c.id WHERE h.holder=? AND h.units!='0' AND c.invoice_id IS NOT NULL").all(lower(address)) as Array<ClaimRow & { h_units: string; h_received: string; h_paid: string; h_holder: string }>)
      .map(c => ({ c, h: { claim_id: c.id, holder: c.h_holder, units: c.h_units, received: c.h_received, paid: c.h_paid } as HoldingRow, status: this.statusOf(c, t) }));
    const positions = mine.map(({ c }) => this.view(this.invoiceRow(c.invoice_id!), 'investor', address, t))
      .sort((a, b) => STATUS_ORDER.indexOf(a.status!) - STATUS_ORDER.indexOf(b.status!) || a.terms.maturityAt.localeCompare(b.terms.maturityAt));
    const open = mine.filter(m => m.status === 'requested' || m.status === 'funded');
    const late = mine.filter(m => m.status === 'overdue' || m.status === 'defaulted');
    return {
      investor: await this.account(address), positions,
      totals: {
        investedMinor: sum(mine, m => big(m.h.paid)).toString(),
        expectedMinor: sum(open, m => this.owedTo(m.c, m.h, t)).toString(),
        receivedMinor: sum(mine, m => big(m.h.received)).toString(),
        overdueMinor: sum(late, m => this.owedTo(m.c, m.h, t)).toString(),
        open: open.length, overdue: mine.filter(m => m.status === 'overdue').length, defaulted: mine.filter(m => m.status === 'defaulted').length,
        closed: mine.filter(m => m.status === 'repaid' || m.status === 'bought_back').length,
      },
    };
  }

  // ------------------------------------------------------------ compliance

  async requireOfficer(address: Address) {
    if (!(await this.chain.isOfficer(address))) throw new Refusal('not_compliance_officer', 'This wallet is not a compliance officer in the investor registry.');
  }
  private registryInvestor(address: string, t: number) {
    const p = this.profile(address);
    const held = (this.db.prepare(`SELECT h.units FROM fin_holdings h JOIN fin_claims c ON c.id=h.claim_id WHERE h.holder=? AND h.units!='0' AND c.status IN ('listed','funded','defaulted')`).all(lower(address)) as Array<{ units: string }>);
    const r = this.db.prepare('SELECT at FROM fin_registry WHERE address=?').get(lower(address)) as { at: number } | undefined;
    return {
      id: lower(address), name: p?.name ?? short(address), organization: p?.organization ?? short(address), email: p?.email ?? '',
      address: lower(address), approval: this.approval(address, t), appliedAt: p?.applied_at ?? (r ? iso(r.at) : nowIso()),
      heldMinor: sum(held, h => big(h.units)).toString(), positions: held.length,
    };
  }
  async registry(officer: Address) {
    await this.requireOfficer(officer);
    const t = await this.now();
    const addresses = this.counterparties('0x0000000000000000000000000000000000000000', t).map(c => c.id);
    const refusals = (this.db.prepare('SELECT * FROM fin_refusals ORDER BY at DESC LIMIT 200').all() as Array<{ id: string; at: string; invoice_id: string | null; title: string; detail: string }>)
      .filter(r => r.invoice_id)
      .map(r => ({ id: r.id, at: r.at, invoiceId: r.invoice_id!, invoiceNumber: this.number(this.invoiceRow(r.invoice_id!)), title: r.title, detail: r.detail }));
    return { investors: addresses.map(a => this.registryInvestor(a, t)), refusals, assumptions: FINANCING_ASSUMPTIONS };
  }
  /** A registry decision the officer signs and Pact's relayer submits: officers need no gas either. */
  async prepareApproval(officer: Address, investor: unknown, decision: unknown): Promise<PreparedSignature> {
    await this.requireOfficer(officer);
    if (typeof investor !== 'string' || !isAddress(investor)) throw new Refusal('investor_not_found', 'Investor not found.');
    if (decision !== 'approve' && decision !== 'revoke') throw new Refusal('invalid_decision', 'Choose approve or revoke.');
    const t = await this.now();
    const who = this.holderLabel(investor).organization;
    const approved = await this.chain.isApproved(getAddress(investor));
    if (decision === 'approve' && approved) throw new Refusal('already_approved', `${who} is already approved.`);
    if (decision === 'revoke' && !approved) throw new Refusal('not_approved', `${who} is not approved.`);
    const region = this.profile(investor)?.region;
    if (decision === 'approve' && !region) throw new Refusal('no_application', `${who} has not applied: there is no region to record.`);
    const expires = decision === 'approve' ? t + APPROVAL_DAYS * DAY : 0;
    const [nonce, version] = await Promise.all([this.chain.nonce('registry', officer), this.chain.decisionVersion(getAddress(investor))]);
    const order = {
      officer: lower(officer), investor: lower(investor), approve: decision === 'approve' ? '1' : '0', expiresAt: String(expires),
      region: decision === 'approve' ? stringToHex(region!, { size: 2 }) : '0x0000', deadline: String(t + ORDER_SECONDS),
    };
    return {
      title: decision === 'approve' ? `Approve ${who}` : `Revoke ${who}`,
      lines: decision === 'approve'
        ? [{ label: 'Region', value: region! }, { label: 'Approved until', value: date(expires) }, { label: 'Allows', value: 'Buying, sending and receiving receivable tokens' }]
        : [{ label: 'Effect', value: 'Can no longer buy, send or receive receivable tokens' }, { label: 'Unchanged', value: 'Repayments on what it already holds still arrive' }],
      typedData: [{
        domain: { name: 'Pact Investor Registry', version: '1', chainId: 1874, verifyingContract: this.addresses.registry }, primaryType: 'Decision',
        types: { Decision: [{ name: 'officer', type: 'address' }, { name: 'investor', type: 'address' }, { name: 'approve', type: 'bool' }, { name: 'expiresAt', type: 'uint64' }, { name: 'region', type: 'bytes2' }, { name: 'version', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
        message: { officer: order.officer, investor: order.investor, approve: decision === 'approve', expiresAt: order.expiresAt, region: order.region, version: version.toString(), nonce: nonce.toString(), deadline: order.deadline },
      }],
      order,
    };
  }

  /** Submits an officer's signed decision from Pact's relayer. */
  async relayDecision(officer: Address, investor: string, body: Record<string, unknown>) {
    await this.requireOfficer(officer);
    const order = this.orderOf(body, ['officer', 'investor', 'approve', 'expiresAt', 'region', 'deadline']);
    const [signature] = this.signaturesOf(body, 1);
    if (lower(order.officer) !== lower(officer) || lower(order.investor) !== lower(investor) || !isAddress(order.investor) || !/^0x[0-9a-fA-F]{4}$/.test(order.region))
      throw new Refusal('order_mismatch', 'This decision is for another officer or investor.');
    const data = encodeFunctionData({ abi: registryAbi, functionName: 'decideWithSig', args: [{ officer: getAddress(order.officer), investor: getAddress(order.investor), approve: order.approve === '1', expiresAt: BigInt(order.expiresAt), region: order.region as Hex, deadline: BigInt(order.deadline) }, signature] });
    await this.relayed(officer, 'registry', data, RELAY_GAS.decision, () => undefined);
    return this.registryEntry(investor);
  }
  async registryEntry(address: string) { return this.registryInvestor(address, await this.now()); }

  private minor(value: unknown, label: string) {
    if (typeof value !== 'string' || !/^\d{1,30}$/.test(value) || BigInt(value) <= 0n) throw new Refusal('invalid_amount', `${label} must be more than zero.`);
    return BigInt(value);
  }
}

/** v, r and s of a 65-byte signature (a USDT permit), or a refusal for anything else. */
function splitSignature(signature: Hex) {
  try {
    const { r, s, v, yParity } = parseSignature(signature);
    return { r, s, v: v ?? BigInt(27 + yParity) };
  } catch {
    throw new Refusal('invalid_signature', 'The permit signature is malformed. Sign again.');
  }
}

/** The contract status name for an enum index, for receipts read straight from the chain. */
export const claimStatus = (index: number) => CLAIM_STATUSES[index];
export { claimRow };
