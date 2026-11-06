import type { Metadata } from 'next';
import { DrainSimulation } from '@/components/merchant/security/drain-simulation';
import { NotConnected } from '@/components/states/not-connected';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { PageHeader, SectionTitle } from '@/components/ui/page-header';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { dateTime, humanize, shortHash } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Security' };

const sourceLabel = {
  refund: 'Refund',
  subscription: 'Subscription',
  sponsorship: 'Relayer',
  agent: 'Agent',
  invoice: 'Invoice',
} as const;

export default async function SecurityPage() {
  const data = await getData();
  const [layers, refusals, viewer] = await Promise.all([
    load(() => data.merchant.securityLayers()),
    load(() => data.merchant.refusals({ source: 'sponsorship', limit: 40 })),
    getViewer(),
  ]);
  if (isNotWired(layers)) return <NotConnected feature={layers.feature} />;
  return (
    <>
      <PageHeader
        title="Security"
        description="What stops someone spending your money or making Pact pay for junk. Five limits live in the contracts, three in the relayer, and every refusal is recorded with its reason."
      />
      <Card>
        <CardHeader
          title="Drain attack"
          description="The same script judges can run. It fails, and your USDT only moves on calls you sign."
        />
        <CardBody>
          <DrainSimulation readOnly={viewer?.role !== 'merchant'} />
        </CardBody>
      </Card>
      <SectionTitle>Eight layers</SectionTitle>
      <Card>
        <Table>
          <thead>
            <tr>
              <Th className="w-12">#</Th>
              <Th>Limit</Th>
              <Th>Enforced in</Th>
              <Th>Stops</Th>
              <Th align="right">Refused</Th>
            </tr>
          </thead>
          <tbody>
            {layers.map(layer => (
              <Tr key={layer.id}>
                <Td className="font-mono text-muted-foreground">{layer.id}</Td>
                <Td>
                  <p className="font-medium">{layer.name}</p>
                  <p className="text-[12px] text-muted-foreground">{layer.reasons.join(', ')}</p>
                </Td>
                <Td>
                  <Badge tone={layer.enforcedIn === 'contract' ? 'success' : 'outline'}>
                    {layer.enforcedIn === 'contract' ? 'Contract' : 'Relayer'}
                  </Badge>
                </Td>
                <Td className="text-subtle-foreground">{layer.stops}</Td>
                <Td align="right" className="font-medium">
                  {layer.blocked}
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
      <SectionTitle>Relayer refusals</SectionTitle>
      <Card>
        {isNotWired(refusals) ? (
          <CardBody>
            <NotConnected feature={refusals.feature} />
          </CardBody>
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Source</Th>
                <Th>Reason</Th>
                <Th>From</Th>
              </tr>
            </thead>
            <tbody>
              {refusals.map(r => (
                <Tr key={r.id}>
                  <Td className="whitespace-nowrap text-muted-foreground">{dateTime(r.createdAt)}</Td>
                  <Td>
                    {sourceLabel[r.source]}
                    {r.layer && (
                      <span className="ml-1.5 text-[12px] text-muted-foreground">layer {r.layer}</span>
                    )}
                  </Td>
                  <Td>
                    <p className="font-medium">{humanize(r.reason)}</p>
                    <p className="text-[13px] text-muted-foreground">{r.detail}</p>
                  </Td>
                  <Td className="font-mono text-[13px] text-muted-foreground">
                    {r.actor?.startsWith('0x') ? shortHash(r.actor) : r.actor}
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
