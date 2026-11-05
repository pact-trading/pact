'use client';

import { IconCircleCheckFilled, IconCircleDashed, IconExternalLink, IconRefresh } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { formatUnits, parseEther, parseUnits } from 'viem';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { useMerchantChain, type MerchantChainState } from './merchant-chain';

const wbt = (wei: bigint) =>
  `${Number(formatUnits(wei, 18)).toLocaleString(undefined, { maximumFractionDigits: 4 })} WBT`;
const usdt = (minor: bigint) =>
  `${Number(formatUnits(minor, 6)).toLocaleString(undefined, { maximumFractionDigits: 2 })} USDT`;
const MIN_WALLET_WBT = parseEther('0.02');
const MIN_FEE_USDT = parseUnits('0.1', 6);
const MIN_CUSTOMER_USDT = parseUnits('5', 6);
const ENOUGH_ALLOWANCE = parseUnits('1000', 6);

/**
 * Live mode: what a merchant wallet needs before customers can pay with no gas. Every step is a real
 * transaction from the merchant's own wallet, so each one shows its state read from the chain.
 */
export function LiveSetupCard({ compact = false }: { compact?: boolean }) {
  const chain = useMerchantChain();
  const router = useRouter();
  const toast = useToast();
  const [state, setState] = useState<MerchantChainState | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await chain.read());
    } catch {
      setError('Could not read your wallet from the chain. Is the RPC reachable?');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain.read]);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!chain.available) return null;
  const act = (id: string, label: string, work: () => Promise<unknown>) => async () => {
    setWorking(id);
    setError('');
    try {
      await work();
      toast(label);
      await refresh();
      router.refresh();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (!/reject|denied|cancel/i.test(message)) setError(message.split('\n')[0]);
    } finally {
      setWorking(null);
    }
  };

  const s = state;
  const steps = [
    {
      id: 'wbt',
      title: 'WBT for gas in your wallet',
      done: !!s && (s.walletWei >= MIN_WALLET_WBT || s.tankWei > 0n),
      detail: s ? `Wallet holds ${wbt(s.walletWei)}.` : '',
      action: chain.localFork ? (
        <Button
          size="sm"
          variant="dark"
          disabled={!!working}
          onClick={act('wbt', 'Test WBT added to your wallet', () =>
            chain.localFaucet('merchant', { wbt: '0.5' }),
          )}
        >
          Get 0.5 test WBT
        </Button>
      ) : (
        <Button size="sm" variant="dark" onClick={() => window.open(chain.faucetUrl, '_blank', 'noopener')}>
          Claim WBT from the faucet <IconExternalLink className="size-4" />
        </Button>
      ),
    },
    {
      id: 'deposit',
      title: 'Fund your gas tank',
      done: !!s && s.tankWei > 0n,
      detail: s
        ? `Tank holds ${wbt(s.tankWei)}. Customers' gas is paid from it, never from anyone else's tank.`
        : '',
      action: (
        <Button
          size="sm"
          variant="dark"
          disabled={!!working || !s || s.walletWei < parseEther('0.21')}
          onClick={act('deposit', '0.2 WBT deposited into your gas tank', () =>
            chain.deposit(parseEther('0.2')),
          )}
        >
          Deposit 0.2 WBT
        </Button>
      ),
    },
    {
      id: 'cap',
      title: 'Set a daily gas cap',
      done: !!s && s.dailyCapWei > 0n,
      detail: s
        ? s.dailyCapWei > 0n
          ? `Cap: ${wbt(s.dailyCapWei)} a day, enforced by the GasTank contract.`
          : 'With no cap, the contract refuses every sponsored call.'
        : '',
      action: (
        <Button
          size="sm"
          variant="dark"
          disabled={!!working}
          onClick={act('cap', 'Daily cap set to 0.1 WBT', () => chain.setDailyCap(parseEther('0.1')))}
        >
          Set 0.1 WBT a day
        </Button>
      ),
    },
    {
      id: 'approve',
      title: 'Allow fees and refunds',
      done: !!s && s.routerAllowance >= ENOUGH_ALLOWANCE && s.escrowAllowance >= ENOUGH_ALLOWANCE,
      detail: 'Two approvals: the Router takes the small Pact fee, the escrow pays refunds you issue.',
      action: (
        <Button
          size="sm"
          variant="dark"
          disabled={!!working}
          onClick={act('approve', 'Fees and refunds allowed', async () => {
            if (!s || s.routerAllowance < ENOUGH_ALLOWANCE) await chain.approveUsdt('router');
            if (!s || s.escrowAllowance < ENOUGH_ALLOWANCE) await chain.approveUsdt('escrow');
          })}
        >
          Approve
        </Button>
      ),
    },
    {
      id: 'fees',
      title: 'Keep a little USDT for fees',
      done: !!s && s.walletUsdtMinor >= MIN_FEE_USDT,
      detail: s
        ? `Wallet holds ${usdt(s.walletUsdtMinor)}. Each sponsored payment pays a small fee before revenue arrives.`
        : '',
      action: chain.localFork ? (
        <Button
          size="sm"
          variant="dark"
          disabled={!!working}
          onClick={act('fees', 'Test USDT added to your wallet', () =>
            chain.localFaucet('merchant', { usdt: '5' }),
          )}
        >
          Get 5 test USDT
        </Button>
      ) : (
        <Button
          size="sm"
          variant="dark"
          disabled={!!working}
          onClick={act('fees', 'Swapped WBT for USDT', () =>
            chain.swapToUsdt(chain.merchant!, parseEther('0.01')),
          )}
        >
          Swap 0.01 WBT
        </Button>
      ),
    },
    ...(chain.customer
      ? [
          {
            id: 'customer',
            title: 'Fund your test customer',
            done: !!s && (s.customerUsdtMinor ?? 0n) >= MIN_CUSTOMER_USDT,
            detail:
              s?.customerUsdtMinor !== null && s
                ? `Customer holds ${usdt(s.customerUsdtMinor ?? 0n)}. They pay in USDT and never need WBT.`
                : '',
            action: (
              <Button
                size="sm"
                variant="dark"
                disabled={!!working}
                onClick={act('customer', 'USDT sent to your test customer', () =>
                  chain.localFork
                    ? chain.localFaucet('customer', { usdt: '25' })
                    : chain.swapToUsdt(chain.customer!, parseEther('0.1')),
                )}
              >
                {chain.localFork ? 'Give 25 test USDT' : 'Swap 0.1 WBT to them'}
              </Button>
            ),
          },
        ]
      : []),
  ];
  const remaining = steps.filter(step => !step.done).length;
  if (compact && s && remaining === 0) return null;
  return (
    <Card>
      <CardHeader
        title="Set up live payments"
        description={
          s
            ? remaining
              ? `${remaining} of ${steps.length} steps left. Each is a transaction from your wallet.`
              : 'Ready: customers can pay with no gas.'
            : 'Reading your wallet…'
        }
        action={
          <Button size="sm" variant="ghost" onClick={() => void refresh()} aria-label="Refresh">
            <IconRefresh className="size-4" />
          </Button>
        }
      />
      <CardBody className="grid gap-3">
        {steps.map(step => (
          <div
            key={step.id}
            className={cn(
              'flex flex-wrap items-center gap-3 rounded-2xl border border-border p-3',
              step.done && 'opacity-70',
            )}
          >
            {step.done ? (
              <IconCircleCheckFilled className="size-5 shrink-0 text-success" />
            ) : (
              <IconCircleDashed className="size-5 shrink-0 text-muted-foreground" />
            )}
            <div className="min-w-0 flex-1">
              <p className="font-medium">{step.title}</p>
              {step.detail && <p className="text-sm text-muted-foreground">{step.detail}</p>}
            </div>
            {!step.done && (
              <div className="shrink-0">
                {working === step.id ? (
                  <Button size="sm" disabled>
                    Waiting for the chain…
                  </Button>
                ) : (
                  step.action
                )}
              </div>
            )}
          </div>
        ))}
        {error && <Notice tone="danger">{error}</Notice>}
      </CardBody>
    </Card>
  );
}
