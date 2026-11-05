/**
 * Cards on the landing, built from the Pact app's own components
 * (apps/web/src/components/ui) with the same layouts the dashboard pages use.
 * Only the numbers are sample data.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {

  IconCircleCheckFilled,
  IconDownload,
  IconFileInvoice,
  IconFilePlus,
  IconFingerprint,
  IconGasStation,
  IconLink,
  IconMail,
  IconPlayerPause,
  IconPlayerPlay,
  IconReceiptRefund,
  IconShieldCheck,
  IconWallet,
} from '@tabler/icons-react';
import { PactLogo } from '@web/components/brand/pact-logo';
import { Badge, StatusBadge } from '@web/components/ui/badge';
import { BarChart } from '@web/components/ui/bar-chart';
import { Button } from '@web/components/ui/button';
import { Card, CardBody, CardHeader, DetailList } from '@web/components/ui/card';
import { Gauge } from '@web/components/ui/gauge';
import { Notice } from '@web/components/ui/notice';
import { PageHeader } from '@web/components/ui/page-header';
import { Stat, StatGrid } from '@web/components/ui/stat';
import { Table, Td, Th, Tr } from '@web/components/ui/table';
import { Timeline } from '@web/components/ui/timeline';
import { cn } from '@web/lib/cn';

const volume = [
  420, 610, 380, 720, 540, 880, 460, 690, 1020, 760, 590, 940, 1210, 830, 670, 1090, 980, 1340,
].map((value, i) => ({ value, label: `Oct ${i + 12}`, title: `Oct ${i + 12}: $${value}` }));

/** Wraps app components so the landing's type rules step aside (see app-ui.css). */
/** Which app theme the cards inside use. Pages can switch a whole block to dark. */
export const AppTheme = createContext<'light' | 'dark'>('light');

export function AppUi({ className, children }: { className?: string; children: ReactNode }) {
  const theme = useContext(AppTheme);
  return <div className={cn('app-ui', theme === 'dark' ? 'theme-dark' : 'theme-light', '[&_:is(h1,h2,h3,h4,li,summary)]:text-[inherit] [&_p:not([class*=foreground]):not([class*=success]):not([class*=warning]):not([class*=destructive]):not([class*=primary])]:text-[inherit]', className)}>{children}</div>;
}

function AppBar({ active }: { active: string }) {
  const tabs = ['Overview', 'Orders', 'Subscriptions', 'Gas tank'];
  return (
    <div className="flex items-center gap-5 border-b border-border px-5 py-3">
      <span className="text-foreground">
        <PactLogo width={78} />
      </span>
      <nav className="flex gap-1">
        {tabs.map(tab => (
          <span
            key={tab}
            className={cn(
              'inline-flex h-8 items-center rounded-full px-3 text-[13px] font-medium',
              tab === active ? 'bg-foreground text-background' : 'text-subtle-foreground',
            )}
          >
            {tab}
          </span>
        ))}
      </nav>
    </div>
  );
}
function RecentPayments({ rows = 4 }: { rows?: number }) {
  const data = [
    ['Pro plan', 'maya@studio.dev', '$49.00', 'paid'],
    ['Team plan renewal', 'li@northwind.io', '$12.00', 'charged'],
    ['Invoice INV-0042', 'ops@harbor.co', '$1,250.00', 'pending'],
    ['Pro plan', 'sam@lumen.app', '−$20.00', 'partially_refunded'],
    ['Risk score API', 'research-agent', '$0.01', 'paid'],
  ].slice(0, rows);
  return (
    <Table className="min-w-0">
      <thead>
        <tr>
          <Th>Payment</Th>
          <Th>Customer</Th>
          <Th align="right">Amount</Th>
          <Th>Status</Th>
        </tr>
      </thead>
      <tbody>
        {data.map(([what, who, amount, status]) => (
          <Tr key={what + who}>
            <Td className="font-medium">{what}</Td>
            <Td className="text-muted-foreground">{who}</Td>
            <Td align="right">{amount}</Td>
            <Td>
              <StatusBadge status={status} />
            </Td>
          </Tr>
        ))}
      </tbody>
    </Table>
  );
}

/** Hero: the merchant overview, as the dashboard home page lays it out. */
export function OverviewWindow() {
  return (
    <AppUi className="h-full overflow-hidden rounded-2xl border border-border bg-background shadow-pop">
      <AppBar active="Overview" />
      <div className="p-6">
        <PageHeader
          className="mb-5"
          title="Good to see you, Maya"
          description="Northwind Studio on Whitechain Sepolia. Updated just now."
          actions={
            <>
              <Button size="sm">
                <IconDownload className="size-4" />
                Export
              </Button>
              <Button size="sm">
                <IconLink className="size-4" />
                Share a payment link
              </Button>
              <Button variant="primary" size="sm">
                <IconFilePlus className="size-4" />
                New invoice
              </Button>
            </>
          }
        />
        <StatGrid className="lg:grid-cols-4">
          <Stat label="Available balance" icon={<IconWallet />} value="$29,123.89" hint="USDT in your payout account" />
          <Stat label="Today's volume" value="$1,340.00" hint="31 payments · 3 renewals" />
          <Stat label="Refunded today" value="$20.00" hint="1 refund" />
          <Stat label="Unpaid invoices" icon={<IconFileInvoice />} value="$1,250.00" hint="1 open" />
        </StatGrid>
        <div className="mt-5 grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-5">
          <Card>
            <CardHeader title="Payment volume" description="Captured USDT, last 18 days" />
            <CardBody>
              <BarChart points={volume} height={120} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Gas tank" description="You pay the gas" />
            <CardBody className="flex items-center gap-4">
              <Gauge value={20} max={30} label="20" sublabel="days left" size={112} />
              <div className="text-sm text-muted-foreground">
                <div className="font-medium text-foreground">0.0286 WBT</div>
                Daily cap 0.01 WBT
              </div>
            </CardBody>
          </Card>
        </div>
        <Card className="mt-5">
          <CardHeader title="Recent payments" />
          <RecentPayments rows={3} />
        </Card>
      </div>
    </AppUi>
  );
}

type CapPhase = {
  status: string;
  spent: number;
  notice: { tone: 'info' | 'success' | 'warning' | 'danger' | 'shield'; title: string; body: string };
};
const capPhases: CapPhase[] = [
  { status: 'active', spent: 0, notice: { tone: 'shield', title: 'Waiting for the next renewal', body: 'Every charge follows the signed cap.' } },
  { status: 'pending', spent: 0, notice: { tone: 'info', title: 'Renew Team plan for 12 USDT', body: 'Within the signed cap. Checking.' } },
  { status: 'charged', spent: 12, notice: { tone: 'success', title: '12 USDT renewal paid', body: '3 USDT left under this month’s cap.' } },
  { status: 'refused', spent: 12, notice: { tone: 'danger', title: '40 USDT charge refused', body: 'Above the 15 USDT cap. Nothing moved.' } },
];

function useCycle(length: number, ms: number, running: boolean) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!running || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => setStep(s => (s + 1) % length), ms);
    return () => clearInterval(id);
  }, [length, ms, running]);
  return step;
}

/** Hero: a subscription with its signed cap, as the customer portal shows it. */
export function SignedCapCard() {
  const [paused, setPaused] = useState(false);
  const step = useCycle(capPhases.length, 3200, !paused);
  const phase = paused
    ? { status: 'paused', spent: capPhases[step].spent, notice: { tone: 'warning' as const, title: 'Renewals are paused', body: 'No new charges can be made.' } }
    : capPhases[step];
  return (
    <AppUi>
      <Card className="shadow-pop">
        <CardHeader
          title="Team plan"
          description="Northwind Studio · every 30 days"
          action={<StatusBadge status={phase.status} />}
        />
        <CardBody className="grid gap-4">
          <div className="flex items-center gap-4">
            <Gauge value={phase.spent} max={15} label={`${phase.spent}`} sublabel="of 15 USDT" size={104} />
            <DetailList
              className="flex-1"
              items={[
                { label: 'Signed cap', value: '15 USDT' },
                { label: 'Price', value: '12 USDT' },
                { label: 'Gas', value: 'Paid by merchant' },
              ]}
            />
          </div>
          <Notice tone={phase.notice.tone} title={phase.notice.title}>
            {phase.notice.body}
          </Notice>
          <Button size="sm" className="w-full" onClick={() => setPaused(p => !p)}>
            {paused ? <IconPlayerPlay className="size-4" /> : <IconPlayerPause className="size-4" />}
            {paused ? 'Resume renewals' : 'Pause renewals'}
          </Button>
        </CardBody>
      </Card>
    </AppUi>
  );
}

/* ---------- Product rows ---------- */

export function DashboardScene() {
  return (
    <>
      <AppUi className="pact-scene-main">
        <Card>
          <CardHeader title="Payment volume" description="Captured USDT, last 18 days" />
          <CardBody>
            <BarChart points={volume} height={110} />
          </CardBody>
        </Card>
        <StatGrid className="mt-3 grid-cols-2 lg:grid-cols-2">
          <Stat label="Available balance" icon={<IconWallet />} value="$29,123.89" hint="USDT" />
          <Stat label="Today's volume" value="$1,340.00" hint="31 payments" />
        </StatGrid>
      </AppUi>
      <AppUi className="pact-scene-float">
        <Notice tone="success" title="Payment received · 49.00 USDT" className="bg-card shadow-pop">
          From maya@studio.dev. No wallet, no gas, one block.
        </Notice>
      </AppUi>
    </>
  );
}

export function SubscriptionsScene() {
  return (
    <>
      <AppUi className="pact-scene-main">
        <StatGrid className="grid-cols-2 lg:grid-cols-2">
          <Stat label="Monthly recurring" value="$506.00" />
          <Stat label="Active" value="38" hint="3 renewals today" />
        </StatGrid>
        <Card className="mt-3">
          <CardHeader title="Plans" />
          <Table className="min-w-0">
            <tbody>
              {[
                ['Team', '$12 / month', 'Cap $15', 'active'],
                ['Pro', '$49 / month', 'Cap $55', 'active'],
                ['Studio', '$199 / month', 'Trial 14 days', 'pending'],
              ].map(([plan, price, cap, status]) => (
                <Tr key={plan}>
                  <Td className="font-medium">{plan}</Td>
                  <Td>{price}</Td>
                  <Td className="text-muted-foreground">{cap}</Td>
                  <Td>
                    <StatusBadge status={status} />
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      </AppUi>
      <AppUi className="pact-scene-float">
        <Notice tone="danger" title="Renewal refused" className="bg-card shadow-pop">
          40 USDT is above the 15 USDT cap the customer signed.
        </Notice>
      </AppUi>
    </>
  );
}

export function AgentsScene() {
  return (
    <>
      <AppUi className="pact-scene-main">
        <Card>
          <CardHeader
            title="research-agent"
            description="Pays per call with x402"
            action={<StatusBadge status="active" />}
          />
          <CardBody className="flex items-center gap-5">
            <Gauge value={0.7} max={1} label="$0.70" sublabel="of $1.00 today" size={116} />
            <DetailList
              className="flex-1"
              items={[
                { label: 'Per call', value: 'up to $0.02' },
                { label: 'Per day', value: 'up to $1.00' },
                { label: 'Calls today', value: '70' },
              ]}
            />
          </CardBody>
        </Card>
      </AppUi>
      <AppUi className="pact-scene-float">
        <Card className="shadow-pop">
          <CardBody className="grid gap-2 p-4 font-mono text-[13px]">
            <div className="flex items-center justify-between">
              <span>GET /risk-score</span>
              <Badge tone="warning">402 · 0.01 USDT</Badge>
            </div>
            <div className="flex items-center justify-between">
              <span>paid, retry</span>
              <Badge tone="success">200 OK</Badge>
            </div>
          </CardBody>
        </Card>
      </AppUi>
    </>
  );
}

export function GasScene() {
  return (
    <>
      <AppUi className="pact-scene-main">
        <Card>
          <CardHeader title="Gas tank" description="Sponsored gas for your customers" action={<IconGasStation className="size-5 text-muted-foreground" />} />
          <CardBody className="flex items-center gap-5">
            <Gauge value={20} max={30} label="20" sublabel="days left" size={116} />
            <DetailList
              className="flex-1"
              items={[
                { label: 'Balance', value: '0.0286 WBT' },
                { label: 'Daily cap', value: '0.01 WBT' },
                { label: 'Spent today', value: '0.0004 WBT', hint: '224 payments' },
              ]}
            />
          </CardBody>
        </Card>
      </AppUi>
      <AppUi className="pact-scene-float">
        <Notice tone="shield" title="Replay refused" className="bg-card shadow-pop">
          Same signature sent twice. Tank spent: 0 WBT.
        </Notice>
      </AppUi>
    </>
  );
}

/* ---------- Journey ---------- */

function LinkStep() {
  return (
    <Card>
      <CardHeader title="Payment links" description="Share a link, get paid in USDT" action={<Button variant="primary" size="sm">New payment link</Button>} />
      <Table className="min-w-0">
        <thead>
          <tr>
            <Th>Link</Th>
            <Th align="right">Price</Th>
            <Th align="right">Payments</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {[
            ['Pro plan', '$49.00', '171', 'active'],
            ['Design audit', '$250.00', '7', 'active'],
            ['Early bird', '$15.00', '42', 'expired'],
          ].map(([name, price, count, status]) => (
            <Tr key={name}>
              <Td className="font-medium">
                {name}
                <span className="block text-[12px] font-normal text-muted-foreground">pay.pactagent.app/{name.toLowerCase().replace(' ', '-')}</span>
              </Td>
              <Td align="right">{price}</Td>
              <Td align="right">{count}</Td>
              <Td>
                <StatusBadge status={status} />
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function CheckoutStep() {
  return (
    <Card className="mx-auto max-w-[380px]">
      <CardBody className="grid gap-4">
        <div>
          <div className="text-sm text-muted-foreground">Northwind Studio</div>
          <div className="mt-1 text-[28px] font-semibold tracking-tight">49.00 USDT</div>
          <div className="text-sm text-muted-foreground">Pro plan · one-time</div>
        </div>
        <Button variant="primary" className="w-full">
          <IconMail className="size-4" />
          Continue with email
        </Button>
        <Button className="w-full">
          <IconFingerprint className="size-4" />
          Use a passkey
        </Button>
        <p className="text-center text-[13px] text-muted-foreground">No wallet. No gas. Settles in one block.</p>
      </CardBody>
    </Card>
  );
}

function RefundStep() {
  return (
    <Card>
      <CardHeader title="Order #1042" description="maya@studio.dev · 49.00 USDT" action={<StatusBadge status="partially_refunded" />} />
      <CardBody className="grid gap-4">
        <DetailList
          items={[
            { label: 'Paid', value: '49.00 USDT' },
            { label: 'Refunded', value: '20.00 USDT', hint: 'Public on the explorer' },
            { label: 'Left', value: '29.00 USDT' },
          ]}
        />
        <Button variant="danger" size="sm" className="w-fit">
          <IconReceiptRefund className="size-4" />
          Refund the rest
        </Button>
      </CardBody>
    </Card>
  );
}

function LimitsStep() {
  return (
    <Card>
      <CardHeader title="Drain protection" description="Eight limits, five in the contracts" action={<IconShieldCheck className="size-5 text-success" />} />
      <CardBody>
        <Timeline
          items={[
            { title: 'Replay refused', detail: 'Same signature sent twice', tone: 'danger', at: '12:04' },
            { title: 'Dust payment refused', detail: 'Under the 0.50 USDT minimum', tone: 'danger', at: '11:52' },
            { title: 'Daily cap reached for spam-bot', detail: 'Further calls refused until tomorrow', tone: 'warning', at: '11:40' },
            { title: 'Tank spent on attacks', detail: '0 WBT', tone: 'success', at: 'Today' },
          ]}
        />
      </CardBody>
    </Card>
  );
}

function PortalStep() {
  return (
    <div className="grid gap-3">
      <Card>
        <CardHeader title="Team plan" description="Renews on Dec 4 · cap 15 USDT" action={<StatusBadge status="active" />} />
        <CardBody className="flex gap-2">
          <Button size="sm">Change plan</Button>
          <Button size="sm" variant="danger">Cancel</Button>
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Receipts" />
        <CardBody className="grid gap-2 text-sm">
          {[
            ['Nov 4', 'Team plan', '12.00 USDT'],
            ['Oct 5', 'Team plan', '12.00 USDT'],
          ].map(([d, w, a]) => (
            <div key={d} className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <IconCircleCheckFilled className="size-4 text-success" />
                {w}
                <span className="text-muted-foreground">{d}</span>
              </span>
              <span className="font-medium">{a}</span>
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

export const journeySteps = [LinkStep, CheckoutStep, RefundStep, LimitsStep, PortalStep];

export function JourneyCard({ step }: { step: number }) {
  const Step = journeySteps[step] ?? LinkStep;
  return (
    <AppUi className="pact-journey-card">
      <Step />
    </AppUi>
  );
}
