import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { IconCircleCheck, IconCircleX, IconFlask } from '@tabler/icons-react';
import { createPublicClient, decodeEventLog, formatUnits, http, parseAbi, type Hex } from 'viem';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { addressUrl } from '@/lib/explorer';
import { shortHash } from '@/lib/format';

export const metadata: Metadata = { title: 'Transaction' };
export const dynamic = 'force-dynamic';

const USDT = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7';
const transfer = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']);

/** Local fork only: its transactions exist only on the fork, so the public explorer cannot show them. */
export default async function LocalTxPage({ params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params;
  if (process.env.PACT_LOCAL_FORK !== '1' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) notFound();
  const client = createPublicClient({
    transport: http(process.env.PACT_CHAIN_RPC_URL ?? 'http://127.0.0.1:8545'),
  });
  const [tx, receipt] = await Promise.all([
    client.getTransaction({ hash: hash as Hex }).catch(() => null),
    client.getTransactionReceipt({ hash: hash as Hex }).catch(() => null),
  ]);
  if (!tx) notFound();
  const block = receipt
    ? await client.getBlock({ blockNumber: receipt.blockNumber }).catch(() => null)
    : null;
  const transfers = (receipt?.logs ?? [])
    .filter(log => log.address.toLowerCase() === USDT.toLowerCase())
    .flatMap(log => {
      try {
        const e = decodeEventLog({ abi: transfer, data: log.data, topics: log.topics });
        return [e.args];
      } catch {
        return [];
      }
    });
  const ok = receipt?.status === 'success';
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border-subtle py-2.5 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm break-all">{value}</span>
    </div>
  );
  const address = (a: string | null | undefined) =>
    a ? (
      <a className="font-mono underline-offset-4 hover:underline" href={addressUrl(a)}>
        {shortHash(a)}
      </a>
    ) : (
      '—'
    );
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-6 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning-soft px-4 py-2.5 text-sm">
        <IconFlask className="size-4 text-warning" />
        Local fork of Whitechain Sepolia. This transaction exists only on the fork, so it is read from the
        local node instead of the public explorer.
      </div>
      <p className="text-sm text-muted-foreground">Whitechain Sepolia (local fork) · chain 1874</p>
      <h1 className="mt-1 text-2xl font-semibold">Transaction details</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="text-sm break-all text-subtle-foreground">{tx.hash}</code>
        <CopyButton value={tx.hash} label="Copy hash" />
        {receipt ? (
          <Badge tone={ok ? 'success' : 'danger'}>
            {ok ? <IconCircleCheck className="size-3.5" /> : <IconCircleX className="size-3.5" />}
            {ok ? 'Success' : 'Reverted'}
          </Badge>
        ) : (
          <Badge tone="warning">Pending</Badge>
        )}
      </div>
      <Card className="mt-6">
        <CardHeader title="Overview" />
        <CardBody>
          {row('Block', receipt ? receipt.blockNumber.toString() : 'Pending')}
          {row('Time', block ? new Date(Number(block.timestamp) * 1000).toUTCString() : '—')}
          {row('From (relayer or sender)', address(tx.from))}
          {row('To (contract)', address(tx.to))}
          {row('Gas used', receipt ? receipt.gasUsed.toString() : '—')}
          {row(
            'Network fee',
            receipt ? `${formatUnits(receipt.gasUsed * receipt.effectiveGasPrice, 18)} WBT` : '—',
          )}
          {row('Events', receipt ? String(receipt.logs.length) : '—')}
        </CardBody>
      </Card>
      {transfers.length > 0 && (
        <Card className="mt-6">
          <CardHeader title="USDT transfers" />
          <CardBody>
            {transfers.map((t, i) => (
              <div key={i}>
                {row(`${shortHash(t.from)} → ${shortHash(t.to)}`, `${formatUnits(t.value, 6)} USDT`)}
              </div>
            ))}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
