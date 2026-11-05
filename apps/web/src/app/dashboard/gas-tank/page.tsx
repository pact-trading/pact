import type { Metadata } from 'next';
import { LiveSetupCard } from '@/components/merchant/live/live-setup';
import { IconBuildingBank, IconRefresh } from '@tabler/icons-react';
import { DepositGasButton, FaucetButton, GasPolicyForm } from '@/components/merchant/gas/gas-controls';
import { NotConnected } from '@/components/states/not-connected';
import { PublicRecord } from '@/components/states/public-record';
import { Badge } from '@/components/ui/badge';
import { BarChart } from '@/components/ui/bar-chart';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Gauge } from '@/components/ui/gauge';
import { PageHeader, SectionTitle } from '@/components/ui/page-header';
import { Stat, StatGrid } from '@/components/ui/stat';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { date, humanize, time, usd, wbt } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Gas tank' };

export default async function GasTankPage() {
  const data = await getData();
  const [tank, ledger, viewer] = await Promise.all([
    load(() => data.merchant.gasTank()),
    load(() => data.merchant.gasLedger(200)),
    getViewer(),
  ]);
  if (isNotWired(tank)) return <NotConnected feature={tank.feature} />;
  const readOnly = viewer?.role !== 'merchant';
  const balance = BigInt(tank.balanceWei);
  const spent = BigInt(tank.spentTodayWei);
  const cap = BigInt(tank.dailyCapWei);
  const runway = tank.runwayDays ?? 0;
  const usdOf = (wei: bigint) => usd((wei * BigInt(tank.wbtUsdMinor)) / 10n ** 18n);
  // Unknown runway (no spend yet) is not low.
  const low = tank.runwayDays !== null && runway < tank.policy.lowRunwayAlertDays;
  // What one sponsored payment costs, averaged over the recent ledger.
  const payments = isNotWired(ledger) ? [] : ledger.filter(e => e.action === 'payment');
  const perPayment = payments.length
    ? payments.reduce((t, e) => t + BigInt(e.gasWei), 0n) / BigInt(payments.length)
    : null;
  const feePerPayment = payments.length
    ? payments.reduce((t, e) => t + BigInt(e.feeMinor), 0n) / BigInt(payments.length)
    : null;
  const recent = isNotWired(ledger) ? ledger : ledger.slice(0, 25);
  return (
    <>
      <PageHeader
        title="Gas tank"
        description="Your customers and their agents never hold WBT. Your tank pays the network fee for every sponsored action, and only for your own traffic."
        actions={
          !readOnly && (
            <DepositGasButton
              balanceWei={tank.balanceWei}
              perPaymentWei={perPayment === null ? null : perPayment.toString()}
            />
          )
        }
      />
      {!readOnly && (
        <div className="mt-6">
          <LiveSetupCard compact />
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Card>
          <CardBody className="flex flex-wrap items-center gap-6">
            <Gauge
              size={150}
              value={runway}
              max={30}
              label={tank.runwayDays === null ? '—' : String(Math.floor(runway))}
              sublabel="days of runway"
              tone={low ? 'danger' : runway < 14 ? 'warning' : 'success'}
            />
            <div className="grid gap-1">
              <p className="text-sm text-muted-foreground">Balance</p>
              <p className="text-2xl font-semibold">{wbt(balance)}</p>
              <p className="text-sm text-muted-foreground">
                ≈ {usdOf(balance)} at the illustrative price of {usd(tank.wbtUsdMinor)} per WBT
              </p>
              <Badge tone={low ? 'danger' : 'success'} className="mt-2 justify-self-start">
                {low ? 'Top up soon' : 'Healthy'}
              </Badge>
            </div>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Daily sponsored spend" description="Last 14 days, UTC" />
          <CardBody>
            <BarChart
              height={130}
              points={tank.history.map(h => ({
                label: date(`${h.date}T00:00:00Z`).replace(/, \d{4}$/, ''),
                value: Number(BigInt(h.spentWei) / 10n ** 12n) / 1e6,
                title: `${h.date}: ${wbt(h.spentWei, 5)}, ${h.actions} actions`,
              }))}
            />
          </CardBody>
        </Card>
      </div>
      <StatGrid className="mt-6">
        <Stat label="Spent today" value={wbt(spent, 5)} hint={`${usdOf(spent)} · cap ${wbt(cap, 3)}`} />
        <Stat
          label="Daily cap used"
          value={`${cap === 0n ? 0 : Number((spent * 1000n) / cap) / 10}%`}
          hint="Enforced in the GasTank contract"
        />
        <Stat
          label="Per payer, per day"
          value={`${tank.policy.perPayerDailyActions} actions`}
          hint="Router contract counter"
        />
        <Stat
          label="Refused requests"
          value={tank.refusals.reduce((t, r) => t + r.count, 0)}
          hint="Spent nothing from your tank"
        />
      </StatGrid>
      <StatGrid className="mt-3">
        <Stat
          label="Gas per payment"
          value={perPayment === null ? '—' : wbt(perPayment, 6)}
          hint={
            perPayment === null
              ? 'No sponsored payments yet'
              : `≈ ${usdOf(perPayment)}, average of the last ${payments.length}`
          }
        />
        <Stat
          label="Fee per payment"
          value={feePerPayment === null ? '—' : usd(feePerPayment)}
          hint="Pact fee taken in the same transaction"
        />
        <Stat
          label="Runway in payments"
          value={perPayment ? (balance / perPayment).toLocaleString('en-US') : '—'}
          hint="Sponsored payments the balance covers"
        />
        <Stat
          label="Gas as share of fee"
          value={
            perPayment && feePerPayment
              ? `${(Number((((perPayment * BigInt(tank.wbtUsdMinor)) / 10n ** 18n) * 10_000n) / feePerPayment) / 100).toFixed(1)}%`
              : '—'
          }
          hint="Below 100% means each payment pays for itself"
        />
      </StatGrid>

      <SectionTitle>Who pays for gas</SectionTitle>
      <Card>
        <CardBody>
          <GasPolicyForm policy={tank.policy} readOnly={readOnly} />
        </CardBody>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Top up on testnet" description={tank.faucet.source} />
          <CardBody className="grid gap-3">
            <p className="text-sm text-subtle-foreground">
              A plain transfer costs about 0.000105 WBT at the fee floor, so one 0.5 WBT claim covers well
              over a thousand sponsored actions.
            </p>
            {!readOnly && <FaucetButton nextClaimAt={tank.faucet.nextClaimAt} />}
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="On mainnet: refills itself"
            description="Designed, shown here, not built for the testnet demo"
            action={<Badge tone="outline">Planned</Badge>}
          />
          <CardBody className="grid gap-3 text-sm text-subtle-foreground">
            <p className="flex gap-2">
              <IconRefresh className="mt-0.5 size-4 shrink-0" />
              When runway falls under {tank.policy.lowRunwayAlertDays} days, swap a share of USDT fee revenue
              to WBT on Whitechain’s native DEX.
            </p>
            <p className="flex gap-2">
              <IconBuildingBank className="mt-0.5 size-4 shrink-0" />
              Payment volume becomes WBT demand, and no one has to buy gas by hand.
            </p>
          </CardBody>
        </Card>
      </div>

      <SectionTitle>Gas per sponsored action</SectionTitle>
      <Card>
        {isNotWired(recent) ? (
          <CardBody>
            <NotConnected feature={recent.feature} />
          </CardBody>
        ) : recent.length === 0 ? (
          <EmptyState title="No sponsored actions yet">
            Gas appears here once a customer pays, subscribes or is refunded.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Action</Th>
                <Th align="right">Gas</Th>
                <Th align="right">≈ USD</Th>
                <Th align="right">Fee collected</Th>
                <Th>Record</Th>
              </tr>
            </thead>
            <tbody>
              {recent.map(entry => (
                <Tr key={entry.id}>
                  <Td className="text-muted-foreground">{time(entry.createdAt)}</Td>
                  <Td>
                    <p className="font-medium">{humanize(entry.action)}</p>
                    <p className="max-w-[260px] truncate text-[13px] text-muted-foreground">{entry.label}</p>
                  </Td>
                  <Td align="right">{wbt(entry.gasWei, 6)}</Td>
                  <Td align="right">{usd(entry.gasUsdMinor)}</Td>
                  <Td align="right">{entry.feeMinor === '0' ? '—' : usd(entry.feeMinor)}</Td>
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
