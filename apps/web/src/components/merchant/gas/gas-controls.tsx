'use client';

import { IconDroplet, IconGasStation } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { GasPolicy } from '@pactagent/core/platform-types';
import { claimFaucet, depositGas, updateGasPolicy } from '@/server/actions/merchant';
import { usePactAuth } from '@/components/auth/auth-context';
import { useMerchantChain } from '../live/merchant-chain';
import { fromMinor, toMinor, wbt } from '@/lib/format';
import { cn } from '@/lib/cn';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { AmountInput, Field, Input } from '../../ui/field';
import { Notice } from '../../ui/notice';
import { useToast } from '../../ui/toast';

export function FaucetButton({ nextClaimAt, disabled }: { nextClaimAt: string | null; disabled?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState('');
  const live = usePactAuth().live;
  const chain = useMerchantChain();
  if (live)
    return (
      <div className="grid gap-2">
        {chain.localFork ? (
          <Button
            variant="dark"
            className="justify-self-start"
            disabled={pending || disabled}
            onClick={() =>
              start(async () => {
                setError('');
                try {
                  // The real faucet pays the wallet; the wallet then deposits into its own tank.
                  await chain.localFaucet('merchant', { wbt: '0.5' });
                  await chain.deposit(10n ** 18n / 2n);
                  toast('0.5 WBT added to your gas tank');
                  router.refresh();
                } catch (e) {
                  setError(e instanceof Error ? e.message.split('\n')[0] : 'The top-up failed.');
                }
              })
            }
          >
            <IconDroplet className="size-4.5" />
            {pending ? 'Topping up…' : 'Top up 0.5 WBT from the test faucet'}
          </Button>
        ) : (
          <Button
            variant="dark"
            className="justify-self-start"
            onClick={() => window.open(chain.faucetUrl, '_blank', 'noopener')}
          >
            <IconDroplet className="size-4.5" /> Claim WBT from the faucet
          </Button>
        )}
        <p className="text-[13px] text-muted-foreground">
          {chain.localFork
            ? 'Local fork: the test faucet pays your wallet, then your wallet deposits into the tank.'
            : 'The faucet pays your wallet. Then deposit it into the tank.'}
        </p>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    );
  return (
    <div className="grid gap-2">
      <Button
        variant="dark"
        className="justify-self-start"
        disabled={pending || disabled || Boolean(nextClaimAt)}
        onClick={() =>
          start(async () => {
            setError('');
            const result = await claimFaucet();
            if (!result.ok) return setError(result.error.message);
            toast('0.5 WBT added to your gas tank');
            router.refresh();
          })
        }
      >
        <IconDroplet className="size-4.5" />
        {pending ? 'Claiming…' : 'Top up 0.5 WBT from the faucet'}
      </Button>
      {nextClaimAt && (
        <p className="text-[13px] text-muted-foreground">
          Next claim available {new Date(nextClaimAt).toUTCString().slice(5, 22)} UTC.
        </p>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

export function GasPolicyForm({ policy, readOnly }: { policy: GasPolicy; readOnly: boolean }) {
  const live = Boolean(usePactAuth().live);
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState(policy.mode);
  const [surcharge, setSurcharge] = useState(fromMinor(policy.surchargeMinor));
  const [perPayer, setPerPayer] = useState(String(policy.perPayerDailyActions));
  const [alertDays, setAlertDays] = useState(String(policy.lowRunwayAlertDays));
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      setError('');
      const result = await updateGasPolicy({
        mode,
        surchargeMinor: toMinor(surcharge || '0').toString(),
        ...(live ? {} : { perPayerDailyActions: Number(perPayer) }),
        lowRunwayAlertDays: Number(alertDays),
      });
      if (!result.ok) return setError(result.error.message);
      toast('Gas policy saved');
      router.refresh();
    });
  const option = (value: GasPolicy['mode'], title: string, body: string) => (
    <label
      className={cn(
        'flex cursor-pointer gap-3 rounded-2xl border p-4 transition-colors',
        mode === value ? 'border-foreground bg-raised' : 'border-border hover:border-foreground/30',
      )}
    >
      <input
        type="radio"
        name="gas-mode"
        className="mt-1 accent-[var(--pact-ink)]"
        checked={mode === value}
        onChange={() => setMode(value)}
        disabled={readOnly}
      />
      <span>
        <span className="block font-medium">{title}</span>
        <span className="text-sm text-muted-foreground">{body}</span>
      </span>
    </label>
  );
  return (
    <form
      className="grid gap-4"
      onSubmit={event => {
        event.preventDefault();
        save();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {option('absorb', 'Absorb gas', 'Your tank pays. Customers see the exact price.')}
        {option('surcharge', 'Add to price', 'A small fixed amount is added to each payment to cover gas.')}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {mode === 'surcharge' && (
          <Field label="Surcharge per payment">
            {id => (
              <AmountInput
                id={id}
                value={surcharge}
                onChange={e => /^\d*(\.\d{0,6})?$/.test(e.target.value) && setSurcharge(e.target.value)}
                disabled={readOnly}
              />
            )}
          </Field>
        )}
        <Field label="Sponsored actions per payer per day" hint="Enforced in the Router contract">
          {id => (
            <Input
              id={id}
              inputMode="numeric"
              value={perPayer}
              onChange={e => /^\d{0,3}$/.test(e.target.value) && setPerPayer(e.target.value)}
              disabled={readOnly || live}
            />
          )}
        </Field>
        <Field label="Alert below (days of runway)">
          {id => (
            <Input
              id={id}
              inputMode="numeric"
              value={alertDays}
              onChange={e => /^\d{0,2}$/.test(e.target.value) && setAlertDays(e.target.value)}
              disabled={readOnly}
            />
          )}
        </Field>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {!readOnly && (
        <Button type="submit" variant="dark" className="justify-self-start" disabled={pending}>
          {pending ? 'Saving…' : 'Save policy'}
        </Button>
      )}
    </form>
  );
}

const presets = ['0.1', '0.5', '1'];

/** WBT typed as a decimal, in wei; null when it is not a valid amount. */
function toWei(value: string): bigint | null {
  if (!value.trim()) return null;
  try {
    return toMinor(value, 18);
  } catch {
    return null;
  }
}

/** Deposit WBT into the gas tank from the payout account. Demo only: the API has no endpoint yet. */
export function DepositGasButton({
  balanceWei,
  perPaymentWei,
  variant = 'primary',
  size = 'sm',
}: {
  balanceWei: string;
  /** Average gas of a sponsored payment, to show what the deposit buys. */
  perPaymentWei?: string | null;
  variant?: 'primary' | 'dark' | 'secondary';
  size?: 'sm' | 'md';
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('0.5');
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const live = Boolean(usePactAuth().live);
  const chain = useMerchantChain();
  const wei = toWei(amount);
  const amountError =
    wei === null
      ? 'Enter an amount like 0.5.'
      : wei < 10n ** 15n
        ? 'Deposit at least 0.001 WBT.'
        : wei > 10n * 10n ** 18n
          ? 'The demo accepts at most 10 WBT per deposit.'
          : '';
  const perPayment = perPaymentWei ? BigInt(perPaymentWei) : 0n;
  const close = () => {
    setOpen(false);
    setTried(false);
    setError('');
  };
  const submit = () =>
    start(async () => {
      setTried(true);
      setError('');
      if (amountError || wei === null) return;
      if (live) {
        try {
          await chain.deposit(wei);
        } catch (e) {
          const message = e instanceof Error ? e.message.split('\n')[0] : 'The deposit failed.';
          return /reject|denied|cancel/i.test(message) ? undefined : setError(message);
        }
      } else {
        const result = await depositGas(wei.toString());
        if (!result.ok) return setError(result.error.message);
      }
      toast(`${wbt(wei, 4)} deposited into your gas tank`);
      close();
      router.refresh();
    });
  return (
    <>
      <Button
        variant={variant}
        size={size}
        onClick={() => {
          setAmount('0.5');
          setOpen(true);
        }}
      >
        <IconGasStation className="size-4" />
        Deposit gas
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title={
          <span className="flex items-center gap-2">
            Deposit gas {!live && <Badge tone="outline">Demo</Badge>}
          </span>
        }
        description={
          live
            ? 'Sends WBT from your wallet into your gas tank. Customers never see or need it.'
            : 'Moves WBT from your payout account into the gas tank. Customers never see or need it.'
        }
        footer={
          <>
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button variant="dark" onClick={submit} disabled={pending}>
              {pending ? 'Depositing…' : wei && !amountError ? `Deposit ${wbt(wei, 4)}` : 'Deposit'}
            </Button>
          </>
        }
      >
        <form
          className="grid gap-4"
          onSubmit={event => {
            event.preventDefault();
            submit();
          }}
        >
          <Field
            label="Amount (WBT)"
            hint="Up to 10 WBT at a time."
            error={tried && amountError ? amountError : undefined}
          >
            {id => (
              <Input
                id={id}
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                aria-invalid={tried && Boolean(amountError)}
                onChange={e => /^\d*(\.\d{0,6})?$/.test(e.target.value) && setAmount(e.target.value)}
              />
            )}
          </Field>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Quick amounts">
            {presets.map(value => (
              <Button
                key={value}
                size="sm"
                variant={amount === value ? 'dark' : 'secondary'}
                aria-pressed={amount === value}
                onClick={() => setAmount(value)}
              >
                {value} WBT
              </Button>
            ))}
          </div>
          <dl className="divide-y divide-border-subtle rounded-2xl border border-border text-sm">
            <div className="flex justify-between gap-3 px-4 py-3">
              <dt className="text-muted-foreground">Balance now</dt>
              <dd className="font-medium">{wbt(balanceWei)}</dd>
            </div>
            <div className="flex justify-between gap-3 px-4 py-3">
              <dt className="text-muted-foreground">After the deposit</dt>
              <dd className="font-medium">
                {wei !== null && !amountError ? wbt(BigInt(balanceWei) + wei) : '—'}
              </dd>
            </div>
            {perPayment > 0n && wei !== null && !amountError && (
              <div className="flex justify-between gap-3 px-4 py-3">
                <dt className="text-muted-foreground">Covers about</dt>
                <dd className="font-medium">{(wei / perPayment).toLocaleString('en-US')} more payments</dd>
              </div>
            )}
          </dl>
          {error && <Notice tone="danger">{error}</Notice>}
        </form>
      </Dialog>
    </>
  );
}
