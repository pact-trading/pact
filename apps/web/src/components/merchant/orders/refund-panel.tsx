'use client';

import { IconReceiptRefund } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { prepareRefund, submitRefund } from '@/server/actions/merchant';
import { useSignedAction } from '../../auth/use-signed-action';
import { fromMinor, toMinor, usd } from '@/lib/format';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { AmountInput, Field, Select } from '../../ui/field';
import { Notice } from '../../ui/notice';
import { useToast } from '../../ui/toast';
import { RadioCards } from '../../portal/radio-cards';

const reasons = [
  'Requested by customer',
  'Service adjustment',
  'Duplicate payment',
  'Not delivered',
  'Goodwill credit',
];

/** One-click full or partial refund. The contract caps refunds at what was captured. */
export function RefundPanel({
  orderId,
  refundableMinor,
  fullyRefunded,
  windowOpen,
  readOnly,
}: {
  orderId: string;
  refundableMinor: string;
  fullyRefunded: boolean;
  windowOpen: boolean;
  readOnly: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const signed = useSignedAction();
  const [amount, setAmount] = useState(fromMinor(refundableMinor));
  const [reason, setReason] = useState(reasons[0]);
  const [error, setError] = useState<{ title: string; body: string } | null>(null);
  const [showAnyway, setShowAnyway] = useState(false);
  const [pending, start] = useTransition();

  if (readOnly)
    return <p className="text-sm text-muted-foreground">Refunds can only be issued by the business owner.</p>;
  if (fullyRefunded && !showAnyway)
    return (
      <div className="grid gap-3">
        <Notice tone="success" title="Fully refunded">
          Nothing is left to refund. Any further refund is refused by the payment contract and recorded.
        </Notice>
        <Button
          size="sm"
          className="justify-self-start"
          onClick={() => {
            setShowAnyway(true);
            setAmount('1.00');
          }}
        >
          Try another refund
        </Button>
      </div>
    );

  const submit = () =>
    start(async () => {
      setError(null);
      let minor: bigint;
      try {
        minor = toMinor(amount || '0');
      } catch {
        return setError({ title: 'Check the amount', body: 'Use a number like 120 or 120.50.' });
      }
      const result = await signed(
        () => prepareRefund(orderId, minor.toString(), reason),
        (token, signature) => submitRefund(token, signature),
      );
      if (result.ok) {
        toast(`Refund of ${usd(minor)} confirmed`);
        setShowAnyway(false);
        router.refresh();
      } else if (result.error.code !== 'cancelled') {
        const refused = ['refund_limit', 'refund_window_closed'].includes(result.error.code);
        setError({
          title: refused ? 'Refused by the payment contract' : 'Refund not sent',
          body: result.error.message,
        });
        if (refused) router.refresh();
      }
    });

  return (
    <form
      className="grid gap-4"
      onSubmit={event => {
        event.preventDefault();
        submit();
      }}
    >
      {!windowOpen && (
        <Notice tone="warning">
          The refund window has closed. A refund now will be refused by the contract.
        </Notice>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Amount" hint={`Up to ${usd(refundableMinor)} is refundable.`}>
          {id => (
            <AmountInput
              id={id}
              value={amount}
              onChange={e => /^\d*(\.\d{0,6})?$/.test(e.target.value) && setAmount(e.target.value)}
            />
          )}
        </Field>
        <Field label="Reason">
          {id => (
            <Select id={id} value={reason} onChange={e => setReason(e.target.value)}>
              {reasons.map(r => (
                <option key={r}>{r}</option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="dark" disabled={pending}>
          <IconReceiptRefund className="size-4.5" />
          {pending ? 'Refunding…' : `Refund ${amount ? usd(toMinorSafe(amount)) : ''}`}
        </Button>
        {BigInt(refundableMinor) > 0n && amount !== fromMinor(refundableMinor) && (
          <Button size="sm" variant="ghost" onClick={() => setAmount(fromMinor(refundableMinor))}>
            Full remaining
          </Button>
        )}
      </div>
      {error && (
        <Notice tone="danger" title={error.title}>
          {error.body}
        </Notice>
      )}
      <p className="text-[13px] text-muted-foreground">
        You confirm with your passkey. The relayer sends the refund and your gas tank pays the network fee.
        The customer sees it in their portal right away.
      </p>
    </form>
  );
}

function toMinorSafe(value: string) {
  try {
    return toMinor(value);
  } catch {
    return 0n;
  }
}

type RefundError = { title: string; body: string };

/**
 * Header refund action: a dialog with Full or Partial, the amount still refundable and a
 * reason. It closes while the passkey sheet is up and reopens with the error if one comes back.
 */
export function RefundDialog({
  orderId,
  refundableMinor,
  totalMinor,
  windowOpen,
  disabled,
}: {
  orderId: string;
  refundableMinor: string;
  totalMinor: string;
  windowOpen: boolean;
  disabled?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const signed = useSignedAction();
  const refundable = BigInt(refundableMinor);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'full' | 'partial'>('full');
  // Holds what the merchant typed, as a plain decimal. Formatted amounts never go back in.
  const [partial, setPartial] = useState('');
  const [reason, setReason] = useState(reasons[0]);
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<RefundError | null>(null);
  const [pending, start] = useTransition();

  const partialMinor = parseAmount(partial);
  const amountMinor = kind === 'full' ? refundable : partialMinor;
  const amountError =
    kind === 'full'
      ? ''
      : partialMinor === null
        ? 'Enter an amount like 120 or 120.50.'
        : partialMinor <= 0n
          ? 'Enter an amount above $0.'
          : partialMinor > refundable
            ? `At most ${usd(refundable)} can be refunded.`
            : '';

  const reset = () => {
    setKind('full');
    setPartial('');
    setReason(reasons[0]);
    setTried(false);
    setError(null);
  };
  const submit = () => {
    setTried(true);
    if (amountError || amountMinor === null) return;
    const minor = amountMinor;
    setOpen(false);
    start(async () => {
      const result = await signed(
        () => prepareRefund(orderId, minor.toString(), reason),
        (token, signature) => submitRefund(token, signature),
      );
      if (result.ok) {
        toast(`Refund of ${usd(minor)} confirmed`);
        reset();
        router.refresh();
        return;
      }
      if (result.error.code === 'cancelled') {
        setOpen(true);
        return;
      }
      const refused = ['refund_limit', 'refund_window_closed'].includes(result.error.code);
      setError({
        title: refused ? 'Refused by the payment contract' : 'Refund not sent',
        body: result.error.message,
      });
      setOpen(true);
      if (refused) router.refresh();
    });
  };

  return (
    <>
      <Button
        size="sm"
        variant="primary"
        disabled={disabled || pending || refundable === 0n}
        title={refundable === 0n ? 'Nothing left to refund' : undefined}
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        <IconReceiptRefund className="size-4" />
        {pending ? 'Refunding…' : 'Refund'}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Refund payment"
        description={`${usd(refundable)} of ${usd(totalMinor)} can still be refunded. It goes back to the customer’s account in one transaction.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="dark" onClick={submit} disabled={pending}>
              <IconReceiptRefund className="size-4.5" />
              {amountMinor !== null && amountMinor > 0n ? `Refund ${usd(amountMinor)}` : 'Refund'}
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
          {!windowOpen && (
            <Notice tone="warning">
              The refund window has closed. A refund now will be refused by the contract.
            </Notice>
          )}
          <RadioCards
            legend="Refund type"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'full', title: 'Full', body: `The remaining ${usd(refundable)}` },
              { value: 'partial', title: 'Partial', body: 'Choose an amount' },
            ]}
          />
          {kind === 'partial' && (
            <Field
              label="Refund amount"
              hint={`Up to ${usd(refundable)}.`}
              error={tried && amountError ? amountError : undefined}
            >
              {id => (
                <AmountInput
                  id={id}
                  value={partial}
                  placeholder={fromMinor(refundable)}
                  aria-invalid={tried && Boolean(amountError)}
                  onChange={e => /^\d*(\.\d{0,6})?$/.test(e.target.value) && setPartial(e.target.value)}
                />
              )}
            </Field>
          )}
          <Field label="Reason">
            {id => (
              <Select id={id} value={reason} onChange={e => setReason(e.target.value)}>
                {reasons.map(r => (
                  <option key={r}>{r}</option>
                ))}
              </Select>
            )}
          </Field>
          {error && (
            <Notice tone="danger" title={error.title}>
              {error.body}
            </Notice>
          )}
          <p className="text-[13px] text-muted-foreground">
            You confirm with your passkey next. Your gas tank pays the network fee.
          </p>
        </form>
      </Dialog>
    </>
  );
}

function parseAmount(value: string): bigint | null {
  if (!value.trim()) return null;
  try {
    return toMinor(value);
  } catch {
    return null;
  }
}
