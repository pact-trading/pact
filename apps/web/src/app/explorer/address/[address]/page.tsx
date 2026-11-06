import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { IconFlask } from '@tabler/icons-react';
import { createPublicClient, formatUnits, http, isAddress, parseAbi } from 'viem';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';

export const metadata: Metadata = { title: 'Address' };
export const dynamic = 'force-dynamic';

const USDT = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7';
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

/** Local fork only: balances and code of an address, read from the local node. */
export default async function LocalAddressPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  if (process.env.PACT_LOCAL_FORK !== '1' || !isAddress(address)) notFound();
  const client = createPublicClient({
    transport: http(process.env.PACT_CHAIN_RPC_URL ?? 'http://127.0.0.1:8545'),
  });
  const [wei, usdt, code] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [address] }),
    client.getCode({ address }),
  ]);
  const kind =
    !code || code === '0x'
      ? 'Account'
      : code.startsWith('0xef0100')
        ? 'Account with delegated code'
        : 'Contract';
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-border-subtle py-2.5 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm break-all">{value}</span>
    </div>
  );
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="mb-6 flex items-center gap-2 rounded-xl border border-warning/30 bg-warning-soft px-4 py-2.5 text-sm">
        <IconFlask className="size-4 text-warning" />
        Local fork of Whitechain Sepolia: balances are read from the local node.
      </div>
      <h1 className="text-2xl font-semibold">Address</h1>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="text-sm break-all text-subtle-foreground">{address}</code>
        <CopyButton value={address} label="Copy address" />
      </div>
      <Card className="mt-6">
        <CardHeader title="Overview" />
        <CardBody>
          {row('Type', kind)}
          {row('WBT', `${formatUnits(wei, 18)} WBT`)}
          {row('USDT', `${formatUnits(usdt, 6)} USDT`)}
        </CardBody>
      </Card>
    </div>
  );
}
