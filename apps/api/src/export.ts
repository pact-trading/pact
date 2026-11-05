import { amountString, type Db } from './db.js';
import { Refusal } from './types.js';

export const exportColumns = ['Date (UTC)', 'Type', 'Payment or Invoice ID', 'Order ID', 'Customer', 'Gross USDT', 'Discount USDT', 'Discount Code', 'Fee USDT', 'Net USDT', 'Gas Cost WBT', 'Gas Cost USD Estimate', 'Refund Of', 'Financing Status', 'Transaction Hash', 'Explorer Link', 'Token Balance Change USDT'];
const csvCell = (value: unknown) => {
  let text = String(value ?? '');
  // Spreadsheet applications evaluate formula-leading text even inside CSV quotes.
  if (/^[=+@]/.test(text.trimStart()) || /^[\t\r\n]/.test(text) || (/^-/.test(text.trimStart()) && !/^-\d+(\.\d+)?$/.test(text.trimStart()))) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
const weiString = (wei: bigint) => `${wei / 10n ** 18n}.${(wei % 10n ** 18n).toString().padStart(18, '0')}`;

function dateBoundary(value: string | undefined, end: boolean) {
  if (value === undefined) return end ? '9999-12-31T23:59:59.999Z' : '0000-01-01T00:00:00.000Z';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Refusal('invalid_date', 'Use UTC dates in YYYY-MM-DD format');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Refusal('invalid_date');
  return `${value}T${end ? '23:59:59.999' : '00:00:00.000'}Z`;
}

export function accountantExport(db: Db, merchantId: string, query: { from?: string; to?: string; format?: string }, wbtUsdEstimate?: string) {
  const from = dateBoundary(query.from, false), to = dateBoundary(query.to, true);
  if (from > to) throw new Refusal('invalid_date_range');
  if (query.format && !['csv', 'json'].includes(query.format)) throw new Refusal('invalid_format');
  // Upgraded DBs must backfill confirmed events before returning incomplete financial totals.
  const coverage = db.prepare('SELECT coverage_complete FROM accounting_state WHERE id=1').get() as { coverage_complete: number };
  const cumulative = new Map<string, { captured: bigint; refunded: bigint }>();
  for (const row of db.prepare("SELECT object_id,kind,amount_minor FROM accounting_entries WHERE merchant_id=? AND kind IN ('Payment','Refund')").all(merchantId) as Array<{ object_id: string; kind: string; amount_minor: string }>) {
    const value = cumulative.get(row.object_id) ?? { captured: 0n, refunded: 0n };
    if (row.kind === 'Payment') value.captured += BigInt(row.amount_minor); else value.refunded -= BigInt(row.amount_minor);
    cumulative.set(row.object_id, value);
  }
  const missing = (db.prepare('SELECT id,captured_minor,refunded_minor FROM payments WHERE merchant_id=?').all(merchantId) as Array<{ id: string; captured_minor: string; refunded_minor: string }>).some(payment => {
    const actual = cumulative.get(payment.id) ?? { captured: 0n, refunded: 0n };
    return actual.captured !== BigInt(payment.captured_minor) || actual.refunded !== BigInt(payment.refunded_minor);
  });
  const missingFee = db.prepare(`SELECT g.id FROM gas_ledger g WHERE g.merchant_id=? AND NOT EXISTS(SELECT 1 FROM accounting_entries a WHERE a.merchant_id=g.merchant_id AND lower(a.tx_hash)=lower(g.tx_hash) AND a.kind='Fee') LIMIT 1`).get(merchantId);
  if (!coverage.coverage_complete || missing || missingFee) throw new Refusal('accounting_backfill_required', 'Reindex confirmed accounting events before exporting this database');
  const entries = db.prepare('SELECT * FROM accounting_entries WHERE merchant_id=? AND occurred_at>=? AND occurred_at<=? ORDER BY occurred_at,event_id').all(merchantId, from, to) as Array<Record<string, string | null>>;
  const rows: Array<Record<string, string>> = [];
  let gross = 0n, discounts = 0n, fees = 0n, gas = 0n, delta = 0n, deltaKnown = true;
  for (const entry of entries) {
    const amount = BigInt(entry.amount_minor!), fee = BigInt(entry.fee_minor!), cost = BigInt(entry.gas_wei!);
    const order = db.prepare('SELECT id,discount_code,amount_gross_minor FROM commerce_orders WHERE payment_id=? AND merchant_id=?').get(entry.object_id, merchantId) as { id: string; discount_code: string | null; amount_gross_minor: string | null } | undefined;
    const linkPayment = db.prepare('SELECT metadata FROM payments WHERE id=? AND merchant_id=?').get(entry.object_id, merchantId) as { metadata: string | null } | undefined;
    const parsedMeta = linkPayment?.metadata ? JSON.parse(linkPayment.metadata) as { linkId?: string; discountCode?: string; amountGrossMinor?: string } : null;
    const linkMeta = parsedMeta?.linkId ? parsedMeta : null;
    const subscription = db.prepare('SELECT s.discount_code,p.amount_minor FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE lower(s.chain_id)=lower(?) AND s.merchant_id=?').get(entry.object_id, merchantId) as { discount_code: string | null; amount_minor: string } | undefined;
    const original = order?.amount_gross_minor ?? linkMeta?.amountGrossMinor ?? subscription?.amount_minor ?? null;
    const code = order?.discount_code ?? linkMeta?.discountCode ?? subscription?.discount_code ?? '';
    const discount = original && ['Payment', 'Subscription'].includes(entry.kind!) ? BigInt(original) - amount : 0n;
    gross += amount + (discount > 0n ? discount : 0n); discounts += discount > 0n ? discount : 0n; fees += fee; gas += cost;
    if (entry.token_delta_minor === null) deltaKnown = false; else delta += BigInt(entry.token_delta_minor);
    const estimate = wbtUsdEstimate && Number(wbtUsdEstimate) > 0 && Number.isFinite(Number(wbtUsdEstimate)) ? (Number(weiString(cost)) * Number(wbtUsdEstimate)).toFixed(6) : '';
    rows.push({ 'Date (UTC)': entry.occurred_at!, Type: entry.kind!, 'Payment or Invoice ID': entry.object_id!, 'Order ID': order?.id ?? '', Customer: entry.customer!,
      'Gross USDT': original && discount > 0n ? amountString(original) : amountString(amount), 'Discount USDT': amountString(discount > 0n ? discount : 0n), 'Discount Code': code, 'Fee USDT': amountString(fee), 'Net USDT': amountString(amount - fee),
      'Gas Cost WBT': weiString(cost), 'Gas Cost USD Estimate': estimate, 'Refund Of': entry.refund_of!, 'Financing Status': '',
      'Transaction Hash': entry.tx_hash!, 'Explorer Link': `https://explorer.testnet.whitechain.io/tx/${entry.tx_hash}`,
      'Token Balance Change USDT': entry.token_delta_minor === null ? '' : amountString(entry.token_delta_minor),
    });
  }
  const invoices = db.prepare('SELECT * FROM invoices WHERE merchant_id=? AND created_at>=? AND created_at<=?').all(merchantId, from, to) as Array<Record<string, string>>;
  for (const invoice of invoices) rows.push({ 'Date (UTC)': invoice.created_at, Type: 'Invoice', 'Payment or Invoice ID': invoice.id, Customer: invoice.customer_email,
    'Gross USDT': amountString(invoice.amount_minor), 'Fee USDT': '0.000000', 'Net USDT': '0.000000', 'Gas Cost WBT': '', 'Gas Cost USD Estimate': '',
    'Refund Of': '', 'Financing Status': invoice.financing_status ?? '', 'Transaction Hash': '', 'Explorer Link': '', 'Token Balance Change USDT': '0.000000' });
  rows.sort((a, b) => a['Date (UTC)'].localeCompare(b['Date (UTC)']));
  const totals = { grossUSDT: amountString(gross), discountsUSDT: amountString(discounts), feesUSDT: amountString(fees), netUSDT: amountString(gross - discounts - fees), gasWBT: weiString(gas), tokenDeltaUSDT: deltaKnown ? amountString(delta) : null };
  const totalRow = { Type: 'TOTAL', 'Gross USDT': totals.grossUSDT, 'Discount USDT': amountString(discounts), 'Fee USDT': totals.feesUSDT, 'Net USDT': totals.netUSDT, 'Gas Cost WBT': totals.gasWBT, 'Token Balance Change USDT': totals.tokenDeltaUSDT ?? '' } as Record<string, string>;
  return { rows, totals, csv: [exportColumns.map(csvCell).join(','), ...rows.map(row => exportColumns.map(column => csvCell(row[column])).join(',')), exportColumns.map(column => csvCell(totalRow[column])).join(',')].join('\n'),
    accountingBasis: 'Confirmed block timestamps. Net subtracts quoted fees; tokenDelta excludes self-transfers. Only indexed suite operations are included; external wallet transfers are outside this ledger.' };
}
