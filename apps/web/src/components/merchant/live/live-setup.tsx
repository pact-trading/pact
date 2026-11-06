'use client';

import { IconCircleCheckFilled, IconCircleDashed, IconExternalLink, IconRefresh } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { formatUnits, parseUnits } from 'viem';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { useMerchantChain, type MerchantChainState } from './merchant-chain';

const usdt = (minor: bigint) =>
  `${Number(formatUnits(minor, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT`;
const MIN_CUSTOMER_USDT = parseUnits('5', 6);

/**
 * Live mode: what a test run needs beyond the fee terms and permits (signed on the Fees page). The
 * merchant's wallet needs no WBT: it only signs. The test customer needs USDT to pay with.
 */
export function LiveSetupCard({ compact = false }: { compact?: boolean }) {
  const chain = useMerchantChain();
  const router = useRouter();
  const toast = useToast();
  const [state, setState] = useState<MerchantChainState | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setState(await chain.read());
    } catch {
      setError('Could not read balances from the chain. Is the RPC reachable?');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain.read]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!chain.available || !chain.customer) return null;
  const funded = !!state && (state.customerUsdtMinor ?? 0n) >= MIN_CUSTOMER_USDT;
  if (compact && funded) return null;

  const fund = async () => {
    setWorking(true);
    setError('');
    try {
      await chain.localFaucet('customer', { usdt: '25' });
      toast('25 test USDT sent to your test customer');
      await refresh();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message.split('\n')[0] : 'The test faucet failed.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Test a live payment"
        description={
          state
            ? funded
              ? 'Ready: your test customer can pay, with no gas.'
              : 'Your test customer needs USDT to pay with. Nobody needs WBT.'
            : 'Reading balances…'
        }
        action={
          <Button size="sm" variant="ghost" onClick={() => void refresh()} aria-label="Refresh">
            <IconRefresh className="size-4" />
          </Button>
        }
      />
      <CardBody className="grid gap-3">
        <div
          className={cn(
            'flex flex-wrap items-center gap-3 rounded-2xl border border-border p-3',
            funded && 'opacity-70',
          )}
        >
          {funded ? (
            <IconCircleCheckFilled className="size-5 shrink-0 text-success" />
          ) : (
            <IconCircleDashed className="size-5 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-medium">Fund your test customer</p>
            <p className="text-sm text-muted-foreground">
              {state?.customerUsdtMinor !== null && state
                ? `Customer holds ${usdt(state.customerUsdtMinor ?? 0n)}. They pay in USDT and never need WBT.`
                : 'They pay in USDT and never need WBT.'}
            </p>
            {!chain.localFork && (
              <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                Send test USDT to <span className="font-mono break-all">{chain.customer}</span>
                <CopyButton value={chain.customer} label="Copy address" />
              </p>
            )}
          </div>
          {!funded && (
            <div className="shrink-0">
              {chain.localFork ? (
                <Button size="sm" variant="dark" disabled={working} onClick={() => void fund()}>
                  {working ? 'Waiting for the chain…' : 'Give 25 test USDT'}
                </Button>
              ) : (
                <Button size="sm" variant="dark" onClick={() => window.open(chain.faucetUrl, '_blank', 'noopener')}>
                  Open the faucet <IconExternalLink className="size-4" />
                </Button>
              )}
            </div>
          )}
        </div>
        {error && <Notice tone="danger">{error}</Notice>}
      </CardBody>
    </Card>
  );
}
