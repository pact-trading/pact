'use client';

import {
  IconArrowRight,
  IconBuildingBank,
  IconCreditCard,
  IconFingerprint,
  IconLoader2,
  IconUserCircle,
  IconWallet,
} from '@tabler/icons-react';
import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Notice } from '../../ui/notice';
import { BackControl, type CheckoutBack } from './back-control';
import { radius } from './frame';

/** Every state a checkout can show. The Playground's step select offers the same list. */
export type CheckoutStep =
  'information' | 'payment' | 'processing' | 'success' | 'refund' | 'expired' | 'failed';

/** Inputs inside the payment card follow the checkout's corner radius. */
export const checkoutInput = cn(
  'h-11 w-full border border-input bg-card px-3.5 text-[15px] text-foreground transition-colors placeholder:text-muted-foreground/70 focus-visible:border-foreground focus-visible:outline-none read-only:bg-raised read-only:text-subtle-foreground aria-invalid:border-destructive',
  radius.control,
);

const methodIcons = {
  account: IconUserCircle,
  card: IconCreditCard,
  bank: IconBuildingBank,
  wallet: IconWallet,
};

export interface PanelMethod {
  id: string;
  title: string;
  description: string;
  icon: keyof typeof methodIcons;
  /** "Demo" in the sandbox, "Preview" in the Playground. */
  badge?: string;
  /** Shown under the method while it is selected. */
  detail?: ReactNode;
}

export interface PanelAction {
  label: string;
  onClick?: () => void;
  type?: 'button' | 'submit';
  /** Submits this form, e.g. the card form. */
  form?: string;
  disabled?: boolean;
  busy?: boolean;
  busyLabel?: string;
  icon?: 'passkey' | 'none';
}

export interface CheckoutFormProps {
  email: string;
  /** Makes the email editable, for sign-in and the Playground. */
  onEmailChange?: (value: string) => void;
  contactTitle?: string;
  contactLead?: ReactNode;
  /** Phone, address and other contact fields. */
  contactExtra?: ReactNode;
  methods?: PanelMethod[];
  selected?: string;
  onSelect?: (id: string) => void;
  /** Below the method list, e.g. the own-wallet disclosure. */
  methodsExtra?: ReactNode;
  /** Above the "Pay today" row, e.g. the subscription's consent. */
  before?: ReactNode;
  payToday?: string;
  payNote?: ReactNode;
  action?: PanelAction | null;
  /** Under the primary button, e.g. "Use a passkey". */
  secondary?: ReactNode;
  note?: ReactNode;
  error?: string | null;
  back?: CheckoutBack;
  /** Information step: what the primary button does. Continuing never pays. */
  onSubmit?: () => void;
}

export type CheckoutPanelProps =
  | ({ step: 'information' | 'payment' } & CheckoutFormProps)
  | { step: 'processing'; title: string; hint: ReactNode; action?: ReactNode }
  | { step: 'success' | 'refund'; receipt: ReactNode; actions?: ReactNode; extra?: ReactNode }
  | { step: 'expired' | 'failed'; title: string; message: ReactNode; action?: ReactNode };

/** The right-hand payment card, for every step. Shared by the real checkout and the Playground. */
export function CheckoutPanel(props: CheckoutPanelProps) {
  switch (props.step) {
    case 'information':
    case 'payment':
      return <CheckoutForm {...props} />;
    case 'processing':
      return (
        <div className="grid justify-items-center gap-3 py-10 text-center" role="status">
          <IconLoader2 aria-hidden className="size-10 animate-spin text-muted-foreground" />
          <h2 className="text-xl font-semibold">{props.title}</h2>
          <div className="max-w-xs text-[15px] text-muted-foreground">{props.hint}</div>
          {props.action}
        </div>
      );
    case 'success':
    case 'refund':
      return (
        <div className="grid gap-5">
          {props.receipt}
          {props.actions && <div className="flex flex-wrap gap-2">{props.actions}</div>}
          {props.extra}
        </div>
      );
    default:
      return (
        <div className="grid gap-4">
          <Notice tone={props.step === 'failed' ? 'danger' : 'warning'} title={props.title}>
            {props.message}
          </Notice>
          {props.action}
        </div>
      );
  }
}

function CheckoutForm({ step, ...p }: { step: 'information' | 'payment' } & CheckoutFormProps) {
  const emailId = useId();
  const group = useId();
  const action = p.action;
  const body = (
    <>
      <section className="grid gap-4" aria-labelledby={`${emailId}-title`}>
        <div className="grid gap-1">
          <h2 id={`${emailId}-title`} className="text-base font-semibold">
            {p.contactTitle ?? 'Contact information'}
          </h2>
          {p.contactLead && <p className="text-sm text-muted-foreground">{p.contactLead}</p>}
        </div>
        <div className="grid gap-1.5">
          <label htmlFor={emailId} className="text-[13px] font-medium">
            Email
          </label>
          {p.onEmailChange ? (
            <input
              id={emailId}
              type="email"
              required
              autoComplete="email"
              value={p.email}
              onChange={event => p.onEmailChange?.(event.target.value)}
              placeholder="you@example.com"
              className={checkoutInput}
            />
          ) : (
            <input id={emailId} type="email" readOnly value={p.email} className={checkoutInput} />
          )}
        </div>
        {p.contactExtra}
      </section>
      {step === 'payment' && p.methods && p.methods.length > 0 && (
        <fieldset className="grid gap-3">
          <legend className="mb-3 text-base font-semibold">Payment method</legend>
          <div className="grid gap-2.5" data-testid="checkout-methods">
            {p.methods.map(method => {
              const on = method.id === p.selected;
              const Icon = methodIcons[method.icon];
              return (
                <div
                  key={method.id}
                  className={cn(
                    'border transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring',
                    radius.box,
                    on
                      ? 'border-foreground/40 bg-card'
                      : 'border-border bg-raised hover:border-foreground/25',
                  )}
                >
                  <label className="flex cursor-pointer items-center gap-3.5 px-4 py-3.5">
                    <span
                      aria-hidden
                      className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-card"
                    >
                      <Icon className="size-5" stroke={1.6} />
                    </span>
                    <span className="grid min-w-0 flex-1 gap-0.5">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] font-semibold">
                        {method.title}
                        {method.badge && (
                          <Badge tone="outline" className="py-0 text-[12px]">
                            {method.badge}
                          </Badge>
                        )}
                      </span>
                      <span className="text-[13px] text-muted-foreground">{method.description}</span>
                    </span>
                    <input
                      type="radio"
                      name={group}
                      value={method.id}
                      checked={on}
                      onChange={() => p.onSelect?.(method.id)}
                      className="size-5 shrink-0 cursor-pointer appearance-none rounded-full border border-muted-foreground/50 bg-card transition-[border] checked:border-[6px] checked:border-foreground focus-visible:outline-none"
                    />
                  </label>
                  {on && method.detail && (
                    <div className="border-t border-border-subtle px-4 pt-4 pb-4">{method.detail}</div>
                  )}
                </div>
              );
            })}
          </div>
          {p.methodsExtra}
        </fieldset>
      )}
      {p.before}
      {p.payToday && (
        <div className="flex items-baseline justify-between gap-4 border-t border-border pt-5">
          <span className="text-[15px] text-muted-foreground">Pay today</span>
          <span className="text-right">
            <strong className="text-lg font-semibold tabular-nums">{p.payToday}</strong>
            {p.payNote && <span className="block text-[13px] text-muted-foreground">{p.payNote}</span>}
          </span>
        </div>
      )}
      {p.error && <Notice tone="danger">{p.error}</Notice>}
      {action && (
        <Button
          variant="primary"
          size="lg"
          type={p.onSubmit ? 'submit' : (action.type ?? 'button')}
          form={action.form}
          onClick={action.onClick}
          disabled={action.disabled || action.busy}
          className={cn('w-full', radius.button)}
          data-testid="checkout-primary"
        >
          {action.busy ? (
            <IconLoader2 aria-hidden className="size-5 animate-spin" />
          ) : (
            action.icon === 'passkey' && <IconFingerprint aria-hidden className="size-5" />
          )}
          {action.busy ? (action.busyLabel ?? 'Working…') : action.label}
          {!action.busy && <IconArrowRight aria-hidden className="size-4.5" />}
        </Button>
      )}
      {p.secondary}
      {p.note && <div className="text-[13px] text-muted-foreground">{p.note}</div>}
      {p.back && <BackControl back={p.back} variant="link" />}
    </>
  );
  return p.onSubmit ? (
    <form
      className="grid gap-6"
      onSubmit={event => {
        event.preventDefault();
        p.onSubmit?.();
      }}
    >
      {body}
    </form>
  ) : (
    <div className="grid gap-6">{body}</div>
  );
}
