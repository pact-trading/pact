'use client';

import { IconFingerprint } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { preparePurchase, submitPurchase } from '@/server/actions/financing';
import { fromMinor, toMinor, usd } from '@/lib/format';
import { usePactAuth } from '../auth/auth-context';
import { useSignedAction } from '../auth/use-signed-action';
import { Button } from '../ui/button';
import { AmountInput, Field } from '../ui/field';
import { Notice } from '../ui/notice';
import { useToast } from '../ui/toast';

const parse = (value: string) => {
  try {
    return toMinor(value || '0');
  } catch {
    return null;
  }
};

/**
 * Buys all or part of a listed invoice. The server prepares the purchase and the passkey sheet shows
 * its terms; nothing is paid until the investor confirms there. The contract refuses a buyer who is
 * not approved, and the refusal shows here.
 */
export function BuyInvoice({
  invoiceId,
  number,
  discountBps,
  remainingMinor,
  minimumShareMinor,
  availableMinor,
  approved,
}: {
  invoiceId: string;
  number: string;
  discountBps: number;
  remainingMinor: string;
  minimumShareMinor: string;
  availableMinor: string;
  approved: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const signed = useSignedAction();
  const wallet = usePactAuth().mode === 'live';
  const [amount, setAmount] = useState(fromMinor(remainingMinor));
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const remaining = BigInt(remainingMinor);
  const face = parse(amount);
  const valid =
    face !== null &&
    face > 0n &&
    face <= remaining &&
    (face >= BigInt(minimumShareMinor) || face === remaining);
  const price = valid ? face - (face * BigInt(discountBps)) / 10_000n : 0n;
  const short = valid && BigInt(availableMinor) < price;
  const hint = !valid
    ? `Between ${usd(minimumShareMinor)} and ${usd(remaining)} of face value`
    : `You pay ${usd(price)} now and receive ${usd(face)} when the customer pays`;
  return (
    <div className="grid gap-3">
      <Field
        label="Face value to buy"
        hint={hint}
        error={face === null ? 'Enter an amount in dollars' : undefined}
      >
        {id => (
          <AmountInput
            id={id}
            value={amount}
            onChange={e => setAmount(e.target.value)}
            aria-invalid={!valid || undefined}
          />
        )}
      </Field>
      <Button
        variant="dark"
        size="lg"
        className="w-full"
        disabled={pending || !valid || short}
        onClick={() =>
          start(async () => {
            setError('');
            const result = await signed(
              () => preparePurchase(invoiceId, face!.toString()),
              (token, signature) => submitPurchase(token, signature),
            );
            if (result.ok) {
              toast(`You bought ${usd(face!)} of ${number} for ${usd(price)}`);
              router.refresh();
            } else if (result.error.code !== 'cancelled') {
              setError(result.error.message);
              router.refresh();
            }
          })
        }
      >
        <IconFingerprint className="size-5" />
        {pending
          ? wallet
            ? 'Confirm in your wallet…'
            : 'Waiting for your passkey…'
          : valid
            ? `Buy for ${usd(price)}`
            : 'Buy'}
      </Button>
      {short && (
        <Notice tone="warning">
          You have {usd(availableMinor)} available, less than the {usd(price)} price.
        </Notice>
      )}
      {!approved && (
        <Notice tone="warning" title="You are not an approved investor">
          The receivables contract only lets approved investors hold this token, so it will refuse the
          purchase.
        </Notice>
      )}
      {error && (
        <Notice tone="danger" title="Not bought">
          {error}
        </Notice>
      )}
      <p className="text-[13px] text-muted-foreground">
        {wallet
          ? 'You sign the purchase (and, the first time, a USDT permit for the price). Pact submits it and pays the gas.'
          : 'You confirm the terms with your passkey.'}{' '}
        If the customer pays late you receive a late fee; if they never pay, you receive the reserve and then
        the business’s buy-back. Pact does not guarantee either.
      </p>
    </div>
  );
}
