import { encodeFunctionData, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { amountString, id, type Db } from './db.js';
import { feeScheduleAbi } from './chain.js';
import { UNLIMITED, type ApprovalService, type ApprovalTarget } from './approval.js';
import { termsView } from './pricing.js';
import type { SponsorshipBudget } from './sponsorship.js';
import type { ChainAdapter, MerchantFees } from './types.js';
import { Refusal } from './types.js';
import { acceptTermsTypedData } from './typed-data.js';

type Auth = { merchantId: string; address: Address };
const DAY = 86_400_000;
const ACCEPT_GAS = 120_000n;
const toJson = (value: unknown) => JSON.parse(JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v));

/**
 * The standing allowances a merchant signs once, as EIP-2612 permits Pact's relayer submits: the
 * escrow returns refunds from the merchant's wallet, and the Router takes a refund's gas in USDT.
 * Both are spent only on calls the merchant itself signs. A buy-back asks for its own permit.
 */
export type MerchantSpender = 'escrow' | 'router';
export const MERCHANT_SPENDERS: MerchantSpender[] = ['escrow', 'router'];
const SPENDER_LABELS: Record<MerchantSpender, string> = {
  escrow: 'Refunds: the escrow sends a refund from your wallet when you issue one',
  router: 'Refund gas: the network fee for a refund you send, in USDT',
};
export function merchantPermitTarget(auth: Auth, spender: MerchantSpender, addresses: Record<MerchantSpender, Address>): ApprovalTarget {
  return { key: `merchant:${auth.merchantId}:${spender}`, merchant: auth.merchantId, payer: auth.address, spender: addresses[spender], amount: UNLIMITED, minimumBalance: 0n };
}
export function isMerchantSpender(value: string): value is MerchantSpender { return (MERCHANT_SPENDERS as string[]).includes(value); }

/** What a merchant needs to sign to accept the latest fee terms. */
export async function acceptanceOffer(chain: ChainAdapter, feesAddress: Address, auth: Auth) {
  const fees = await chain.merchantFees(auth.address);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  return toJson({
    version: fees.latestVersion, terms: termsView(fees.latest), deadline: deadline.toString(), nonce: fees.nonce.toString(),
    typedData: acceptTermsTypedData(auth.address, fees.latestVersion, fees.nonce, deadline, feesAddress),
  });
}

/** Submits a merchant's signed acceptance from the relayer, which pays the gas. */
export async function acceptTerms(chain: ChainAdapter, feesAddress: Address, auth: Auth, body: Record<string, unknown>, budget?: SponsorshipBudget) {
  if (Object.keys(body).some(k => !['version', 'deadline', 'signature'].includes(k))) throw new Refusal('unexpected_field');
  const fees = await chain.merchantFees(auth.address);
  const version = Number(body.version);
  if (!Number.isSafeInteger(version) || version !== fees.latestVersion) throw new Refusal('fee_terms_changed', 'Pact published newer terms. Review them and sign again.');
  if (fees.acceptedVersion === version) return feeTermsStatus(fees);
  let deadline: bigint;
  try { deadline = BigInt(String(body.deadline)); } catch { throw new Refusal('invalid_deadline'); }
  const seconds = BigInt(Math.floor(Date.now() / 1000));
  if (deadline <= seconds || deadline > seconds + 3_600n) throw new Refusal('invalid_deadline');
  if (typeof body.signature !== 'string' || !/^0x[0-9a-f]{130}$/i.test(body.signature)) throw new Refusal('invalid_signature');
  let signer: Address;
  try { signer = await recoverTypedDataAddress({ ...acceptTermsTypedData(auth.address, version, fees.nonce, deadline, feesAddress), signature: body.signature as Hex }); }
  catch { throw new Refusal('invalid_signature'); }
  if (signer.toLowerCase() !== auth.address.toLowerCase()) throw new Refusal('invalid_signature');
  const price = await chain.gasPrice();
  budget?.assert(auth.merchantId, ACCEPT_GAS * price, fees.usdtPerWbt);
  const data = encodeFunctionData({ abi: feeScheduleAbi, functionName: 'acceptWithSig', args: [auth.address, version, deadline, body.signature as Hex] });
  const operation = { id: id('fees'), kind: 'fees' as const, objectId: auth.merchantId, links: { merchantId: auth.merchantId } };
  const txHash = await chain.relay(operation, feesAddress, data, ACCEPT_GAS);
  budget?.record(operation.id, auth.merchantId, ACCEPT_GAS * price, 'fees');
  return { ...feeTermsStatus({ ...fees, acceptedVersion: version, accepted: fees.latest }), txHash };
}

export function feeTermsStatus(fees: MerchantFees) {
  return {
    acceptedVersion: fees.acceptedVersion, latestVersion: fees.latestVersion,
    accepted: fees.accepted ? termsView(fees.accepted) : null, latest: termsView(fees.latest),
    needsAcceptance: fees.acceptedVersion === 0, newerTermsAvailable: fees.acceptedVersion !== 0 && fees.acceptedVersion < fees.latestVersion,
  };
}

const labels: Record<string, string> = { Payment: 'Payment', Subscription: 'Subscription renewal', Fee: 'Refund network fee', Refund: 'Refund' };

/** Every fee Pact took from this merchant, newest first, from confirmed events only. */
export function feeLedger(db: Db, merchantId: string, limit = 50) {
  // Only refunds and financing buy-backs pay a network fee; a refund's transaction also books the refund.
  const rows = db.prepare(`SELECT e.event_id,e.kind,e.object_id,e.amount_minor,e.fee_minor,e.tx_hash,e.occurred_at,
      EXISTS(SELECT 1 FROM accounting_entries r WHERE r.merchant_id=e.merchant_id AND r.kind='Refund' AND lower(r.tx_hash)=lower(e.tx_hash)) AS refund
    FROM accounting_entries e WHERE e.merchant_id=? AND e.fee_minor!='0' ORDER BY e.occurred_at DESC, e.event_id DESC LIMIT ?`)
    .all(merchantId, Math.max(1, Math.min(500, limit))) as Array<{ event_id: string; kind: string; object_id: string; amount_minor: string; fee_minor: string; tx_hash: string; occurred_at: string; refund: number }>;
  return rows.map(r => {
    const gross = r.kind === 'Fee' ? 0n : BigInt(r.amount_minor), fee = BigInt(r.fee_minor);
    const label = r.kind === 'Fee' && !r.refund ? 'Buy-back network fee' : labels[r.kind] ?? r.kind;
    return { id: r.event_id, at: r.occurred_at, kind: r.kind, label, objectId: r.object_id,
      grossUsdt: amountString(gross), feeUsdt: amountString(fee), netUsdt: amountString(gross - fee), txHash: r.tx_hash };
  });
}

/** Fees over the last `days` days. */
function feeTotals(db: Db, merchantId: string, days: number) {
  const since = new Date(Date.now() - days * DAY).toISOString();
  let gross = 0n, fees = 0n, count = 0;
  for (const row of db.prepare("SELECT kind,amount_minor,fee_minor FROM accounting_entries WHERE merchant_id=? AND occurred_at>=? AND kind IN ('Payment','Subscription','Fee')").iterate(merchantId, since) as Iterable<{ kind: string; amount_minor: string; fee_minor: string }>) {
    if (row.kind !== 'Fee') { gross += BigInt(row.amount_minor); count++; }
    fees += BigInt(row.fee_minor);
  }
  return { days, grossUsdt: amountString(gross), feesUsdt: amountString(fees), netUsdt: amountString(gross - fees), payments: count, effectiveRateBps: gross > 0n ? Number(fees * 10_000n / gross) : null };
}

/** The merchant's fees page: its signed terms, standing permits, totals and recent fees. */
export async function feesDetail(db: Db, chain: ChainAdapter, approval: ApprovalService, auth: Auth, spenders: Record<MerchantSpender, Address>) {
  const fees = await chain.merchantFees(auth.address);
  const permits = await Promise.all(MERCHANT_SPENDERS.map(async spender => {
    const readiness = await approval.getFor(merchantPermitTarget(auth, spender, spenders)).catch(() => null);
    return { spender, label: SPENDER_LABELS[spender], address: spenders[spender], status: readiness?.status ?? 'unavailable', reason: readiness?.reason ?? null };
  }));
  return toJson({
    terms: feeTermsStatus(fees),
    permits,
    ready: fees.acceptedVersion !== 0 && permits.every(p => p.status === 'ready'),
    totals: feeTotals(db, auth.merchantId, 30),
    ledger: feeLedger(db, auth.merchantId, 20),
  });
}
