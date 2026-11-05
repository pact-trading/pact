import type { Metadata } from 'next';
import { RequestTrace } from '@/components/merchant/agents/request-trace';
import { NotConnected } from '@/components/states/not-connected';
import { PublicRecord } from '@/components/states/public-record';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, DetailList } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { dateTime, shortHash, usd } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';

export const metadata: Metadata = { title: 'Agent request' };

export default async function AgentRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const trace = await load(async () => (await getData()).financing.agentRequest(id));
  if (isNotWired(trace)) return <NotConnected feature={trace.feature} />;
  const { call, agent, endpoint, refusal } = trace;
  const price = call.scheme === 'upto' ? `up to ${usd(call.priceMinor)}` : usd(call.priceMinor);
  return (
    <>
      <PageHeader
        back={{ href: '/dashboard/agents', label: 'Agents paying you' }}
        eyebrow="Paid request"
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-[24px] sm:text-[28px]">{call.id}</span>
            <StatusBadge status={call.status} />
          </span>
        }
        description={`${call.method} ${endpoint?.path ?? call.url} · ${price} · ${dateTime(call.createdAt)}`}
      />
      {refusal && (
        <Notice tone="shield" className="mb-6" title={`Refused before payment: ${refusal.reason}`}>
          {refusal.detail} {agent.session.name} was not charged and {trace.merchant.name} returned no data.
        </Notice>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card className="min-w-0">
          <CardHeader
            title="Step by step"
            description="Request, 402 price quote, payment authorisation, settlement, response"
          />
          <CardBody>
            <RequestTrace trace={trace} />
          </CardBody>
        </Card>
        <div className="grid min-w-0 content-start gap-6">
          <Card>
            <CardHeader title="Settlement" />
            <CardBody>
              <DetailList
                items={[
                  { label: 'Price quoted', value: price },
                  { label: 'Settled', value: call.status === 'settled' ? usd(call.amountMinor) : 'Nothing' },
                  {
                    label: 'Pact fee',
                    value: call.status === 'settled' ? usd(trace.feeMinor) : '—',
                    hint: 'Per settlement, from your side',
                  },
                  { label: 'Network', value: trace.network },
                  {
                    label: 'Pays to',
                    value: <code className="text-[13px]">{shortHash(trace.merchant.address)}</code>,
                  },
                  {
                    label: 'Transaction',
                    value: call.txHash ? <PublicRecord hash={call.txHash} /> : 'None: refused before payment',
                  },
                ]}
              />
            </CardBody>
          </Card>
          <Card>
            <CardHeader
              title={agent.session.name}
              description={`${agent.owner.name}${agent.owner.company ? ` · ${agent.owner.company}` : ''}`}
            />
            <CardBody className="grid gap-3">
              <DetailList
                items={[
                  { label: 'Status', value: <StatusBadge status={agent.session.status} /> },
                  { label: 'Per call', value: `up to ${usd(agent.session.perCallCapMinor)}` },
                  { label: 'Per day', value: `up to ${usd(agent.session.dailyCapMinor)}` },
                  {
                    label: 'Spent today',
                    value: `${usd(agent.session.spentTodayMinor)} of ${usd(agent.session.dailyCapMinor)}`,
                  },
                  {
                    label: 'Account balance',
                    value: agent.balanceMinor === null ? '—' : usd(agent.balanceMinor),
                  },
                  {
                    label: 'Agent account',
                    value: <code className="text-[13px]">{shortHash(agent.session.account)}</code>,
                  },
                ]}
              />
              <p className="text-[13px] text-muted-foreground">
                Current caps, set by {agent.owner.company ?? agent.owner.name}. Read-only here.
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
