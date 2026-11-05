'use client';

import { IconPlus, IconX } from '@tabler/icons-react';
import { useId, useState, type ComponentProps, type ReactNode } from 'react';
import type { CardDetails } from '@/server/data/types';
import { toMinor, usd } from '@/lib/format';
import { Button } from '../ui/button';
import { Notice } from '../ui/notice';
import { DECLINE_CARD, digitsOnly } from '../customer/checkout/card-rules';
import { CheckoutFrame, radius } from '../customer/checkout/frame';
import { AccountDetail, BankDetails, CardForm, emptyCard } from '../customer/checkout/method-details';
import {
  checkoutInput,
  CheckoutPanel,
  type CheckoutPanelProps,
  type PanelAction,
  type PanelMethod,
} from '../customer/checkout/panel';
import { PREVIEW_PROMO, previewTotals, SUGGESTED_ADDON, SummaryPanel } from '../customer/checkout/summary';
import { Receipt } from '../customer/receipt';
import {
  previewStyle,
  validAmount,
  type PlaygroundConfig,
  type PreviewMethod,
  type PreviewStep,
} from './config';

const SAMPLE_DATE = '2026-11-06T10:30:00.000Z';

function PreviewInput({
  label,
  optional,
  ...input
}: { label: string; optional?: boolean } & ComponentProps<'input'>) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium">
        {label} {optional && <span className="font-normal text-muted-foreground">(optional)</span>}
      </label>
      <input id={id} className={checkoutInput} {...input} />
    </div>
  );
}

function AddressFields({ title }: { title: string }) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-1.5 text-[13px] font-medium">{title}</legend>
      <input
        aria-label={`${title}: full name`}
        placeholder="Full name"
        autoComplete="name"
        className={checkoutInput}
      />
      <input
        aria-label={`${title}: address line 1`}
        placeholder="Address line 1"
        autoComplete="address-line1"
        className={checkoutInput}
      />
      <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
        <input
          aria-label={`${title}: city`}
          placeholder="City"
          autoComplete="address-level2"
          className={checkoutInput}
        />
        <input
          aria-label={`${title}: postal code`}
          placeholder="ZIP"
          autoComplete="postal-code"
          className={checkoutInput}
        />
      </div>
    </fieldset>
  );
}

/**
 * The Playground preview. It renders the same CheckoutFrame, SummaryPanel and CheckoutPanel as
 * the real checkout, driven by props. Nothing here talks to a data source: no payment is made.
 */
export function CheckoutPreview({
  config,
  step,
  onStep,
  email,
  onEmailChange,
  embedded,
}: {
  config: PlaygroundConfig;
  step: PreviewStep;
  onStep: (step: PreviewStep) => void;
  email: string;
  onEmailChange: (value: string) => void;
  embedded?: boolean;
}) {
  const cardForm = useId();
  const [picked, setPicked] = useState<PreviewMethod>(config.methods[0]);
  const [card, setCard] = useState<CardDetails>(emptyCard);
  const [error, setError] = useState('');
  const [added, setAdded] = useState(false);
  const f = config.features;
  const recurring = config.type === 'recurring';
  const invoice = config.type === 'invoice';
  const method = config.methods.includes(picked) ? picked : config.methods[0];
  const addon = added && f.upsell && !invoice;

  const amountMinor = validAmount(config.amount) ? toMinor(config.amount) : 0n;
  const totals = previewTotals({ amountMinor, promo: f.promo, addon });
  const total = usd(totals.totalMinor);
  const shown = recurring ? `${total} / month` : total;
  const brandName = config.brandName || 'Your business';
  const brand = { brandName, logoUrl: config.logo || null };
  const payer = email || 'alex@example.com';
  const balanceMinor = f.lowBalance
    ? 20_000_000n
    : totals.totalMinor > 400_000_000n
      ? totals.totalMinor + 100_000_000n
      : 500_000_000n;
  const short = balanceMinor < totals.totalMinor;

  const item = invoice
    ? {
        id: 'invoice',
        title: 'Invoice INV-2026-001',
        detail: 'Design retainer, October',
        icon: 'invoice' as const,
      }
    : recurring
      ? { id: 'plan', title: 'Growth plan', detail: 'Billed monthly. Cancel anytime.', icon: 'plan' as const }
      : {
          id: 'product',
          title: 'Brand identity package',
          detail: 'Logo, type and a one-page guide',
          icon: 'product' as const,
        };

  const summary = (
    <SummaryPanel
      heading={`${brandName}: ${item.title}`}
      eyebrow={invoice ? 'Invoice' : recurring ? 'Subscription' : 'One-time payment'}
      total={shown}
      totalNote={recurring ? `Then ${total} each month until you cancel.` : undefined}
      items={[
        { ...item, amount: usd(amountMinor) },
        ...(addon
          ? [
              {
                id: SUGGESTED_ADDON.id,
                title: SUGGESTED_ADDON.title,
                detail: SUGGESTED_ADDON.detail,
                amount: usd(SUGGESTED_ADDON.amountMinor),
                icon: 'support' as const,
                action: (
                  <button
                    type="button"
                    onClick={() => setAdded(false)}
                    className="mt-1 inline-flex w-fit items-center gap-1 text-[13px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                  >
                    <IconX aria-hidden className="size-3.5" />
                    Remove
                  </button>
                ),
              },
            ]
          : []),
      ]}
      subtotal={usd(totals.subtotalMinor)}
      rows={[
        ...(f.promo
          ? [
              {
                label: (
                  <span className="inline-flex items-center gap-2">
                    <span className="rounded-md bg-chip px-1.5 py-0.5 text-[13px] font-medium text-foreground">
                      {PREVIEW_PROMO.code}
                    </span>
                    {PREVIEW_PROMO.percent.toString()}% off
                  </span>
                ),
                value: `−${usd(totals.discountMinor)}`,
              },
            ]
          : []),
        ...(f.tax
          ? [
              {
                label: 'Tax',
                value: f.shipping || f.billing ? 'Calculated from your address' : 'Calculated at payment',
              },
            ]
          : []),
      ]}
      dueToday={total}
    >
      {f.upsell && !invoice && !addon && (
        <div className="grid gap-2">
          <p className="text-sm font-medium">Add to your order</p>
          <div className={`flex items-center gap-3 border border-border bg-card p-3 ${radius.box}`}>
            <div className="grid min-w-0 flex-1">
              <span className="text-sm font-medium">{SUGGESTED_ADDON.title}</span>
              <span className="text-[13px] text-muted-foreground">
                {usd(SUGGESTED_ADDON.amountMinor)} · {SUGGESTED_ADDON.detail}
              </span>
            </div>
            <Button size="sm" onClick={() => setAdded(true)} aria-label={`Add ${SUGGESTED_ADDON.title}`}>
              <IconPlus aria-hidden className="size-4" />
              Add
            </Button>
          </div>
        </div>
      )}
    </SummaryPanel>
  );

  const contactExtra =
    f.phone || f.shipping || f.billing ? (
      <div className="grid gap-4">
        {f.phone && (
          <PreviewInput
            label="Phone number"
            optional
            type="tel"
            autoComplete="tel"
            placeholder="(201) 555-0123"
          />
        )}
        {f.shipping && <AddressFields title="Shipping address" />}
        {f.billing && <AddressFields title="Billing address" />}
      </div>
    ) : undefined;

  const consent = recurring ? (
    <Notice tone="shield" title={`You approve up to ${total} each month`}>
      One signature sets the cap. {brandName} cannot charge more, charge early, or charge after you cancel.
    </Notice>
  ) : undefined;

  const payLabel = recurring ? `Subscribe · ${total} / month` : `Pay ${total}`;
  const methods: PanelMethod[] = config.methods.map(id =>
    id === 'account'
      ? {
          id,
          icon: 'account',
          title: 'Your Pact account',
          description: `Balance ${usd(balanceMinor)} · no fees`,
          detail: (
            <AccountDetail
              balance={usd(balanceMinor)}
              brandName={brandName}
              shortfall={
                short ? (
                  <Notice tone="warning" title="Add funds to continue">
                    Your balance is {usd(balanceMinor)}; this payment needs {total}. Add funds, or choose
                    another way to pay.
                  </Notice>
                ) : undefined
              }
            />
          ),
        }
      : id === 'card'
        ? {
            id,
            icon: 'card',
            title: 'Card',
            description: 'Visa, Mastercard, Amex, Discover',
            badge: 'Preview',
            detail: (
              <CardForm
                id={cardForm}
                value={card}
                onChange={setCard}
                badge="Preview"
                onSubmit={value => {
                  if (digitsOnly(value.number) === DECLINE_CARD)
                    return setError(
                      'Your card was declined and nothing was charged. Try another card or another way to pay.',
                    );
                  setError('');
                  onStep('processing');
                }}
              />
            ),
          }
        : {
            id,
            icon: 'bank',
            title: 'Bank transfer',
            description: 'Send it from your bank with a reference',
            badge: 'Preview',
            detail: (
              <BankDetails
                badge="Preview"
                amount={total}
                option={{
                  kind: 'bank',
                  demo: true,
                  payee: `${brandName} via Pact`,
                  bank: 'Pact Demo Bank',
                  accountNumber: '0012345678',
                  reference: 'PACT-PREVIEW',
                }}
              />
            ),
          },
  );
  const actions: Record<PreviewMethod, PanelAction> = {
    account: { label: payLabel, icon: 'passkey', disabled: short, onClick: () => onStep('processing') },
    card: { label: payLabel, type: 'submit', form: cardForm },
    bank: { label: 'I’ve sent the transfer', onClick: () => onStep('processing') },
  };
  const methodLabel = { account: 'Pact account', card: 'Visa ending 4242', bank: 'Bank transfer' }[method];
  const contactTitle = f.shipping ? 'Shipping information' : 'Contact information';

  let panel: CheckoutPanelProps;
  if (step === 'information')
    panel = {
      step,
      email,
      onEmailChange,
      contactTitle,
      contactExtra,
      payToday: total,
      action: { label: config.buttonLabel.trim() || 'Continue' },
      onSubmit: () => onStep('payment'),
      note: 'You choose how to pay on the next step. Nothing is charged until you confirm.',
    };
  else if (step === 'payment')
    panel = {
      step,
      email: payer,
      contactTitle,
      contactExtra,
      methods,
      selected: method,
      onSelect: id => {
        setPicked(id as PreviewMethod);
        setError('');
      },
      before: consent,
      payToday: total,
      payNote: recurring ? `then ${total} each month` : undefined,
      action: actions[method],
      error,
      back: { onClick: () => onStep('information') },
    };
  else if (step === 'processing')
    panel = {
      step,
      title:
        method === 'bank'
          ? 'Waiting for your bank transfer'
          : method === 'card'
            ? 'Confirming your card payment'
            : 'Confirming your payment',
      hint: 'This takes a second or two. Your receipt will be in your account.',
      action: (
        <Button variant="ghost" size="sm" onClick={() => onStep('success')}>
          Show the receipt
        </Button>
      ),
    };
  else if (step === 'success' || step === 'refund')
    panel = {
      step,
      receipt: (
        <Receipt
          merchant={brandName}
          item={item.title}
          amountMinor={totals.totalMinor.toString()}
          paidAt={SAMPLE_DATE}
          txHash={null}
          reference="ord_preview"
          method={methodLabel}
          title={step === 'refund' ? 'Payment refunded' : 'Payment complete'}
          note="Sample receipt"
          refunds={
            step === 'refund'
              ? [
                  {
                    id: 'ref_preview',
                    amountMinor: totals.totalMinor.toString(),
                    reason: 'Requested by customer',
                    createdAt: SAMPLE_DATE,
                    txHash: null,
                  },
                ]
              : []
          }
        />
      ),
      actions: (
        <Button variant="ghost" onClick={() => onStep('payment')}>
          Back to checkout
        </Button>
      ),
    };
  else
    panel = {
      step,
      title: step === 'expired' ? 'This checkout expired' : 'The payment did not go through',
      message:
        step === 'expired'
          ? 'Nothing was charged. Start again to pay the current price.'
          : 'Nothing was charged. Try again, or choose another way to pay.',
      action: (
        <Button
          variant="dark"
          className="justify-self-start"
          onClick={() => onStep(step === 'expired' ? 'information' : 'payment')}
        >
          {step === 'expired' ? 'Start again' : 'Try again'}
        </Button>
      ),
    };

  const content: ReactNode = <CheckoutPanel {...panel} />;
  return (
    <div
      className={`theme-${config.theme} min-h-full bg-background text-foreground`}
      style={previewStyle(config)}
      data-testid="checkout-preview"
    >
      <CheckoutFrame
        brand={brand}
        back={step === 'payment' ? { onClick: () => onStep('information') } : undefined}
        summary={summary}
        embedded={embedded ? { total: shown } : undefined}
      >
        {content}
      </CheckoutFrame>
    </div>
  );
}
