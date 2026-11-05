import type { Metadata } from 'next';
import Link from 'next/link';
import { IconApi, IconRobot } from '@tabler/icons-react';
import { SimulateRequest } from '@/components/merchant/agents/simulate-request';
import { NotConnected } from '@/components/states/not-connected';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader, DetailList } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Gauge } from '@/components/ui/gauge';
import { PageHeader, SectionTitle } from '@/components/ui/page-header';
import { Stat, StatGrid } from '@/components/ui/stat';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { date, dateTime, usd } from '@/lib/format';
import { getData } from '@/server/data';
import type { MerchantAgent } from '@/server/data/parts/financing';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Agents paying you' };

function AgentCard({ agent }: { agent: MerchantAgent }) {
  const { session, owner } = agent;
  const spent = BigInt(session.spentTodayMinor);
  const cap = BigInt(session.dailyCapMinor);
  const used = cap === 0n ? 0 : Number((spent * 1000n) / cap) / 10;
  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {session.name} <StatusBadge status={session.status} />
          </span>
        }
        description={`${owner.name}${owner.company ? ` · ${owner.company}` : ''}`}
      />
      <CardBody className="grid flex-1 content-start gap-5">
        <p className="text-sm text-muted-foreground">{session.description}</p>
        <div className="flex items-center gap-5">
          <Gauge
            size={112}
            value={Number(spent)}
            max={Number(cap)}
            label={usd(spent)}
            sublabel={`of ${usd(cap)}`}
            tone={used >= 100 ? 'danger' : used >= 80 ? 'warning' : 'success'}
          />
          <div className="grid gap-1 text-sm">
            <p className="font-medium">Spent today</p>
            <p className="text-muted-foreground">
              {Math.min(100, Math.round(used))}% of the daily cap, {session.callsToday} paid call
              {session.callsToday === 1 ? '' : 's'}
            </p>
            <p className="text-muted-foreground">{usd(agent.paidToYouTodayMinor)} paid to you</p>
          </div>
        </div>
        <DetailList
          items={[
            { label: 'Per call', value: `up to ${usd(session.perCallCapMinor)}` },
            { label: 'Per day', value: `up to ${usd(session.dailyCapMinor)}` },
            {
              label: 'Account balance',
              value: agent.balanceMinor === null ? '—' : usd(agent.balanceMinor),
              hint: 'Public onchain',
            },
            { label: 'Session expires', value: date(session.expiresAt) },
          ]}
        />
        <p className="text-[13px] text-muted-foreground">
          Caps set by {owner.company ?? owner.name}. Read-only here; only the owner can change or revoke them.
        </p>
        {agent.recent.length > 0 ? (
          <div className="grid gap-1.5">
            <p className="text-sm font-medium">Recent requests</p>
            <ul className="grid gap-1">
              {agent.recent.slice(0, 3).map(call => (
                <li key={call.id}>
                  <Link
                    href={`/dashboard/agents/requests/${call.id}`}
                    className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-raised"
                  >
                    <span className="min-w-0 truncate font-mono text-[12px] text-muted-foreground">
                      {call.url}
                    </span>
                    <span className="shrink-0">
                      {call.status === 'settled' ? usd(call.amountMinor) : (call.reason ?? 'Refused')}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No requests to you yet.</p>
        )}
      </CardBody>
    </Card>
  );
}

export default async function AgentsPage() {
  const data = await getData();
  const [overview, viewer] = await Promise.all([load(() => data.financing.agents()), getViewer()]);
  if (isNotWired(overview)) return <NotConnected feature={overview.feature} />;
  const { agents, recent } = overview;
  const active = agents.filter(a => a.session.status === 'active').length;
  const paidToday = agents.reduce((sum, a) => sum + BigInt(a.paidToYouTodayMinor), 0n);
  const refusedToday = agents.reduce((sum, a) => sum + a.refusedToday, 0);
  const canSimulate = viewer?.role === 'merchant' && data.mode === 'mock';
  return (
    <>
      <PageHeader
        title="Agents paying you"
        description="AI agents call your paid API over x402 and pay per request in USDT. Each agent’s owner sets its caps; you see them here, read-only."
        actions={
          <>
            <Button asChild size="sm">
              <Link href="/dashboard/paid-api">
                <IconApi className="size-4" />
                Paid API
              </Link>
            </Button>
            {canSimulate && <SimulateRequest scenarios={overview.scenarios} />}
          </>
        }
      />
      <StatGrid className="mb-6">
        <Stat label="Agents" value={agents.length} hint={`${active} active`} />
        <Stat label="Paid to you today" value={usd(paidToday)} hint="Before the per-call Pact fee" />
        <Stat
          label="Paid requests today"
          value={agents.reduce((sum, a) => sum + a.settledToday, 0)}
          hint="Settled in USDT"
        />
        <Stat
          label="Refused today"
          value={refusedToday}
          tone={refusedToday > 0 ? 'warning' : 'default'}
          hint="Stopped before payment"
        />
      </StatGrid>
      {agents.length === 0 ? (
        <Card>
          <EmptyState icon={<IconRobot />} title="No agents yet">
            When an AI agent’s owner allows it to pay {overview.merchant.name}, it appears here with its caps.
          </EmptyState>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {agents.map(agent => (
            <AgentCard key={agent.session.id} agent={agent} />
          ))}
        </div>
      )}
      <SectionTitle>Recent requests</SectionTitle>
      <Card>
        {recent.length === 0 ? (
          <EmptyState icon={<IconRobot />} title="No requests yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Agent</Th>
                <Th align="right">Amount</Th>
                <Th>Result</Th>
                <Th>
                  <span className="sr-only">Trace</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {recent.map(call => (
                <Tr key={call.id}>
                  <Td className="whitespace-nowrap text-muted-foreground">{dateTime(call.createdAt)}</Td>
                  <Td>
                    <p className="font-medium">{call.agentName}</p>
                    <code className="block max-w-[260px] truncate text-[12px] text-muted-foreground">
                      {call.url}
                    </code>
                  </Td>
                  <Td align="right">{call.status === 'settled' ? usd(call.amountMinor) : '—'}</Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={call.status} />
                      {call.reason && (
                        <span className="text-[13px] text-muted-foreground">{call.reason}</span>
                      )}
                    </div>
                  </Td>
                  <Td align="right">
                    <Link
                      href={`/dashboard/agents/requests/${call.id}`}
                      className="text-sm font-medium whitespace-nowrap underline-offset-4 hover:underline"
                    >
                      Trace<span className="sr-only"> of {call.id}</span>
                    </Link>
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
