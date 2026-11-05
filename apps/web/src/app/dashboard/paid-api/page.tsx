import type { Metadata } from 'next';
import { IconRobot } from '@tabler/icons-react';
import { NotConnected } from '@/components/states/not-connected';
import { PublicRecord } from '@/components/states/public-record';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, DetailList } from '@/components/ui/card';
import { CodeBlock } from '@/components/ui/code-block';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader, SectionTitle } from '@/components/ui/page-header';
import { Stat, StatGrid } from '@/components/ui/stat';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { dateTime, usd } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';

export const metadata: Metadata = { title: 'Paid API' };

const middleware = `import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';

const facilitator = new HTTPFacilitatorClient({ url: 'https://facilitator.pact.example' });
const server = new x402ResourceServer(facilitator).register('eip155:1874', new ExactEvmScheme());
const usdt = { asset: USDT, amount: '10000', extra: { assetTransferMethod: 'permit2' } }; // $0.01

app.use(paymentMiddleware({
  'GET /api/risk-score': { accepts: { scheme: 'exact', network: 'eip155:1874', payTo, price: usdt } },
}, server));`;

export default async function PaidApiPage() {
  const data = await getData();
  const [endpoints, calls, facilitator] = await Promise.all([
    load(() => data.merchant.paidEndpoints()),
    load(() => data.merchant.agentCalls(40)),
    load(() => data.merchant.facilitator()),
  ]);
  if (isNotWired(endpoints)) return <NotConnected feature={endpoints.feature} />;
  const list = isNotWired(calls) ? [] : calls;
  const revenue = endpoints.reduce((t, e) => t + BigInt(e.revenueTodayMinor), 0n);
  return (
    <>
      <PageHeader
        title="Paid API"
        description="AI agents pay per request over x402, settled in USDT through Pact’s facilitator. Agents need no gas; their owners set the limits."
      />
      <StatGrid>
        <Stat label="Paid calls today" value={endpoints.reduce((t, e) => t + e.callsToday, 0)} />
        <Stat label="Agent revenue today" value={usd(revenue)} hint="Before the per-call Pact fee" />
        <Stat
          label="Refused today"
          value={endpoints.reduce((t, e) => t + e.refusedToday, 0)}
          hint="Over an agent's own cap"
        />
        <Stat
          label="Facilitator"
          value={isNotWired(facilitator) ? '—' : facilitator.status === 'online' ? 'Online' : 'Off'}
          tone={!isNotWired(facilitator) && facilitator.status === 'online' ? 'success' : 'default'}
          hint={
            isNotWired(facilitator)
              ? undefined
              : `${facilitator.settled} settled, ${facilitator.refused} refused`
          }
        />
      </StatGrid>
      <SectionTitle>Endpoints</SectionTitle>
      <Card>
        <Table>
          <thead>
            <tr>
              <Th>Endpoint</Th>
              <Th>Scheme</Th>
              <Th align="right">Price</Th>
              <Th align="right">Calls today</Th>
              <Th align="right">Revenue today</Th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map(e => (
              <Tr key={e.id}>
                <Td>
                  <code className="text-[13px] font-semibold">
                    {e.method} {e.path}
                  </code>
                  <p className="text-[13px] text-muted-foreground">{e.description}</p>
                </Td>
                <Td>
                  <Badge tone="outline">
                    {e.scheme === 'upto' ? 'upto · pay for what you use' : 'exact'}
                  </Badge>
                </Td>
                <Td align="right">
                  {e.scheme === 'upto' ? `up to ${usd(e.priceMinor)}` : usd(e.priceMinor)}
                </Td>
                <Td align="right">{e.callsToday}</Td>
                <Td align="right" className="font-medium">
                  {usd(e.revenueTodayMinor)}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader
            title="Recent settlements"
            description="Each call: request → 402 → signed payment → settlement → data"
          />
          {list.length === 0 ? (
            <EmptyState icon={<IconRobot />} title="No agent calls yet" />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Time</Th>
                  <Th>Agent</Th>
                  <Th align="right">Amount</Th>
                  <Th>Result</Th>
                </tr>
              </thead>
              <tbody>
                {list.map(c => (
                  <Tr key={c.id}>
                    <Td className="text-muted-foreground">{dateTime(c.createdAt)}</Td>
                    <Td>
                      <p className="font-medium">{c.agentName}</p>
                      <code className="block max-w-[240px] truncate text-[12px] text-muted-foreground">
                        {c.url}
                      </code>
                    </Td>
                    <Td align="right">{c.status === 'settled' ? usd(c.amountMinor) : '—'}</Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-2">
                        <StatusBadge status={c.status} />
                        {c.reason ? (
                          <span className="text-[13px] text-muted-foreground">{c.reason}</span>
                        ) : (
                          <PublicRecord hash={c.txHash} />
                        )}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <div className="grid min-w-0 content-start gap-6">
          <CodeBlock title="Charge per request with the official x402 middleware" code={middleware} />
          {!isNotWired(facilitator) && (
            <Card>
              <CardHeader title="Facilitator" description="Run by Pact; settles real USDT through Permit2" />
              <CardBody>
                <DetailList
                  items={[
                    { label: 'URL', value: <code className="text-[13px]">{facilitator.url}</code> },
                    { label: 'Network', value: facilitator.network },
                    { label: 'Schemes', value: facilitator.schemes.join(', ') },
                    { label: 'Verified', value: facilitator.verified },
                  ]}
                />
              </CardBody>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
