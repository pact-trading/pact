import type { Db } from './db.js';
import type { ChainEvent } from './types.js';

export function initAccounting(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS accounting_entries(
    event_id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,object_id TEXT NOT NULL,
    kind TEXT NOT NULL,amount_minor TEXT NOT NULL,fee_minor TEXT NOT NULL DEFAULT '0',
    gas_wei TEXT NOT NULL DEFAULT '0',token_delta_minor TEXT,tx_hash TEXT NOT NULL,
    occurred_at TEXT NOT NULL,block_number TEXT NOT NULL,customer TEXT NOT NULL DEFAULT '',
    refund_of TEXT NOT NULL DEFAULT ''
  ); CREATE INDEX IF NOT EXISTS accounting_merchant_date ON accounting_entries(merchant_id,occurred_at);
    CREATE TABLE IF NOT EXISTS accounting_state(id INTEGER PRIMARY KEY CHECK(id=1),coverage_complete INTEGER NOT NULL);
    INSERT OR IGNORE INTO accounting_state VALUES (1,CASE WHEN EXISTS(SELECT 1 FROM chain_events) THEN 0 ELSE 1 END);`);
}

/** Only call for confirmed, verified suite events, within the indexer's DB transaction. */
export function recordAccounting(db: Db, event: ChainEvent) {
  const objectId = String(event.args.id ?? event.args.paymentId ?? '');
  let owner: { merchant_id: string; customer: string | null; payer: string | null; address: string; amount_minor?: string } | undefined;
  let kind: string, amount = 0n, fee = 0n, tokenDelta: bigint | null = null, refundOf = '';
  // Pact's fee comes out of the payment: the merchant's wallet moves by the amount less the fee.
  const feeOf = () => BigInt(event.args.fee ?? 0);
  if (event.contract === 'escrow' && ['Charged', 'Captured', 'Refunded'].includes(event.name)) {
    owner = db.prepare('SELECT p.merchant_id,p.customer,p.payer,p.amount_minor,m.address FROM payments p JOIN merchants m ON m.id=p.merchant_id WHERE p.id=?').get(objectId) as typeof owner;
    if (!owner) return;
    amount = BigInt(event.args.amount);
    if (event.args.merchant !== undefined && String(event.args.merchant).toLowerCase() !== owner.address.toLowerCase()) return;
    if (event.name === 'Charged' && amount !== BigInt(owner.amount_minor!)) return;
    kind = event.name === 'Refunded' ? 'Refund' : 'Payment';
    if (kind === 'Refund') { amount = -amount; refundOf = objectId; }
    else fee = feeOf();
    const payer = String(event.args.payer ?? owner.payer ?? '').toLowerCase();
    // Captures transfer from escrow; direct charges and refunds can be self-transfers.
    const self = payer === owner.address.toLowerCase();
    tokenDelta = event.name === 'Captured' ? amount - fee : payer ? (self ? (kind === 'Refund' ? 0n : -fee) : amount - fee) : null;
  } else if (event.contract === 'receivables' && event.name === 'Paid') {
    // A financed invoice's payment. The merchant's books show the whole payment as income; the part the
    // contract sent to the claim holders leaves again as a financing repayment, booked from the same event.
    owner = db.prepare('SELECT p.merchant_id,p.customer,p.payer,p.amount_minor,m.address FROM payments p JOIN merchants m ON m.id=p.merchant_id WHERE p.id=?').get(objectId) as typeof owner;
    if (!owner) return;
    kind = 'Payment'; amount = BigInt(event.args.amount); fee = feeOf();
    tokenDelta = BigInt(event.args.toMerchant ?? 0);
  } else if (event.contract === 'subscription' && event.name === 'Charged') {
    owner = db.prepare('SELECT s.merchant_id,s.payer AS customer,s.payer,m.address FROM subscriptions s JOIN merchants m ON m.id=s.merchant_id WHERE lower(s.chain_id)=lower(?)').get(objectId) as typeof owner;
    if (!owner) return;
    kind = 'Subscription'; amount = BigInt(event.args.amount); fee = feeOf();
    tokenDelta = owner.payer ? (owner.payer.toLowerCase() === owner.address.toLowerCase() ? -fee : amount - fee) : null;
  } else if (event.contract === 'router' && event.name === 'Executed') {
    // Only a merchant-paid call (a refund, a buy-back) charges gas, in USDT, on top of the money it sends.
    fee = BigInt(event.args.gasFee ?? 0);
    if (fee === 0n) return;
    const merchant = db.prepare('SELECT id,address FROM merchants WHERE lower(address)=lower(?)').get(String(event.args.merchant)) as { id: string; address: string } | undefined;
    if (!merchant) return;
    owner = { merchant_id: merchant.id, address: merchant.address, payer: null, customer: null };
    kind = 'Fee';
    tokenDelta = -fee;
  } else return;
  // A fee paid to the merchant itself (a merchant that is also the fee recipient) never left its wallet.
  if (fee !== 0n && tokenDelta !== null && event.feeRecipient && event.feeRecipient.toLowerCase() === owner.address.toLowerCase()) tokenDelta += fee;
  // Never invent a block time from HTTP request or indexer wall-clock time.
  if (!event.timestamp || !Number.isFinite(Date.parse(event.timestamp))) throw new Error('Accounting requires the confirmed block timestamp');
  db.prepare('INSERT OR IGNORE INTO accounting_entries(event_id,merchant_id,object_id,kind,amount_minor,fee_minor,gas_wei,token_delta_minor,tx_hash,occurred_at,block_number,customer,refund_of) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(event.id, owner.merchant_id, objectId || event.id, kind, amount.toString(), fee.toString(), '0', tokenDelta?.toString() ?? null, event.txHash, new Date(event.timestamp).toISOString(), event.block.toString(), owner.customer ?? '', refundOf);
}
