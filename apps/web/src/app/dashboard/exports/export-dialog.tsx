'use client';

import { IconDownload, IconFileSpreadsheet } from '@tabler/icons-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { ExportReport } from '@pactagent/core/api-types';
import { RadioCards } from '@/components/portal/radio-cards';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { usdDecimal } from '@/lib/format';

type Period = 'this_month' | 'last_month' | 'last_30' | 'last_7' | 'custom';
const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The date range a preset covers, in UTC days, ending on the demo clock's today. */
export function periodRange(period: Exclude<Period, 'custom'>, today: string) {
  const end = new Date(`${today}T00:00:00Z`);
  const t = end.getTime();
  const y = end.getUTCFullYear();
  const m = end.getUTCMonth();
  switch (period) {
    case 'this_month':
      return { from: day(Date.UTC(y, m, 1)), to: today };
    case 'last_month':
      return { from: day(Date.UTC(y, m - 1, 1)), to: day(Date.UTC(y, m, 0)) };
    case 'last_7':
      return { from: day(t - 6 * DAY), to: today };
    case 'last_30':
      return { from: day(t - 29 * DAY), to: today };
  }
}

type Preview =
  | { state: 'loading' }
  | { state: 'error'; message: string; query: string }
  | { state: 'ready'; report: ExportReport; query: string };

/**
 * Pick a period, see what the file will hold, then download it. The counts and the file both
 * come from /api/export for that range, so what the dialog shows is what the CSV contains.
 */
export function ExportDialog({ today, from, to }: { today: string; from: string; to: string }) {
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState<Period>('last_30');
  const [custom, setCustom] = useState({ from, to });
  const [result, setPreview] = useState<Preview>({ state: 'loading' });

  const range = period === 'custom' ? custom : periodRange(period, today);
  const rangeError =
    !DATE.test(range.from) || !DATE.test(range.to)
      ? 'Choose a start and an end date.'
      : range.from > range.to
        ? 'The start date must be on or before the end date.'
        : '';
  const query = new URLSearchParams({ from: range.from, to: range.to }).toString();
  // A result for another period is never shown, so counts always match the link below.
  const preview: Preview =
    result.state !== 'loading' && result.query === query ? result : { state: 'loading' };

  useEffect(() => {
    if (!open || rangeError) return;
    const controller = new AbortController();
    fetch(`/api/export?${query}&format=json`, { signal: controller.signal, cache: 'no-store' })
      .then(async response => {
        if (!response.ok) throw new Error('The export could not be prepared. Try again.');
        setPreview({ state: 'ready', report: (await response.json()) as ExportReport, query });
      })
      .catch(error => {
        if (!controller.signal.aborted)
          setPreview({
            state: 'error',
            message: error instanceof Error ? error.message : 'Export failed.',
            query,
          });
      });
    return () => controller.abort();
  }, [open, query, rangeError]);

  const ready = !rangeError && preview.state === 'ready';
  return (
    <>
      <Button
        variant="primary"
        size="sm"
        onClick={() => {
          setPreview({ state: 'loading' });
          setOpen(true);
        }}
      >
        <IconDownload className="size-4" />
        Export CSV
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Export CSV"
        description="A ledger of payments, refunds, fees and gas, ready for QuickBooks or Xero."
        className="sm:max-w-xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
            {ready ? (
              <Button asChild variant="dark">
                <a href={`/api/export?${query}&format=csv`} download>
                  <IconDownload className="size-4.5" />
                  Download CSV
                </a>
              </Button>
            ) : (
              <Button variant="dark" disabled>
                <IconDownload className="size-4.5" />
                Download CSV
              </Button>
            )}
          </>
        }
      >
        <div className="grid gap-4">
          <RadioCards
            legend="Period"
            value={period}
            onChange={setPeriod}
            options={[
              { value: 'last_30', title: 'Last 30 days' },
              { value: 'last_7', title: 'Last 7 days' },
              { value: 'this_month', title: 'This month' },
              { value: 'last_month', title: 'Last month' },
              { value: 'custom', title: 'Custom range' },
            ]}
          />
          {period === 'custom' && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="From (UTC)" error={rangeError || undefined}>
                {id => (
                  <Input
                    id={id}
                    type="date"
                    value={custom.from}
                    max={today}
                    aria-invalid={Boolean(rangeError)}
                    onChange={e => setCustom(c => ({ ...c, from: e.target.value }))}
                  />
                )}
              </Field>
              <Field label="To (UTC)">
                {id => (
                  <Input
                    id={id}
                    type="date"
                    value={custom.to}
                    max={today}
                    aria-invalid={Boolean(rangeError)}
                    onChange={e => setCustom(c => ({ ...c, to: e.target.value }))}
                  />
                )}
              </Field>
            </div>
          )}
          {!rangeError && (
            <div className="rounded-2xl border border-border" aria-live="polite">
              <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3 text-sm">
                <IconFileSpreadsheet className="size-4 text-muted-foreground" />
                <span className="font-medium">
                  {range.from} to {range.to}
                </span>
              </div>
              {preview.state === 'loading' && (
                <p className="px-4 py-3 text-sm text-muted-foreground">Counting rows…</p>
              )}
              {preview.state === 'error' && (
                <Notice tone="danger" className="m-3">
                  {preview.message}
                </Notice>
              )}
              {preview.state === 'ready' && (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2 px-4 py-3 text-sm sm:grid-cols-4">
                  <div>
                    <dt className="text-muted-foreground">Rows</dt>
                    <dd className="font-semibold" data-testid="export-rows">
                      {preview.report.rows.length}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Gross</dt>
                    <dd className="font-semibold">{usdDecimal(preview.report.totals.grossUSDT)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Fees</dt>
                    <dd className="font-semibold">{usdDecimal(preview.report.totals.feesUSDT)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Net</dt>
                    <dd className="font-semibold">{usdDecimal(preview.report.totals.netUSDT)}</dd>
                  </div>
                </dl>
              )}
            </div>
          )}
          <p className="text-[13px] text-muted-foreground">
            Every cell is quoted, and text that a spreadsheet could read as a formula is escaped.{' '}
            {!rangeError && (
              <Link
                href={`/dashboard/exports?${query}`}
                className="font-medium text-foreground underline-offset-4 hover:underline"
                onClick={() => setOpen(false)}
              >
                Show this period on the page
              </Link>
            )}
          </p>
        </div>
      </Dialog>
    </>
  );
}
