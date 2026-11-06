'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, useTransition } from 'react';
import type {
  CardDetails,
  CheckoutMethodKind,
  CheckoutMethodOption,
  CheckoutState,
} from '@/server/data/types';
import type { ActionResult } from '@/server/actions/result';
import {
  checkoutStatus,
  confirmTransfer,
  payByCard,
  preparePasskeyPayment,
  preparePayment,
  submitPayment,
  startProductCheckout,
} from '@/server/actions/customer';
import { useSignedAction } from '../auth/use-signed-action';
import { usd, usdt } from '@/lib/format';
import { Button } from '../ui/button';
import { Notice } from '../ui/notice';
import { Field, Input } from '../ui/field';
import { AddFunds } from './add-funds';
import { AdvancedDetails } from './advanced-details';
import { CheckoutPanel, type PanelAction, type PanelMethod } from './checkout/panel';
import { AccountDetail, BankDetails, CardForm, emptyCard, WalletDeposit } from './checkout/method-details';
import { Receipt } from './receipt';

const pendingCopy: Record<CheckoutMethodKind, { title: string; hint: string }> = {
  account: {
    title: 'Confirming your payment',
    hint: 'This takes a second or two. You can leave this page; your receipt will be in your account.',
  },
  passkey: {
    title: 'Confirming your payment',
    hint: 'This takes a second or two. You can leave this page; your receipt will be in your account.',
  },
  card: {
    title: 'Confirming your card payment',
    hint: 'This takes a second or two. You can leave this page; your receipt will be in your account.',
  },
  bank: {
    title: 'Waiting for your bank transfer',
    hint: 'In this demo the transfer arrives in a few seconds. Real bank transfers can take one to three business days.',
  },
  wallet: {
    title: 'Waiting for your transfer',
    hint: 'In this demo the transfer arrives in a few seconds. Your receipt will be in your account.',
  },
};

/**
 * Zero crypto steps: dollars, one page, one confirmation. The Pact account pays with a passkey;
 * the demo sandbox also offers card, bank transfer and the payer's own wallet. Whatever the method,
 * the data source decides the outcome and settles it through the same pending → paid path.
 */
export function CheckoutView({ initial, payer }: { initial: CheckoutState; payer: string }) {
  const router = useRouter();
  const signed = useSignedAction();
  const cardForm = useId();
  const [state, setState] = useState(initial);
  const [discountCode, setDiscountCode] = useState(initial.discountCode ?? '');
  const [discountError, setDiscountError] = useState('');
  const [applyingDiscount, setApplyingDiscount] = useState(false);
  const discounted = !!state.amountGross && !!state.amountDiscount && BigInt(state.total.amountMinor) < BigInt(state.amountGross.replace('.', ''));
  const [selected, setSelected] = useState<CheckoutMethodKind>('account');
  const [card, setCard] = useState<CardDetails>(emptyCard);
  const [error, setError] = useState('');
  const [walletError, setWalletError] = useState('');
  const [busy, setBusy] = useState<CheckoutMethodKind | null>(null);
  const [, start] = useTransition();

  useEffect(() => {
    if (state.status !== 'pending') return;
    const timer = window.setInterval(async () => {
      const next = await checkoutStatus(state.id);
      if (next.ok) setState(next.data);
    }, 700);
    return () => window.clearInterval(timer);
  }, [state.status, state.id]);

  const refresh = async () => {
    const next = await checkoutStatus(state.id);
    if (next.ok) setState(next.data);
  };

  const run = (method: CheckoutMethodKind, work: () => Promise<ActionResult<CheckoutState>>) =>
    start(async () => {
      setBusy(method);
      setError('');
      setWalletError('');
      const result = await work();
      setBusy(null);
      if (result.ok) return setState(result.data);
      if (result.error.code !== 'cancelled')
        (method === 'wallet' ? setWalletError : setError)(result.error.message);
      if (['insufficient_funds', 'not_open'].includes(result.error.code)) await refresh();
    });

  const payWithAccount = () =>
    run('account', () =>
      signed(
        () => preparePayment(state.id),
        (token, signature) => submitPayment(token, signature),
      ),
    );

  // The same payment, confirmed with the customer's passkey account (Face ID, Touch ID or a security key).
  const payWithPasskey = () =>
    run('passkey', () =>
      signed(
        () => preparePasskeyPayment(state.id),
        (token, signature) => submitPayment(token, signature),
      ),
    );

  const amount = usd(state.total.amountMinor);
  const brandName = state.brand.brandName;
  const options: CheckoutMethodOption[] = state.methods?.length ? state.methods : [{ kind: 'account' }];
  const back = state.returnPath ? { href: state.returnPath } : undefined;
  // Demo storefront checkouts return to their store order page.
  const fromStore = state.returnPath?.startsWith('/demo/store/') ? state.returnPath : null;
  const restart = state.returnPath ? (
    <Button asChild variant="dark" className="justify-self-start">
      <Link href={state.returnPath}>Start again</Link>
    </Button>
  ) : undefined;

  if (state.status === 'paid' && state.receipt)
    return (
      <CheckoutPanel
        step="success"
        receipt={
          <Receipt
            merchant={brandName}
            item={state.description}
            amountMinor={state.total.amountMinor}
            paidAt={state.receipt.paidAt}
            txHash={state.receipt.txHash}
            reference={state.orderId ?? state.invoiceId ?? state.id}
            method={state.method?.label}
          />
        }
        actions={
          <>
            {fromStore && (
              <Button asChild variant="primary">
                <Link href={fromStore}>Back to the store</Link>
              </Button>
            )}
            <Button asChild variant={fromStore ? 'secondary' : 'dark'}>
              <Link
                href={
                  state.kind === 'invoice'
                    ? `/invoice/${state.invoiceId}`
                    : state.orderId
                      ? `/portal/purchases/${state.orderId}`
                      : '/portal'
                }
              >
                {state.kind === 'invoice' ? 'Back to the invoice' : 'View in your account'}
              </Link>
            </Button>
            <Button asChild variant="ghost">
              <Link href="/portal">All purchases</Link>
            </Button>
          </>
        }
        extra={<AdvancedDetails details={state.advanced} txHash={state.receipt.txHash} />}
      />
    );

  if (state.status === 'expired')
    return (
      <CheckoutPanel
        step="expired"
        title="This checkout expired"
        message="Nothing was charged. Start again to pay the current price."
        action={restart}
      />
    );

  if (state.status === 'failed')
    return (
      <CheckoutPanel
        step="failed"
        title="The payment did not go through"
        message={state.failure ?? 'Nothing was charged.'}
        action={restart}
      />
    );

  if (state.status === 'pending') {
    const copy = pendingCopy[state.method?.kind ?? 'account'];
    return <CheckoutPanel step="processing" title={copy.title} hint={copy.hint} />;
  }

  const open = state.status === 'open';
  const methods: PanelMethod[] = options.flatMap((option): PanelMethod[] => {
    if (option.kind === 'account')
      return [
        {
          id: 'account',
          icon: 'account',
          title: 'Your Pact account',
          description:
            state.balanceMinor !== null
              ? `Balance ${usd(state.balanceMinor)} · no fees`
              : 'No fees · confirm with your passkey',
          detail: (
            <AccountDetail
              balance={state.balanceMinor !== null ? usd(state.balanceMinor) : null}
              brandName={brandName}
              shortfall={
                state.readiness === 'needs_funds' && state.balanceMinor !== null ? (
                  <AddFunds
                    balanceMinor={state.balanceMinor}
                    neededMinor={state.total.amountMinor}
                    onAdded={() => void refresh()}
                  />
                ) : state.readiness === 'unavailable' ? (
                  <Notice tone="warning">
                    Payment is not available right now. Nothing was charged; please try again shortly.
                  </Notice>
                ) : undefined
              }
            />
          ),
        },
      ];
    if (option.kind === 'passkey') {
      const short = option.balanceMinor !== null && BigInt(option.balanceMinor) < BigInt(state.total.amountMinor);
      return [
        {
          id: 'passkey',
          icon: 'passkey',
          title: 'Passkey account',
          description:
            option.balanceMinor !== null
              ? `Balance ${usd(option.balanceMinor)} · confirm with Face ID, Touch ID or a security key`
              : 'Confirm with Face ID, Touch ID or a security key',
          detail: short ? (
            <Notice tone="warning">
              Your passkey account holds {usd(option.balanceMinor!)}. Add funds to it from your account page, or pay from your Pact account.
            </Notice>
          ) : undefined,
        },
      ];
    }
    if (option.kind === 'card')
      return [
        {
          id: 'card',
          icon: 'card',
          title: 'Card',
          description: 'Visa, Mastercard, Amex, Discover',
          badge: 'Demo',
          detail: (
            <CardForm
              id={cardForm}
              value={card}
              onChange={setCard}
              onSubmit={value => run('card', () => payByCard(state.id, value))}
              disabled={busy !== null}
              badge="Demo"
            />
          ),
        },
      ];
    if (option.kind === 'bank')
      return [
        {
          id: 'bank',
          icon: 'bank',
          title: 'Bank transfer',
          description: 'Send it from your bank with a reference',
          badge: 'Demo',
          detail: <BankDetails option={option} amount={amount} badge="Demo" />,
        },
      ];
    return [];
  });
  const wallet = options.find(option => option.kind === 'wallet');

  const actions: Record<CheckoutMethodKind, PanelAction> = {
    account: {
      label: `Pay ${amount}`,
      icon: 'passkey',
      onClick: payWithAccount,
      disabled: !open || state.readiness !== 'ready' || busy !== null,
      busy: busy === 'account',
      busyLabel: 'Waiting for your passkey…',
    },
    passkey: {
      label: `Pay ${amount}`,
      icon: 'passkey',
      onClick: payWithPasskey,
      disabled:
        !open ||
        busy !== null ||
        options.some(o => o.kind === 'passkey' && o.balanceMinor !== null && BigInt(o.balanceMinor) < BigInt(state.total.amountMinor)),
      busy: busy === 'passkey',
      busyLabel: 'Waiting for your passkey…',
    },
    card: {
      label: `Pay ${amount}`,
      type: 'submit',
      form: cardForm,
      disabled: !open || busy !== null,
      busy: busy === 'card',
      busyLabel: 'Processing…',
    },
    bank: {
      label: 'I’ve sent the transfer',
      onClick: () => run('bank', () => confirmTransfer(state.id, 'bank')),
      disabled: !open || busy !== null,
      busy: busy === 'bank',
      busyLabel: 'Confirming…',
    },
    wallet: { label: '', disabled: true },
  };
  const current = methods.some(method => method.id === selected) ? selected : 'account';

  return (
    <>
      <CheckoutPanel
        step="payment"
        email={payer}
        before={open && (state.productId || discounted) ? (
          <div className="grid gap-3">
            {state.productId && (
              <Field label="Discount code" hint={state.discountCode ? `Applied: ${state.discountCode}` : 'Enter a code to update the total before paying.'}>
                {id => <Input id={id} value={discountCode} onChange={event => setDiscountCode(event.target.value)} autoComplete="off" />}
              </Field>
            )}
            {discounted && <p className="text-sm text-muted-foreground">Original {state.amountGross} USDT · discount {state.amountDiscount} USDT{state.discountCode && !state.productId ? ` (${state.discountCode})` : ''}</p>}
            {state.productId && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={applyingDiscount || !discountCode.trim() || discountCode.trim().toUpperCase() === state.discountCode}
                onClick={async () => {
                  setDiscountError('');
                  setApplyingDiscount(true);
                  const result = await startProductCheckout(state.productId!, discountCode, state.metadata);
                  setApplyingDiscount(false);
                  if (!result.ok) return setDiscountError(result.error.message);
                  router.push(`/checkout/${result.data.sessionId}`);
                }}
              >
                {applyingDiscount ? 'Applying…' : 'Apply code'}
              </Button>
            )}
            {discountError && <p role="alert" className="text-sm text-destructive">{discountError}</p>}
          </div>
        ) : undefined}
        methods={methods}
        selected={current}
        onSelect={id => {
          setSelected(id as CheckoutMethodKind);
          setError('');
        }}
        methodsExtra={
          wallet?.kind === 'wallet' && (
            <WalletDeposit
              option={wallet}
              amountUsdt={usdt(state.total.amountMinor)}
              onConfirm={() => run('wallet', () => confirmTransfer(state.id, 'wallet'))}
              busy={busy === 'wallet'}
              disabled={!open || busy !== null}
              error={walletError}
            />
          )
        }
        payToday={amount}
        action={actions[current]}
        error={error}
        note="The price is set by the business. Nothing is charged until you confirm."
        back={back}
      />
      <AdvancedDetails details={state.advanced} />
    </>
  );
}
