import type { Metadata } from 'next';
import { IconCircleCheckFilled } from '@tabler/icons-react';
import { NotConnected } from '@/components/states/not-connected';
import { PublicRecord } from '@/components/states/public-record';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Stat, StatGrid } from '@/components/ui/stat';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { toMinor, usdDecimal } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { ExportDialog } from './export-dialog';

export const metadata: Metadata = { title: 'Exports' };

const valid = (value?: string) => (value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined);
const typeTone = {
  Payment: 'success',
  Invoice: 'success',
  Subscription: 'success',
  'Agent payment': 'success',
  Refund: 'warning',
  Fee: 'neutral',
} as const;

export default async function ExportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const params = await searchParams;
  const data = await getData();
  const demo = await data.demo?.state();
  const today = (demo?.now ?? new Date().toISOString()).slice(0, 10);
  const monthAgo = new Date(new Date(`${today}T00:00:00Z`).getTime() - 29 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const from = valid(params.from) ?? monthAgo;
  const to = valid(params.to) ?? today;
  const report = await load(() => data.merchant.exportReport({ from, to }));
  if (isNotWired(report)) return <NotConnected feature={report.feature} />;
  const query = new URLSearchParams({ from, to });
  const net = toMinor(report.totals.netUSDT);
  const delta = report.totals.tokenDeltaUSDT ? toMinor(report.totals.tokenDeltaUSDT) : null;
  const rows = [...report.rows].reverse();
  return (
    <>
      <PageHeader
        title="Exports"
        description="Every payment, refund and fee in one ledger: gross, Pact’s fee and net, with a link to its public record. Columns match QuickBooks and Xero CSV import."
        actions={
          <>
            <Button asChild size="sm">
              <a href={`/api/export?${query}&format=json`}>JSON</a>
            </Button>
            <ExportDialog today={today} from={from} to={to} />
          </>
        }
      />
      <Card className="mb-6">
        <CardBody>
          <form className="flex flex-wrap items-end gap-3">
            <label className="grid gap-1.5 text-sm font-medium">
              From (UTC)
              <input
                type="date"
                name="from"
                defaultValue={from}
                className="h-11 rounded-[14px] border border-input bg-card px-3.5 text-base"
              />
            </label>
            <label className="grid gap-1.5 text-sm font-medium">
              To (UTC)
              <input
                type="date"
                name="to"
                defaultValue={to}
                className="h-11 rounded-[14px] border border-input bg-card px-3.5 text-base"
              />
            </label>
            <Button type="submit" variant="dark">
              Update
            </Button>
          </form>
        </CardBody>
      </Card>
      <StatGrid>
        <Stat label="Gross" value={usdDecimal(report.totals.grossUSDT)} hint="After refunds" />
        <Stat label="Pact fees" value={usdDecimal(report.totals.feesUSDT)} hint="Taken from each payment" />
        <Stat label="Net USDT" value={usdDecimal(report.totals.netUSDT)} hint="What reached your wallet" />
        <Stat
          label="Gas you paid"
          value="None"
          hint="Pact pays it; a refund’s network fee is in Pact fees, in USDT"
        />
      </StatGrid>
      <div className="mt-6">
        {delta !== null && delta === net ? (
          <Notice tone="success" title="Reconciles with the chain">
            Net USDT in this export ({usdDecimal(report.totals.netUSDT)}) equals the payout account’s onchain
            balance change for the period ({usdDecimal(report.totals.tokenDeltaUSDT!)}).{' '}
            {report.accountingBasis}
          </Notice>
        ) : (
          <Notice tone="warning" title="Does not reconcile yet">
            The onchain balance change{' '}
            {delta === null ? 'is unavailable' : `is ${usdDecimal(report.totals.tokenDeltaUSDT!)}`}.{' '}
            {report.accountingBasis}
          </Notice>
        )}
      </div>
      <Card className="mt-6">
        <CardHeader
          title="Ledger"
          description={`${report.rows.length} rows, ${from} to ${to}, newest first`}
        />
        {rows.length === 0 ? (
          <EmptyState title="No activity in this range">
            Confirmed payments, refunds and fees appear here for reconciliation. Try a wider range.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Date (UTC)</Th>
                <Th>Type</Th>
                <Th>Customer</Th>
                <Th align="right">Gross</Th>
                <Th align="right">Fee</Th>
                <Th align="right">Net</Th>
                <Th>Record</Th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 150).map((row, index) => (
                <Tr key={`${row['Transaction Hash']}-${index}`}>
                  <Td className="whitespace-nowrap text-muted-foreground">{row['Date (UTC)']}</Td>
                  <Td>
                    <Badge tone={typeTone[row.Type as keyof typeof typeTone] ?? 'neutral'}>{row.Type}</Badge>
                    {row['Refund Of'] && (
                      <p className="mt-0.5 font-mono text-[12px] text-muted-foreground">
                        of {row['Refund Of'].slice(0, 10)}…
                      </p>
                    )}
                  </Td>
                  <Td className="max-w-[220px] truncate">{row.Customer}</Td>
                  <Td align="right">{usdDecimal(row['Gross USDT'])}</Td>
                  <Td align="right" className="text-muted-foreground">
                    {usdDecimal(row['Fee USDT'])}
                  </Td>
                  <Td align="right" className="font-medium">
                    {usdDecimal(row['Net USDT'])}
                  </Td>
                  <Td>
                    <PublicRecord hash={row['Transaction Hash'] || null} />
                  </Td>
                </Tr>
              ))}
              <Tr className="bg-raised font-semibold hover:bg-raised">
                <Td>Total</Td>
                <Td />
                <Td />
                <Td align="right">{usdDecimal(report.totals.grossUSDT)}</Td>
                <Td align="right">{usdDecimal(report.totals.feesUSDT)}</Td>
                <Td align="right">{usdDecimal(report.totals.netUSDT)}</Td>
                <Td>
                  <IconCircleCheckFilled className="size-4 text-success" />
                </Td>
              </Tr>
            </tbody>
          </Table>
        )}
        {rows.length > 150 && (
          <p className="px-5 py-3 text-[13px] text-muted-foreground">
            Showing the newest 150 rows. The download contains all {rows.length}.
          </p>
        )}
      </Card>
    </>
  );
}
