import type { Metadata } from 'next';
import type { FeeRateView } from '@pactagent/core/api-types';
import { FeeSetup } from '@/components/merchant/fees/fee-setup';
import { LiveSetupCard } from '@/components/merchant/live/live-setup';
import { NotConnected } from '@/components/states/not-connected';
import { PublicRecord } from '@/components/states/public-record';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader, SectionTitle } from '@/components/ui/page-header';
import { Stat, StatGrid } from '@/components/ui/stat';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { time, toMinor, usd, usdDecimal } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Fees' };

/** "0.80% per payment, at least $0.15" and, with a cap, "at most $10.00". */
function rateLine(rate: FeeRateView) {
  return [
    `${rate.percent} of each payment`,
    `at least ${usdDecimal(rate.minimumUsdt)}`,
    ...(rate.capUsdt ? [`at most ${usdDecimal(rate.capUsdt)}`] : []),
  ].join(', ');
}

/** Pact's fee on `amount` at `rate`, as the FeeSchedule computes it: rounded up, clamped. */
function feeOn(amount: bigint, rate: FeeRateView) {
  let fee = (amount * BigInt(rate.bps) + 9_999n) / 10_000n;
  const min = toMinor(rate.minimumUsdt);
  if (fee < min) fee = min;
  if (rate.capUsdt && fee > toMinor(rate.capUsdt)) fee = toMinor(rate.capUsdt);
  return fee;
}

export default async function FeesPage() {
  const data = await getData();
  const [fees, ledger, viewer] = await Promise.all([
    load(() => data.merchant.fees()),
    load(() => data.merchant.feeLedger(100)),
    getViewer(),
  ]);
  if (isNotWired(fees)) return <NotConnected feature={fees.feature} />;
  const readOnly = viewer?.role !== 'merchant';
  const terms = fees.terms.accepted ?? fees.terms.latest;
  const example = 100_000_000n;
  const exampleFee = feeOn(example, terms.checkout);
  const rows = isNotWired(ledger) ? ledger : ledger.slice(0, 50);
  return (
    <>
      <PageHeader
        title="Fees"
        description="Pact takes its fee out of each payment, at the rates you signed, and you receive the rest. Your customers never pay a fee or gas, and your wallet never needs WBT."
      />
      {!readOnly && (
        <div className="mb-6">
          <LiveSetupCard compact />
        </div>
      )}
      {fees.terms.needsAcceptance && (
        <Notice tone="warning" title="Sign the fee terms to take payments" className="mb-6">
          Until you sign, payments to you are refused before anything is sent.
        </Notice>
      )}
      {fees.terms.newerTermsAvailable && (
        <Notice tone="info" title="Pact published new fee terms" className="mb-6">
          Your payments keep the terms you signed (version {fees.terms.acceptedVersion}) until you sign
          version {fees.terms.latestVersion}.
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Your fee terms"
            description="Signed once in the FeeSchedule contract. Nobody else can change your rate."
            action={
              <Badge tone={fees.terms.needsAcceptance ? 'warning' : 'success'}>
                {fees.terms.needsAcceptance
                  ? 'Not signed'
                  : `Version ${fees.terms.acceptedVersion}`}
              </Badge>
            }
          />
          <CardBody className="grid gap-4">
            <div className="grid gap-1">
              <p className="text-sm text-muted-foreground">Checkout payments, captures and renewals</p>
              <p className="text-lg font-semibold">{rateLine(terms.checkout)}</p>
            </div>
            <div className="grid gap-1">
              <p className="text-sm text-muted-foreground">Invoices you send</p>
              <p className="text-lg font-semibold">{rateLine(terms.invoice)}</p>
            </div>
            <div className="grid gap-1">
              <p className="text-sm text-muted-foreground">Refunds you send</p>
              <p className="text-sm">
                No fee. The network fee of the refund is taken from your wallet in USDT, usually a fraction of
                a cent.
              </p>
            </div>
            <p className="rounded-xl bg-raised px-3 py-2 text-sm">
              On a {usd(example)} checkout payment, Pact takes {usd(exampleFee)} and you receive{' '}
              {usd(example - exampleFee)}.
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title={fees.ready ? 'Ready' : 'Set up fees'}
            description={
              fees.ready
                ? 'Your terms and refund permits are in place.'
                : 'Sign the fee terms, then two refund permits. Pact submits each one for you.'
            }
          />
          <CardBody>
            <FeeSetup fees={fees} readOnly={readOnly} />
          </CardBody>
        </Card>
      </div>

      <StatGrid className="mt-6">
        <Stat
          label={`Gross, last ${fees.totals.days} days`}
          value={usdDecimal(fees.totals.grossUsdt)}
          hint={`${fees.totals.payments} payment${fees.totals.payments === 1 ? '' : 's'}`}
        />
        <Stat label="Pact fees" value={usdDecimal(fees.totals.feesUsdt)} hint="Taken from each payment" />
        <Stat label="Net to you" value={usdDecimal(fees.totals.netUsdt)} hint="What reached your wallet" />
        <Stat
          label="Effective rate"
          value={
            fees.totals.effectiveRateBps === null ? '—' : `${(fees.totals.effectiveRateBps / 100).toFixed(2)}%`
          }
          hint="Fees as a share of gross"
        />
      </StatGrid>

      <SectionTitle>Fees taken</SectionTitle>
      <Card>
        {isNotWired(rows) ? (
          <CardBody>
            <NotConnected feature={rows.feature} />
          </CardBody>
        ) : rows.length === 0 ? (
          <EmptyState title="No fees yet">
            Each payment appears here with its gross, Pact’s fee and what reached you.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>What</Th>
                <Th align="right">Gross</Th>
                <Th align="right">Fee</Th>
                <Th align="right">Net</Th>
                <Th>Record</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map(entry => (
                <Tr key={entry.id}>
                  <Td className="text-muted-foreground">{time(entry.at)}</Td>
                  <Td>
                    <p className="font-medium">{entry.label}</p>
                    <p className="max-w-[260px] truncate text-[13px] text-muted-foreground">{entry.objectId}</p>
                  </Td>
                  <Td align="right">{entry.kind === 'Fee' ? '—' : usdDecimal(entry.grossUsdt)}</Td>
                  <Td align="right">{usdDecimal(entry.feeUsdt)}</Td>
                  <Td align="right">{usdDecimal(entry.netUsdt)}</Td>
                  <Td>
                    <PublicRecord hash={entry.txHash} />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
