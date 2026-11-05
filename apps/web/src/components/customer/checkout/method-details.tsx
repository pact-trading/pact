'use client';

import { IconFingerprint, IconInfoCircle } from '@tabler/icons-react';
import QRCode from 'qrcode';
import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import type { CardDetails, CheckoutMethodOption } from '@/server/data/types';
import { cn } from '@/lib/cn';
import { Button } from '../../ui/button';
import { CopyButton } from '../../ui/copy-button';
import { Disclosure } from '../../ui/disclosure';
import { Notice } from '../../ui/notice';
import {
  cardErrors,
  DECLINE_CARD_LABEL,
  formatCardNumber,
  formatExpiry,
  type CardErrors,
} from './card-rules';
import { checkoutInput } from './panel';
import { radius } from './frame';

type BankOption = Extract<CheckoutMethodOption, { kind: 'bank' }>;
type WalletOption = Extract<CheckoutMethodOption, { kind: 'wallet' }>;

function Rows({ rows }: { rows: Array<{ label: string; value: ReactNode; copy?: string }> }) {
  return (
    <dl className={cn('grid gap-2.5 bg-raised px-4 py-3.5 text-sm', radius.box)}>
      {rows.map(row => (
        <div key={row.label} className="flex items-center justify-between gap-4">
          <dt className="shrink-0 text-muted-foreground">{row.label}</dt>
          <dd className="flex min-w-0 items-center gap-1 text-right font-medium [overflow-wrap:anywhere]">
            {row.value}
            {row.copy && <CopyButton value={row.copy} label={`Copy ${row.label.toLowerCase()}`} />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** The payer's Pact balance: no fees, one passkey confirmation. */
export function AccountDetail({
  balance,
  brandName,
  shortfall,
}: {
  balance: string | null;
  brandName: string;
  /** Shown when the balance is short, e.g. the add-funds box. */
  shortfall?: ReactNode;
}) {
  return (
    <div className="grid gap-3">
      <Rows
        rows={[
          ...(balance !== null ? [{ label: 'Balance', value: balance }] : []),
          { label: 'Fees', value: `None, ${brandName || 'the business'} covers them` },
        ]}
      />
      {shortfall}
      <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
        <IconFingerprint aria-hidden className="mt-0.5 size-4 shrink-0" />
        You confirm once with your passkey. Nothing to install.
      </p>
    </div>
  );
}

export const emptyCard: CardDetails = { name: '', number: '', expiry: '', cvc: '' };

/**
 * A real card form with inline validation. Nothing is prefilled. It only checks what was typed;
 * the data source validates again and decides whether the card is charged or declined.
 */
export function CardForm({
  id,
  value,
  onChange,
  onSubmit,
  disabled,
  badge,
}: {
  id: string;
  value: CardDetails;
  onChange: (value: CardDetails) => void;
  onSubmit: (value: CardDetails) => void;
  disabled?: boolean;
  /** "Demo" or "Preview": what this form really does. */
  badge: 'Demo' | 'Preview';
}) {
  const ids = useId();
  const refs = useRef<Partial<Record<keyof CardDetails, HTMLInputElement | null>>>({});
  const [touched, setTouched] = useState<Partial<Record<keyof CardDetails, boolean>>>({});
  const [submitted, setSubmitted] = useState(false);
  const errors: CardErrors = cardErrors(value, Date.now());
  const shown = (field: keyof CardDetails) => (submitted || touched[field] ? errors[field] : undefined);
  const set = (field: keyof CardDetails, next: string) => onChange({ ...value, [field]: next });
  const field = (
    name: keyof CardDetails,
    label: string,
    input: Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'value' | 'onChange'> & {
      format?: (raw: string) => string;
    },
  ) => {
    const { format, ...rest } = input;
    const error = shown(name);
    return (
      <div className="grid gap-1.5">
        <label htmlFor={`${ids}-${name}`} className="text-[13px] font-medium">
          {label}
        </label>
        <input
          ref={element => {
            refs.current[name] = element;
          }}
          id={`${ids}-${name}`}
          value={value[name]}
          onChange={event => set(name, format ? format(event.target.value) : event.target.value)}
          onBlur={() => setTouched(current => ({ ...current, [name]: true }))}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${ids}-${name}-error` : undefined}
          disabled={disabled}
          className={checkoutInput}
          {...rest}
        />
        {error && (
          <p id={`${ids}-${name}-error`} className="text-[13px] text-destructive">
            {error}
          </p>
        )}
      </div>
    );
  };
  return (
    <form
      id={id}
      noValidate
      className="grid gap-3"
      aria-label="Card details"
      onSubmit={event => {
        event.preventDefault();
        setSubmitted(true);
        const first = (['name', 'number', 'expiry', 'cvc'] as const).find(name => errors[name]);
        if (first) return refs.current[first]?.focus();
        onSubmit(value);
      }}
    >
      {field('name', 'Name on card', { autoComplete: 'cc-name', placeholder: 'Full name' })}
      {field('number', 'Card number', {
        autoComplete: 'cc-number',
        inputMode: 'numeric',
        placeholder: '1234 1234 1234 1234',
        format: formatCardNumber,
      })}
      <div className="grid grid-cols-2 gap-3">
        {field('expiry', 'Expiry', {
          autoComplete: 'cc-exp',
          inputMode: 'numeric',
          placeholder: 'MM / YY',
          format: formatExpiry,
        })}
        {field('cvc', 'Security code', {
          autoComplete: 'cc-csc',
          inputMode: 'numeric',
          placeholder: 'CVC',
          maxLength: 4,
          format: raw => raw.replace(/\D/g, '').slice(0, 4),
        })}
      </div>
      <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
        <IconInfoCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          {badge === 'Demo'
            ? 'Demo card payment: no real card is charged. Any valid test number works, such as 4242 4242 4242 4242, with a future expiry.'
            : 'Preview: no card is charged.'}{' '}
          The test card {DECLINE_CARD_LABEL} is always declined.
        </span>
      </p>
    </form>
  );
}

/** Where to send a bank transfer. The reference matches it to this checkout. */
export function BankDetails({
  option,
  amount,
  badge,
}: {
  option: BankOption;
  amount: string;
  badge: string;
}) {
  return (
    <div className="grid gap-3">
      <Rows
        rows={[
          { label: 'Amount', value: amount },
          { label: 'Pay to', value: option.payee },
          { label: 'Bank', value: option.bank },
          { label: 'Account', value: option.accountNumber, copy: option.accountNumber },
          { label: 'Reference', value: option.reference, copy: option.reference },
        ]}
      />
      <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
        <IconInfoCircle aria-hidden className="mt-0.5 size-4 shrink-0" />
        {badge === 'Demo'
          ? 'Demo bank transfer: no bank is involved. Include the reference, then confirm below; this sandbox settles it in a few seconds.'
          : 'Preview: these bank details are samples.'}
      </p>
    </div>
  );
}

function QrImage({ value }: { value: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let live = true;
    QRCode.toString(value, {
      type: 'svg',
      margin: 0,
      errorCorrectionLevel: 'M',
      color: { dark: '#0e1116', light: '#ffffff' },
    })
      .then(markup => live && setSvg(markup))
      .catch(() => live && setSvg(''));
    return () => {
      live = false;
    };
  }, [value]);
  return (
    <div
      role="img"
      aria-label="QR code of the deposit address"
      className="size-36 shrink-0 rounded-xl bg-white p-2.5 [&_svg]:h-full [&_svg]:w-full"
      dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
    />
  );
}

/**
 * "Pay from your own wallet", behind a disclosure so the main checkout stays free of network
 * words. The address is derived for this checkout by the data source.
 */
export function WalletDeposit({
  option,
  amountUsdt,
  onConfirm,
  busy,
  disabled,
  error,
}: {
  option: WalletOption;
  /** "490.00 USDT" */
  amountUsdt: string;
  onConfirm: () => void;
  busy?: boolean;
  disabled?: boolean;
  error?: string | null;
}) {
  return (
    <Disclosure
      className={radius.box}
      summary={
        <span className="flex items-center gap-2">
          Pay from your own wallet
          <span className="rounded-full border border-border px-2 text-[12px] font-medium text-subtle-foreground">
            Demo
          </span>
        </span>
      }
    >
      <div className="grid gap-4 py-1">
        <p className="text-[13px] text-muted-foreground">
          Send exactly this amount from any wallet you control. Only {option.token} on {option.network}{' '}
          arrives; anything else is lost.
        </p>
        <div className="flex flex-wrap items-start gap-4">
          <QrImage value={option.depositAddress} />
          <dl className="grid min-w-0 flex-1 basis-48 gap-3 text-sm">
            <div className="grid gap-0.5">
              <dt className="text-[13px] text-muted-foreground">Send exactly</dt>
              <dd className="flex items-center gap-1 text-lg font-semibold tabular-nums">
                {amountUsdt}
                <CopyButton value={amountUsdt.replace(/[^\d.]/g, '')} label="Copy amount" />
              </dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-[13px] text-muted-foreground">Network</dt>
              <dd className="font-medium">{option.network}</dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-[13px] text-muted-foreground">To this address</dt>
              <dd className="flex items-start gap-1">
                <code className="min-w-0 font-mono text-[12px] leading-relaxed break-all">
                  {option.depositAddress}
                </code>
                <CopyButton value={option.depositAddress} label="Copy address" />
              </dd>
            </div>
          </dl>
        </div>
        <p className="text-[13px] text-muted-foreground">
          Demo: nothing is sent on chain and no transfer is detected. When you confirm, this sandbox settles
          the payment in a few seconds.
        </p>
        {error && <Notice tone="danger">{error}</Notice>}
        <Button variant="dark" onClick={onConfirm} disabled={disabled || busy} className="justify-self-start">
          {busy ? 'Confirming…' : 'I’ve sent the payment'}
        </Button>
      </div>
    </Disclosure>
  );
}
