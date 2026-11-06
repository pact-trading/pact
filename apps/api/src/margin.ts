import type { Db } from './db.js';

const DAY = 86_400_000;

/**
 * Pact's margin over the last `days` days: every fee it took in USDT (payment and renewal fees, and
 * the network fees merchants paid on refunds and buy-backs), against what its relayer actually spent
 * on gas, by kind of write. Gas is measured from confirmed receipts; writes confirmed before costs were
 * recorded count as `unmeasured`.
 */
export function relayerMargin(db: Db, days = 30, usdtPerWbt?: bigint, at = Date.now()) {
  const since = new Date(at - days * DAY).toISOString();
  const fees = db.prepare("SELECT kind, COALESCE(SUM(CAST(fee_minor AS INTEGER)),0) AS minor, COUNT(*) AS n FROM accounting_entries WHERE occurred_at>=? AND fee_minor!='0' GROUP BY kind").all(since) as Array<{ kind: string; minor: number | bigint; n: number }>;
  const gas = db.prepare("SELECT kind, gas_cost_wei FROM relayer_operations WHERE phase='confirmed' AND updated_at>=?").all(since) as Array<{ kind: string; gas_cost_wei: string | null }>;
  const byKind = new Map<string, { writes: number; wei: bigint; unmeasured: number }>();
  for (const row of gas) {
    const entry = byKind.get(row.kind) ?? { writes: 0, wei: 0n, unmeasured: 0 };
    entry.writes++;
    if (row.gas_cost_wei === null) entry.unmeasured++; else entry.wei += BigInt(row.gas_cost_wei);
    byKind.set(row.kind, entry);
  }
  const feesMinor = fees.reduce((sum, row) => sum + BigInt(row.minor), 0n);
  const gasWei = [...byKind.values()].reduce((sum, entry) => sum + entry.wei, 0n);
  // USDT base units of gas at `usdtPerWbt`, rounded up, as the FeeSchedule converts it.
  const gasMinor = usdtPerWbt === undefined ? null : (gasWei * usdtPerWbt + 10n ** 18n - 1n) / 10n ** 18n;
  return {
    days, since,
    fees: { minor: feesMinor.toString(), byKind: Object.fromEntries(fees.map(row => [row.kind, { minor: BigInt(row.minor).toString(), entries: row.n }])) },
    gas: { wei: gasWei.toString(), byKind: Object.fromEntries([...byKind].map(([kind, entry]) => [kind, { writes: entry.writes, wei: entry.wei.toString(), unmeasured: entry.unmeasured }])) },
    usdtPerWbt: usdtPerWbt?.toString() ?? null,
    gasMinor: gasMinor?.toString() ?? null,
    marginMinor: gasMinor === null ? null : (feesMinor - gasMinor).toString(),
  };
}
