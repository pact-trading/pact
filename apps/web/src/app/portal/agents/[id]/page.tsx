import type { Metadata } from 'next';
import { AgentConsole } from '@/components/customer/agents/agent-console';
import { FundAgentButton } from '@/components/customer/agents/create-agent';
import { AgentLimits } from '@/components/customer/agents/agent-limits';
import { NotConnected } from '@/components/states/not-connected';
import { PublicRecord } from '@/components/states/public-record';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, DetailList } from '@/components/ui/card';
import { CodeBlock } from '@/components/ui/code-block';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { date, dateTime, shortHash, usd } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';

export const metadata: Metadata = { title: 'Agent' };

const agentCode = `import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';

// sessionSigner is the agent's session key. The account it signs for
// enforces the per-call cap, the daily cap and the allowed merchants.
const client = x402Client.fromConfig({
  schemes: [{ network: 'eip155:1874', client: new ExactEvmScheme(sessionSigner) }],
});
const pay = wrapFetchWithPayment(fetch, client);

const res = await pay('https://api.kitelabs.example/api/risk-score?invoice=INV-1042');
console.log(await res.json()); // { score: 0.82, band: 'low' }`;

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await load(async () => (await getData()).customer.agent(id));
  if (isNotWired(detail)) return <NotConnected feature={detail.feature} />;
  const { session, calls } = detail;
  const used =
    BigInt(session.dailyCapMinor) === 0n
      ? 0
      : Number((BigInt(session.spentTodayMinor) * 100n) / BigInt(session.dailyCapMinor));
  return (
    <>
      <PageHeader
        back={{ href: '/portal/agents', label: 'Agents' }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {session.name} <StatusBadge status={session.status} />
          </span>
        }
        description={session.description}
      />
      {session.status !== 'active' && (
        <Notice tone="warning" className="mb-6" title={session.status === 'revoked' ? 'Revoked' : 'Expired'}>
          This agent can no longer pay anyone. Any call it makes is refused by its account.
        </Notice>
      )}
      <Card>
        <CardHeader
          title="Live run"
          description="An AI agent paying per request in USDT. It holds no gas and no seed phrase."
        />
        <CardBody>
          <FundAgentButton id={session.id} account={session.account} />
          <AgentConsole session={session} disabled={session.status !== 'active'} />
        </CardBody>
      </Card>
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader title="Spending today" />
            <CardBody className="grid gap-3">
              <div className="flex items-baseline justify-between">
                <span className="text-3xl font-semibold">{usd(session.spentTodayMinor)}</span>
                <span className="text-sm text-muted-foreground">of {usd(session.dailyCapMinor)}</span>
              </div>
              <div
                className="h-2 overflow-hidden rounded-full bg-chip"
                role="progressbar"
                aria-valuenow={used}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Daily cap used"
              >
                <div
                  className={`h-full rounded-full ${used >= 100 ? 'bg-destructive' : used >= 80 ? 'bg-warning' : 'bg-success'}`}
                  style={{ width: `${Math.min(100, used)}%` }}
                />
              </div>
              <p className="text-sm text-muted-foreground">{session.callsToday} paid calls today</p>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Limits" />
            <CardBody>
              <AgentLimits session={session} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Session" />
            <CardBody>
              <DetailList
                items={[
                  { label: 'May pay', value: session.allowedMerchants.map(m => m.name).join(', ') },
                  { label: 'Expires', value: date(session.expiresAt) },
                  {
                    label: 'Session key',
                    value: <code className="text-[13px]">{shortHash(session.sessionKey)}</code>,
                  },
                  {
                    label: 'Agent account',
                    value: <code className="text-[13px]">{shortHash(session.account)}</code>,
                  },
                ]}
              />
            </CardBody>
          </Card>
        </div>
        <div className="grid min-w-0 content-start gap-6">
          <CodeBlock title="The agent’s code · unmodified @x402/fetch" code={agentCode} />
          <Card>
            <CardHeader title="Recent calls" />
            <Table>
              <thead>
                <tr>
                  <Th>Time</Th>
                  <Th>Request</Th>
                  <Th align="right">Paid</Th>
                  <Th>Result</Th>
                </tr>
              </thead>
              <tbody>
                {calls.slice(0, 15).map(c => (
                  <Tr key={c.id}>
                    <Td className="whitespace-nowrap text-muted-foreground">{dateTime(c.createdAt)}</Td>
                    <Td className="max-w-[200px] truncate font-mono text-[12px]">{c.url}</Td>
                    <Td align="right">{c.status === 'settled' ? usd(c.amountMinor) : '—'}</Td>
                    <Td>
                      {c.status === 'settled' ? (
                        <PublicRecord hash={c.txHash} />
                      ) : (
                        <span className="text-[13px] text-destructive">{c.reason}</span>
                      )}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </Card>
        </div>
      </div>
    </>
  );
}
