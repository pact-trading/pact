import { keccak256, stringToHex, type Hex } from 'viem';
import type { Db } from '../db.js';
import { enqueueWebhook } from '../webhooks.js';
import { PAYMENT_SOURCES, type FinancingEvent } from './chain.js';

/**
 * Financing state, rebuilt from the receivables contract's and the registry's events. Each event is
 * applied once (by id), whether it arrives through the indexer or a submitted receipt.
 */
export function initFinancing(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fin_refs(invoice_ref TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, merchant_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fin_quotes(invoice_ref TEXT NOT NULL, discount_bps INTEGER NOT NULL, day_rate_bps INTEGER NOT NULL,
      days INTEGER NOT NULL, late_premium_bps INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(invoice_ref, discount_bps));
    CREATE TABLE IF NOT EXISTS fin_claims(id TEXT PRIMARY KEY, invoice_id TEXT, merchant_id TEXT, merchant TEXT NOT NULL,
      invoice_ref TEXT NOT NULL, ack_hash TEXT NOT NULL, face TEXT NOT NULL, maturity INTEGER NOT NULL, listed_at INTEGER NOT NULL,
      discount_bps INTEGER NOT NULL, day_rate_bps INTEGER NOT NULL, priced_days INTEGER NOT NULL, late_premium_bps INTEGER NOT NULL,
      status TEXT NOT NULL, late INTEGER NOT NULL DEFAULT 0, sold TEXT NOT NULL DEFAULT '0', collected TEXT NOT NULL DEFAULT '0',
      reserve TEXT NOT NULL DEFAULT '0', raised TEXT NOT NULL DEFAULT '0', fee_taken TEXT NOT NULL DEFAULT '0',
      reserve_funded TEXT NOT NULL DEFAULT '0', reserve_released TEXT NOT NULL DEFAULT '0', reserve_to_holders TEXT NOT NULL DEFAULT '0',
      forwarded TEXT NOT NULL DEFAULT '0', funded_at INTEGER, listing_closed_at INTEGER, defaulted_at INTEGER, closed_at INTEGER,
      advance_tx TEXT, listed_tx TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS fin_claims_invoice ON fin_claims(invoice_id);
    CREATE TABLE IF NOT EXISTS fin_holdings(claim_id TEXT NOT NULL, holder TEXT NOT NULL, units TEXT NOT NULL DEFAULT '0',
      received TEXT NOT NULL DEFAULT '0', paid TEXT NOT NULL DEFAULT '0', PRIMARY KEY(claim_id, holder));
    CREATE TABLE IF NOT EXISTS fin_events(id TEXT PRIMARY KEY, claim_id TEXT, name TEXT NOT NULL, args TEXT NOT NULL,
      tx_hash TEXT NOT NULL, block TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS fin_events_claim ON fin_events(claim_id);
    CREATE TABLE IF NOT EXISTS fin_investors(address TEXT PRIMARY KEY, name TEXT NOT NULL, organization TEXT NOT NULL,
      email TEXT NOT NULL, region TEXT NOT NULL, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fin_registry(address TEXT PRIMARY KEY, approved INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      region TEXT NOT NULL, tx_hash TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS fin_officers(address TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS fin_refusals(id TEXT PRIMARY KEY, at TEXT NOT NULL, claim_id TEXT, invoice_id TEXT, address TEXT,
      title TEXT NOT NULL, detail TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fin_cursor(name TEXT PRIMARY KEY, block TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fin_relays(id TEXT PRIMARY KEY, address TEXT NOT NULL, tx_hash TEXT NOT NULL, at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS fin_relays_address ON fin_relays(address, at);`);
}

export type ClaimRow = {
  id: string; invoice_id: string | null; merchant_id: string | null; merchant: string; invoice_ref: string; ack_hash: string;
  face: string; maturity: number; listed_at: number; discount_bps: number; day_rate_bps: number; priced_days: number;
  late_premium_bps: number; status: string; late: number; sold: string; collected: string; reserve: string; raised: string;
  fee_taken: string; reserve_funded: string; reserve_released: string; reserve_to_holders: string; forwarded: string;
  funded_at: number | null; listing_closed_at: number | null; defaulted_at: number | null; closed_at: number | null;
  advance_tx: string | null; listed_tx: string;
};
export type HoldingRow = { claim_id: string; holder: string; units: string; received: string; paid: string };
export type EventRow = { id: string; claim_id: string | null; name: string; args: string; tx_hash: string; block: string; at: number };

/** The contract's invoice reference: the hash of the API's invoice id. */
export const invoiceRef = (invoiceId: string): Hex => keccak256(stringToHex(invoiceId));
/** Claim statuses while the contract routes the invoice's payments. */
export const ACTIVE_CLAIM = ['listed', 'funded', 'defaulted'];
/** Statuses a listing keeps once it has started; cancelled and withdrawn ones are history. */
export const CURRENT_CLAIM = ['listed', 'funded', 'defaulted', 'repaid', 'bought_back'];

const lower = (value: unknown) => String(value).toLowerCase();
const big = (value: unknown) => BigInt(String(value));
const json = (value: unknown) => JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

export function claimRow(db: Db, claimId: string) {
  return db.prepare('SELECT * FROM fin_claims WHERE id=?').get(claimId) as ClaimRow | undefined;
}
/** The listing an invoice is in now (open, or finished but not cancelled), newest first. */
export function currentClaim(db: Db, invoiceId: string) {
  return db.prepare(`SELECT * FROM fin_claims WHERE invoice_id=? AND status IN (${CURRENT_CLAIM.map(() => '?').join(',')}) ORDER BY CAST(id AS INTEGER) DESC LIMIT 1`)
    .get(invoiceId, ...CURRENT_CLAIM) as ClaimRow | undefined;
}
/** The claim that receives this invoice's payments now, if any. */
export function activeClaim(db: Db, invoiceId: string) {
  return db.prepare(`SELECT * FROM fin_claims WHERE invoice_id=? AND status IN (${ACTIVE_CLAIM.map(() => '?').join(',')}) ORDER BY CAST(id AS INTEGER) DESC LIMIT 1`)
    .get(invoiceId, ...ACTIVE_CLAIM) as ClaimRow | undefined;
}
export function holdingRows(db: Db, claimId: string) {
  return db.prepare("SELECT * FROM fin_holdings WHERE claim_id=? AND units!='0' ORDER BY rowid").all(claimId) as HoldingRow[];
}
export function eventRows(db: Db, claimId: string) {
  return db.prepare('SELECT * FROM fin_events WHERE claim_id=? ORDER BY block, CAST(substr(id, instr(id, \':\') + 1) AS INTEGER)').all(claimId) as EventRow[];
}

function ledger(db: Db, entry: { id: string; merchantId: string | null; invoiceId: string | null; kind: string; amount: bigint; fee?: bigint; tokenDelta: bigint; txHash: string; at: number; block: bigint; customer: string }) {
  if (!entry.merchantId || !entry.invoiceId) return;
  db.prepare('INSERT OR IGNORE INTO accounting_entries(event_id,merchant_id,object_id,kind,amount_minor,fee_minor,gas_wei,token_delta_minor,tx_hash,occurred_at,block_number,customer,refund_of) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(entry.id, entry.merchantId, entry.invoiceId, entry.kind, entry.amount.toString(), (entry.fee ?? 0n).toString(), '0', entry.tokenDelta.toString(), entry.txHash, new Date(entry.at * 1000).toISOString(), entry.block.toString(), entry.customer, '');
}
const investorName = (db: Db, address: string) =>
  (db.prepare('SELECT organization FROM fin_investors WHERE address=?').get(lower(address)) as { organization: string } | undefined)?.organization ?? `${address.slice(0, 6)}…${address.slice(-4)}`;

/** Applies one confirmed event. Returns false when it was already applied. */
export function applyFinancingEvent(db: Db, e: FinancingEvent): boolean {
  const a = e.args;
  const claimId = a.claimId === undefined ? null : String(a.claimId);
  const inserted = db.prepare('INSERT OR IGNORE INTO fin_events VALUES (?,?,?,?,?,?,?)').run(e.id, claimId, e.name, json(a), e.txHash, e.block.toString(), e.at);
  if (!inserted.changes) return false;
  if (e.contract === 'registry') {
    if (e.name === 'InvestorApproved') {
      const region = Buffer.from(String(a.region).slice(2), 'hex').toString('latin1').replace(/\0/g, '');
      db.prepare('INSERT INTO fin_registry VALUES (?,?,?,?,?,?) ON CONFLICT(address) DO UPDATE SET approved=1,expires_at=excluded.expires_at,region=excluded.region,tx_hash=excluded.tx_hash,at=excluded.at')
        .run(lower(a.investor), 1, Number(a.expiresAt), region, e.txHash, e.at);
    }
    if (e.name === 'InvestorRevoked')
      db.prepare("INSERT INTO fin_registry VALUES (?,0,0,'',?,?) ON CONFLICT(address) DO UPDATE SET approved=0,tx_hash=excluded.tx_hash,at=excluded.at").run(lower(a.investor), e.txHash, e.at);
    if (e.name === 'OfficerSet')
      db.prepare('INSERT INTO fin_officers VALUES (?,?) ON CONFLICT(address) DO UPDATE SET enabled=excluded.enabled').run(lower(a.officer), a.enabled ? 1 : 0);
    return true;
  }
  if (e.name === 'Listed') {
    const ref = String(a.invoiceRef).toLowerCase();
    const mapped = db.prepare('SELECT r.invoice_id,r.merchant_id FROM fin_refs r JOIN merchants m ON m.id=r.merchant_id WHERE r.invoice_ref=? AND lower(m.address)=?').get(ref, lower(a.merchant)) as { invoice_id: string; merchant_id: string } | undefined;
    const quote = db.prepare('SELECT * FROM fin_quotes WHERE invoice_ref=? AND discount_bps=?').get(ref, Number(a.discountBps)) as { day_rate_bps: number; days: number; late_premium_bps: number } | undefined;
    const days = Math.max(1, Math.floor((Number(a.maturity) - e.at) / 86_400));
    db.prepare(`INSERT OR IGNORE INTO fin_claims(id,invoice_id,merchant_id,merchant,invoice_ref,ack_hash,face,maturity,listed_at,discount_bps,day_rate_bps,priced_days,late_premium_bps,status,listed_tx)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'listed',?)`).run(claimId, mapped?.invoice_id ?? null, mapped?.merchant_id ?? null, lower(a.merchant), ref, String(a.ackHash).toLowerCase(),
      String(a.face), Number(a.maturity), e.at, Number(a.discountBps), quote?.day_rate_bps ?? 0, quote?.days ?? days, quote?.late_premium_bps ?? 0, e.txHash);
    if (mapped) syncInvoiceStatus(db, mapped.invoice_id, 'listed');
    return true;
  }
  const c = claimId ? claimRow(db, claimId) : undefined;
  if (!c) return true; // Not a claim this API listed (or a Credited/Withdrawal event): kept for the record only.
  const update = (fields: Record<string, string | number | null>) =>
    db.prepare(`UPDATE fin_claims SET ${Object.keys(fields).map(k => `${k}=?`).join(',')} WHERE id=?`).run(...Object.values(fields), c.id);
  const holding = (holder: string) => db.prepare('SELECT * FROM fin_holdings WHERE claim_id=? AND holder=?').get(c.id, lower(holder)) as HoldingRow | undefined;
  const setHolding = (holder: string, units: bigint, received: bigint, paid: bigint) =>
    db.prepare('INSERT INTO fin_holdings VALUES (?,?,?,?,?) ON CONFLICT(claim_id,holder) DO UPDATE SET units=excluded.units,received=excluded.received,paid=excluded.paid')
      .run(c.id, lower(holder), units.toString(), received.toString(), paid.toString());
  switch (e.name) {
    case 'Purchased': {
      const h = holding(String(a.investor));
      setHolding(String(a.investor), big(h?.units ?? 0) + big(a.units), big(h?.received ?? 0), big(h?.paid ?? 0) + big(a.price));
      update({
        sold: (big(c.sold) + big(a.units)).toString(), reserve: (big(c.reserve) + big(a.reserve)).toString(),
        reserve_funded: (big(c.reserve_funded) + big(a.reserve)).toString(), raised: (big(c.raised) + big(a.price)).toString(),
        fee_taken: (big(c.fee_taken) + big(a.fee)).toString(), funded_at: c.funded_at ?? e.at, advance_tx: c.advance_tx ?? e.txHash,
      });
      const customer = investorName(db, String(a.investor));
      ledger(db, { id: `${e.id}:advance`, merchantId: c.merchant_id, invoiceId: c.invoice_id, kind: 'Financing advance', amount: big(a.price), fee: big(a.fee), tokenDelta: big(a.upfront), txHash: e.txHash, at: e.at, block: e.block, customer });
      ledger(db, { id: `${e.id}:reserve`, merchantId: c.merchant_id, invoiceId: c.invoice_id, kind: 'Financing reserve', amount: -big(a.reserve), tokenDelta: 0n, txHash: e.txHash, at: e.at, block: e.block, customer });
      break;
    }
    case 'ListingClosed':
      update({ status: 'funded', listing_closed_at: e.at });
      if (c.merchant_id && c.invoice_id) enqueueWebhook(db, c.merchant_id, 'invoice.financed', c.invoice_id, { claim_id: c.id, sold_minor: String(a.sold), tx_hash: e.txHash });
      break;
    case 'Cancelled':
      update({ status: 'cancelled', closed_at: e.at });
      break;
    case 'Withdrawn':
      update({ status: 'withdrawn', closed_at: e.at });
      break;
    case 'Transferred': {
      const from = holding(String(a.from));
      if (!from) break;
      const units = big(a.units), moved = big(a.received);
      const paid = big(from.units) > 0n ? (big(from.paid) * units) / big(from.units) : 0n;
      setHolding(String(a.from), big(from.units) - units, big(from.received) - moved, big(from.paid) - paid);
      const to = holding(String(a.to));
      setHolding(String(a.to), big(to?.units ?? 0) + units, big(to?.received ?? 0) + moved, big(to?.paid ?? 0) + paid);
      break;
    }
    case 'Paid': {
      update({ collected: (big(c.collected) + big(a.amount)).toString(), forwarded: (big(c.forwarded) + big(a.toHolders)).toString() });
      if (big(a.toHolders) > 0n)
        ledger(db, { id: `${e.id}:repayment`, merchantId: c.merchant_id, invoiceId: c.invoice_id, kind: 'Financing repayment', amount: -big(a.toHolders), tokenDelta: 0n, txHash: e.txHash, at: e.at, block: e.block, customer: 'Claim holders' });
      break;
    }
    case 'HolderPaid': {
      const h = holding(String(a.holder));
      setHolding(String(a.holder), big(h?.units ?? 0), big(h?.received ?? 0) + big(a.amount), big(h?.paid ?? 0));
      if (PAYMENT_SOURCES[Number(a.source)] === 'reserve') update({ reserve_to_holders: (big(c.reserve_to_holders) + big(a.amount)).toString() });
      break;
    }
    case 'Settled': {
      const fromReserve = big(a.fromReserve), released = big(a.reserveReleased);
      const late = c.late || e.at > c.maturity ? 1 : 0;
      update({ status: 'repaid', late, closed_at: e.at, reserve: (big(c.reserve) - fromReserve - released).toString(), reserve_released: (big(c.reserve_released) + released).toString() });
      if (fromReserve + released > 0n)
        ledger(db, { id: `${e.id}:reserve`, merchantId: c.merchant_id, invoiceId: c.invoice_id, kind: 'Financing reserve', amount: fromReserve + released, tokenDelta: released, txHash: e.txHash, at: e.at, block: e.block, customer: 'Receivables contract' });
      if (fromReserve > 0n)
        ledger(db, { id: `${e.id}:late-fee`, merchantId: c.merchant_id, invoiceId: c.invoice_id, kind: 'Financing late fee', amount: -fromReserve, tokenDelta: 0n, txHash: e.txHash, at: e.at, block: e.block, customer: 'Claim holders' });
      if (c.merchant_id && c.invoice_id) enqueueWebhook(db, c.merchant_id, 'invoice.settled', c.invoice_id, { claim_id: c.id, tx_hash: e.txHash });
      break;
    }
    case 'Defaulted':
      update({ status: 'defaulted', late: 1, defaulted_at: e.at, reserve: (big(c.reserve) - big(a.fromReserve)).toString() });
      if (c.merchant_id && c.invoice_id) enqueueWebhook(db, c.merchant_id, 'invoice.defaulted', c.invoice_id, { claim_id: c.id, buy_back_minor: String(a.buyBackOwed), tx_hash: e.txHash });
      break;
    case 'BoughtBack':
      update({ status: 'bought_back', closed_at: e.at, reserve: '0' });
      ledger(db, { id: `${e.id}:buy-back`, merchantId: c.merchant_id, invoiceId: c.invoice_id, kind: 'Financing buy-back', amount: -big(a.amount), tokenDelta: -big(a.amount), txHash: e.txHash, at: e.at, block: e.block, customer: 'Claim holders' });
      if (c.merchant_id && c.invoice_id) enqueueWebhook(db, c.merchant_id, 'invoice.bought_back', c.invoice_id, { claim_id: c.id, amount_minor: String(a.amount), tx_hash: e.txHash });
      break;
  }
  if (c.invoice_id) syncInvoiceStatus(db, c.invoice_id, claimRow(db, c.id)!.status);
  return true;
}

/**
 * The invoice's own `financing_status`, which the dashboard counts and the export shows: `requested`
 * while listed, `financed` once investors hold it, then `defaulted`, `repaid` or `bought_back`. A
 * cancelled or withdrawn listing clears it.
 */
const INVOICE_FINANCING_STATUS: Record<string, string | null> = {
  listed: 'requested', funded: 'financed', defaulted: 'defaulted', repaid: 'repaid', bought_back: 'bought_back', cancelled: null, withdrawn: null,
};
function syncInvoiceStatus(db: Db, invoiceId: string, claimStatus: string) {
  if (claimStatus in INVOICE_FINANCING_STATUS) db.prepare('UPDATE invoices SET financing_status=? WHERE id=?').run(INVOICE_FINANCING_STATUS[claimStatus], invoiceId);
}

/** Applies a batch of confirmed events in one database transaction. */
export function applyFinancingEvents(db: Db, events: FinancingEvent[]) {
  let applied = 0;
  db.transaction(() => { for (const e of events) if (applyFinancingEvent(db, e)) applied++; })();
  return applied;
}
