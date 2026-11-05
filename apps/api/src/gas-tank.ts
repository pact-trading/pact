import { decodeFunctionData, type Address } from 'viem';
import { escrowAbi, receivablesAbi, subscriptionAbi } from './chain.js';
import type { Db } from './db.js';
import { now } from './db.js';
import type { Relayer } from './relayer.js';
import type { ChainAdapter, IntentRequest } from './types.js';
import { Refusal } from './types.js';

export type SponsoredAction = 'payment' | 'refund' | 'subscribe' | 'renewal' | 'cancel' | 'invoice_acknowledge' | 'account_setup' | 'agent_settlement';
const DAY = 86_400_000;
const WEI = 10n ** 18n;

/** What a sponsored Router call did, read from its signed calldata. */
export function sponsoredAction(request: IntentRequest): { action: SponsoredAction; objectId: string } | null {
  try {
    const call = decodeFunctionData({ abi: escrowAbi, data: request.data });
    const id = String(call.args?.[0] ?? '');
    if (['charge', 'authorize', 'capture'].includes(call.functionName)) return { action: 'payment', objectId: id };
    if (['refund', 'void', 'reclaim'].includes(call.functionName)) return { action: 'refund', objectId: id };
  } catch { /* not an escrow call */ }
  try {
    const call = decodeFunctionData({ abi: subscriptionAbi, data: request.data });
    const action = ({ subscribe: 'subscribe', replace: 'subscribe', charge: 'renewal', cancel: 'cancel' } as const)[call.functionName as 'subscribe'];
    if (action) return { action, objectId: call.functionName === 'subscribe' ? '' : String(call.args?.[0] ?? '') };
  } catch { /* not a subscription call */ }
  try {
    const call = decodeFunctionData({ abi: receivablesAbi, data: request.data });
    if (call.functionName === 'pay') return { action: 'payment', objectId: String(call.args?.[1] ?? '') };
  } catch { /* not a financed invoice payment */ }
  return null;
}

const labels: Record<SponsoredAction, string> = {
  payment: 'Payment', refund: 'Refund', subscribe: 'New subscription', renewal: 'Subscription renewal', cancel: 'Cancellation',
  invoice_acknowledge: 'Invoice acknowledgement', account_setup: 'Account setup', agent_settlement: 'Agent payment',
};

export interface GasPolicyPreferences { mode: 'absorb' | 'surcharge'; surchargeMinor: string; lowRunwayAlertDays: number }
const defaultPolicy: GasPolicyPreferences = { mode: 'absorb', surchargeMinor: '0', lowRunwayAlertDays: 7 };

export function gasPolicyPreferences(db: Db, merchantId: string): GasPolicyPreferences {
  const row = db.prepare('SELECT mode,surcharge_minor,low_runway_alert_days FROM merchant_gas_policy WHERE merchant_id=?').get(merchantId) as { mode: 'absorb' | 'surcharge'; surcharge_minor: string; low_runway_alert_days: number } | undefined;
  return row ? { mode: row.mode, surchargeMinor: row.surcharge_minor, lowRunwayAlertDays: row.low_runway_alert_days } : { ...defaultPolicy };
}
/** Off-chain preferences only. Router limits are global contract settings and cannot be changed here. */
export function updateGasPolicy(db: Db, merchantId: string, body: Record<string, unknown>) {
  const next = gasPolicyPreferences(db, merchantId);
  if (body.mode !== undefined) {
    if (body.mode !== 'absorb' && body.mode !== 'surcharge') throw new Refusal('invalid_gas_mode');
    next.mode = body.mode;
  }
  if (body.surchargeMinor !== undefined) {
    if (typeof body.surchargeMinor !== 'string' || !/^\d{1,12}$/.test(body.surchargeMinor) || BigInt(body.surchargeMinor) > 10_000_000n) throw new Refusal('invalid_surcharge');
    next.surchargeMinor = BigInt(body.surchargeMinor).toString();
  }
  if (body.lowRunwayAlertDays !== undefined) {
    if (!Number.isInteger(body.lowRunwayAlertDays) || (body.lowRunwayAlertDays as number) < 1 || (body.lowRunwayAlertDays as number) > 90) throw new Refusal('invalid_alert_days');
    next.lowRunwayAlertDays = body.lowRunwayAlertDays as number;
  }
  for (const key of Object.keys(body)) if (!['mode', 'surchargeMinor', 'lowRunwayAlertDays'].includes(key)) throw new Refusal('contract_setting', `${key} is a contract setting and cannot be changed here`);
  db.prepare(`INSERT INTO merchant_gas_policy VALUES (?,?,?,?,?) ON CONFLICT(merchant_id) DO UPDATE SET mode=excluded.mode,surcharge_minor=excluded.surcharge_minor,low_runway_alert_days=excluded.low_runway_alert_days,updated_at=excluded.updated_at`)
    .run(merchantId, next.mode, next.surchargeMinor, next.lowRunwayAlertDays, now());
  return next;
}

/** USDT base units per 1 WBT for USD estimates. Testnet default follows the WWBT/USDT pool. */
export const wbtUsdMinor = (env = process.env) => {
  const value = Number(env.WBT_USD_ESTIMATE ?? '79');
  return BigInt(Math.round((Number.isFinite(value) && value > 0 ? value : 79) * 1_000_000));
};

export function gasLedger(db: Db, merchantId: string, limit = 50, rate = wbtUsdMinor()) {
  const rows = db.prepare('SELECT id,tx_hash,cost_wei,created_at,fee_usdt,action,object_id FROM gas_ledger WHERE merchant_id=? ORDER BY created_at DESC LIMIT ?')
    .all(merchantId, Math.max(1, Math.min(500, limit))) as Array<{ id: string; tx_hash: string; cost_wei: string; created_at: string; fee_usdt: string; action: SponsoredAction | null; object_id: string | null }>;
  return rows.map(r => {
    const action = r.action ?? 'payment';
    return { id: r.id, createdAt: r.created_at, action, objectId: r.object_id ?? '', label: labels[action], gasWei: r.cost_wei,
      gasUsdMinor: ((BigInt(r.cost_wei) * rate) / WEI).toString(), feeMinor: r.fee_usdt ?? '0', txHash: r.tx_hash };
  });
}

/** Whole days left. Uses the average of the last seven days with spend, so one busy hour does not swing it. */
export function runwayDays(db: Db, merchantId: string, balanceWei: bigint, at = new Date()): number | null {
  const since = new Date(at.getTime() - 6 * DAY).toISOString().slice(0, 10);
  const rows = db.prepare('SELECT cost_wei,created_at FROM gas_ledger WHERE merchant_id=? AND created_at>=?').all(merchantId, since) as Array<{ cost_wei: string; created_at: string }>;
  const perDay = new Map<string, bigint>();
  for (const row of rows) perDay.set(row.created_at.slice(0, 10), (perDay.get(row.created_at.slice(0, 10)) ?? 0n) + BigInt(row.cost_wei));
  const spending = [...perDay.values()].filter(spent => spent > 0n);
  if (!spending.length) return null;
  return Number(balanceWei / (spending.reduce((total, spent) => total + spent, 0n) / BigInt(spending.length)));
}

export async function gasTankDetail(db: Db, chain: ChainAdapter, relayer: Relayer, auth: { merchantId: string; address: Address }, options: { localFaucet?: boolean } = {}) {
  const [tank, policy] = await Promise.all([chain.gasTank(auth.address), chain.routerPolicy().catch(() => undefined)]);
  const since = new Date(Date.now() - 14 * DAY).toISOString();
  const rows = db.prepare('SELECT cost_wei,created_at FROM gas_ledger WHERE merchant_id=? AND created_at>=?').all(auth.merchantId, since) as Array<{ cost_wei: string; created_at: string }>;
  const history = Array.from({ length: 14 }, (_, i) => {
    const date = new Date(Date.now() - (13 - i) * DAY).toISOString().slice(0, 10);
    const day = rows.filter(r => r.created_at.startsWith(date));
    return { date, spentWei: day.reduce((t, r) => t + BigInt(r.cost_wei), 0n).toString(), actions: day.length };
  });
  // Runway uses the average of the last seven days with spend, so one busy hour does not swing it.
  const week = history.slice(-7).filter(d => BigInt(d.spentWei) > 0n);
  const average = week.length ? week.reduce((t, d) => t + BigInt(d.spentWei), 0n) / BigInt(week.length) : 0n;
  const refusals = db.prepare("SELECT reason,COUNT(*) count FROM refusal_attempts WHERE merchant_id=? AND source IN ('relayer','contract') GROUP BY reason").all(auth.merchantId) as Array<{ reason: string; count: number }>;
  const prefs = gasPolicyPreferences(db, auth.merchantId);
  return {
    merchant: auth.address,
    balanceWei: tank.balanceWei.toString(),
    dailyCapWei: tank.dailyCapWei.toString(),
    spentTodayWei: tank.spentTodayWei.toString(),
    runwayDays: runwayDays(db, auth.merchantId, tank.balanceWei),
    refusals,
    policy: {
      ...prefs,
      perPayerDailyActions: policy?.maxPayerCallsPerDay ?? 10,
      minimumAmountMinor: (policy?.minimumAmountMinor ?? relayer.minimumAmount).toString(),
      maxGasPerCall: Number(policy?.maxGasPerCall ?? 1_000_000n),
      maxFeePerGasWei: (policy?.maxGasPriceWei ?? 100_000_000_000n).toString(),
    },
    wbtUsdMinor: wbtUsdMinor().toString(),
    faucet: {
      amountWei: (WEI / 2n).toString(),
      nextClaimAt: null,
      source: options.localFaucet ? 'Local test faucet (local fork only)' : 'Whitechain faucet (faucet.testnet.whitechain.io): one drip per GitHub account, accounts older than 30 days',
    },
    history,
    pausedSeconds: relayer.pausedFor(auth.address),
  };
}
