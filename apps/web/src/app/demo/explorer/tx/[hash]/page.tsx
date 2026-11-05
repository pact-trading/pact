import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { IconCircleCheck, IconCircleX, IconFlask } from '@tabler/icons-react';
import { Card, CardBody, CardHeader, DetailList } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { dateTime, shortHash, usdt, wbt } from '@/lib/format';
import { getData } from '@/server/data';

export const metadata: Metadata = { title: 'Transaction' };
export const dynamic = 'force-dynamic';

/** Mock-mode stand-in for the Whitechain explorer: synthetic hashes resolve here. */
export default async function ExplorerTxPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  const demo = (await getData()).demo;
  const tx = demo ? await demo.transaction(hash) : null;
  if (!tx) notFound();
  const ok = tx.status === 'success';
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-6 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning-soft px-4 py-2.5 text-sm">
        <IconFlask className="size-4 text-warning" />
        Mock explorer. This synthetic transaction mirrors what Whitechain Sepolia shows for the real flow.
      </div>
      <p className="text-sm text-muted-foreground">Whitechain Sepolia · chain 1874</p>
      <h1 className="mt-1 text-2xl font-semibold">Transaction details</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="text-sm break-all text-subtle-foreground">{tx.hash}</code>
        <CopyButton value={tx.hash} label="Copy hash" />
      </div>
      <Card className="mt-6">
        <CardHeader
          title={tx.summary}
          action={
            <Badge tone={ok ? 'success' : 'danger'}>
              {ok ? <IconCircleCheck className="size-3.5" /> : <IconCircleX className="size-3.5" />}
              {ok ? 'Success' : 'Refused'}
            </Badge>
          }
        />
        <CardBody>
          <DetailList
            items={[
              { label: 'Block', value: tx.block },
              { label: 'Time', value: dateTime(tx.at) },
              { label: 'Method', value: <code className="text-sm">{tx.method}</code> },
              { label: 'From', value: <code className="text-sm">{tx.from}</code>, hint: 'Pact relayer' },
              { label: 'To', value: <code className="text-sm">{shortHash(tx.to, 10, 6)}</code> },
              { label: 'Gas', value: tx.gasWei === '0' ? 'None' : wbt(tx.gasWei, 6), hint: tx.gasPaidBy },
            ]}
          />
        </CardBody>
      </Card>
      {tx.transfers.length > 0 && (
        <Card className="mt-4">
          <CardHeader title="USDT transfers" description="Official Whitechain test USDT 0xcedf…55a7" />
          <CardBody className="grid gap-3">
            {tx.transfers.map((t, i) => (
              <div key={i} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground">
                  {t.label}: <code>{shortHash(t.from)}</code> → <code>{shortHash(t.to)}</code>
                </span>
                <span className="font-semibold">{usdt(t.amountMinor)}</span>
              </div>
            ))}
          </CardBody>
        </Card>
      )}
      <Card className="mt-4">
        <CardHeader title="Event logs" />
        <CardBody className="grid gap-3">
          {tx.events.map((e, i) => (
            <div key={i} className="text-sm">
              <code className="font-semibold">{e.name}</code>
              <p className="text-muted-foreground">{e.detail}</p>
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}
