import { getData } from '@/server/data';
import { DataError } from '@/server/data/errors';
import { isMock } from '@/server/mode';
import { getViewer } from '@/server/viewer';

export const dynamic = 'force-dynamic';

const columns = [
  'Date (UTC)',
  'Type',
  'Payment or Invoice ID',
  'Order ID',
  'Customer',
  'Gross USDT',
  'Discount USDT',
  'Discount Code',
  'Fee USDT',
  'Net USDT',
  'Refund Of',
  'Financing Status',
  'Transaction Hash',
  'Explorer Link',
  'Token Balance Change USDT',
];

/**
 * Guards spreadsheet formula injection; plain negative numbers stay numeric. Full-width
 * = + - @ count too, since some spreadsheet locales read them as their ASCII forms.
 */
function quote(value: string) {
  const start = value.trimStart();
  const guarded =
    /^[=+@\uFF1D\uFF0B\uFF0D\uFF20]/.test(start) ||
    /^[\t\r\n]/.test(value) ||
    (start.startsWith('-') && !/^-\d+(\.\d+)?$/.test(start));
  return `"${(guarded ? `'${value}` : value).replaceAll('"', '""')}"`;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const from = url.searchParams.get('from') ?? undefined;
  const to = url.searchParams.get('to') ?? undefined;
  const format = url.searchParams.get('format') ?? 'csv';
  if (
    (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) ||
    (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) ||
    (from && to && from > to)
  ) {
    return Response.json({ error: 'Use a valid date range in YYYY-MM-DD format.' }, { status: 400 });
  }
  if (format !== 'csv' && format !== 'json')
    return Response.json({ error: 'Supported formats: csv, json.' }, { status: 400 });
  const viewer = await getViewer();
  if (!viewer || (viewer.role !== 'merchant' && viewer.role !== 'accountant'))
    return Response.json({ error: 'login_required' }, { status: 401 });
  try {
    const report = await (await getData()).merchant.exportReport({ from, to });
    const totals: Record<string, string | null> = {
      Type: 'TOTAL',
      'Gross USDT': report.totals.grossUSDT,
      'Discount USDT': report.totals.discountsUSDT ?? null,
      'Fee USDT': report.totals.feesUSDT,
      'Net USDT': report.totals.netUSDT,
      'Token Balance Change USDT': report.totals.tokenDeltaUSDT,
    };
    const content =
      format === 'json'
        ? JSON.stringify(report, null, 2)
        : [
            columns,
            ...report.rows.map(row => columns.map(column => row[column] ?? '')),
            columns.map(column => totals[column] ?? ''),
          ]
            .map(row => row.map(quote).join(','))
            .join('\r\n') + '\r\n';
    const name = `pact-ledger${from ? `-${from}` : ''}${to ? `-to-${to}` : ''}${isMock ? '-mock' : ''}.${format}`;
    return new Response(content, {
      headers: {
        'cache-control': 'no-store',
        'content-type': format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${name}"`,
      },
    });
  } catch (error) {
    const status = error instanceof DataError ? error.status : 503;
    return Response.json(
      { error: error instanceof DataError ? error.code : 'service_unavailable' },
      { status },
    );
  }
}
