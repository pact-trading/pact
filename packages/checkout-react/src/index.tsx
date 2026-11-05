import { useState, type CSSProperties, type FormEvent } from 'react';
import { PactClient, fetchTransport, parseUsdt, pactTheme, themeToCssVariables, validateCheckoutAnswers, type CheckoutAnswer, type CheckoutField, type Payment, type PactThemeOptions } from '@pactagent/core';

export type { CheckoutField } from '@pactagent/core';

export type CheckoutPaymentMethod = 'usdt' | 'card' | 'bank';

const messages = {
  en: { checkout: 'Checkout', total: 'Total', email: 'Email address', method: 'Payment method', complete: 'Payment complete', receipt: 'Receipt', starting: 'Starting payment…' },
  es: { checkout: 'Pagar', total: 'Total', email: 'Correo electrónico', method: 'Método de pago', complete: 'Pago completado', receipt: 'Recibo', starting: 'Iniciando pago…' },
  fr: { checkout: 'Paiement', total: 'Total', email: 'Adresse e-mail', method: 'Moyen de paiement', complete: 'Paiement terminé', receipt: 'Reçu', starting: 'Démarrage du paiement…' },
};

export interface CheckoutProps {
  /** Exact decimal USDT amount, for example "12.50". */
  amount: string;
  onSuccess: (payment: Payment) => void;
  onError?: (error: Error) => void;
  client?: PactClient;
  /** URL of a merchant-hosted API proxy; defaults to /api/pact. */
  apiBaseUrl?: string;
  buttonLabel?: string;
  appearance?: PactThemeOptions;
  /** BCP 47 locale used for the amount display. */
  locale?: string;
  /** Card and bank are presentation slots for future providers; USDT is the current rail. */
  paymentMethods?: CheckoutPaymentMethod[];
  showReceipt?: boolean;
  /** Extra questions shown above the pay button. Answers are sent as the payment's `metadata`. */
  fields?: CheckoutField[];
}

/** Customer-facing checkout. Appearance variables stay scoped to the widget root. */
export function Checkout({ amount, onSuccess, onError, client, apiBaseUrl = '/api/pact', buttonLabel = 'Continue to payment', appearance, locale = 'en-US', paymentMethods = ['usdt'], showReceipt = true, fields = [] }: CheckoutProps) {
  const [email, setEmail] = useState('');
  const [method, setMethod] = useState<CheckoutPaymentMethod>(paymentMethods[0] ?? 'usdt');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState<Payment | null>(null);
  const [answers, setAnswers] = useState<Record<string, CheckoutAnswer>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const theme = pactTheme(appearance);
  const copy = messages[locale.split('-')[0] as keyof typeof messages] ?? messages.en;
  const panel: CSSProperties = { ...themeToCssVariables(theme) as CSSProperties, fontFamily: 'var(--pact-checkout-font)', maxWidth: 380, padding: 24, border: '1px solid var(--pact-checkout-border)', borderRadius: 'var(--pact-checkout-radius)', background: 'var(--pact-checkout-surface)', color: 'var(--pact-checkout-text)' };
  const field: CSSProperties = { width: '100%', boxSizing: 'border-box', padding: 12, border: '1px solid var(--pact-checkout-border)', borderRadius: 'calc(var(--pact-checkout-radius) / 2)', fontSize: 16, background: 'var(--pact-checkout-background)', color: 'var(--pact-checkout-text)' };
  let total = `$${amount}`;
  try { total = new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(Number(amount)); } catch { /* Keep the exact input visible for unsupported locales. */ }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError('');
    const checked = validateCheckoutAnswers(fields, answers);
    setFieldErrors(checked.errors);
    if (!checked.valid) return;
    setBusy(true);
    try {
      if (method !== 'usdt') throw new Error(`${method === 'card' ? 'Card' : 'Bank'} payments are not available yet`);
      if (parseUsdt(amount) <= 0n) throw new RangeError('Amount must be greater than zero');
      const api = client ?? new PactClient({ transport: fetchTransport(apiBaseUrl) });
      const payment: Payment = await api.payments.create({ amount, currency: 'USDT', email, ...(Object.keys(checked.metadata).length ? { metadata: checked.metadata } : {}) });
      if (payment.checkoutUrl) window.location.assign(payment.checkoutUrl);
      else if (payment.status === 'succeeded') { if (showReceipt) setReceipt(payment); onSuccess(payment); }
      else throw new Error('Payment is pending; a checkout link was not returned');
    } catch (cause) {
      const err = cause instanceof Error ? cause : new Error('Could not start payment');
      setError(err.message);
      onError?.(err);
    } finally { setBusy(false); }
  }

  return <form onSubmit={submit} style={panel} aria-label={copy.checkout} data-pact-theme={theme.type} lang={locale}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
      {theme.brand.logo ? <img src={theme.brand.logo} alt="" width={36} height={36} style={{ objectFit: 'contain', borderRadius: 8 }} /> : null}
      <span style={{ fontWeight: 500 }}>{theme.brand.name}</span>
    </div>
    {receipt ? <div role="status"><span style={{ color: 'var(--pact-checkout-success)', fontSize: 22, fontWeight: 500 }}>{copy.complete}</span><p>{copy.receipt} {receipt.id}</p><p>{copy.total} {total}</p></div> : <>
      <span style={{ display: 'block', fontSize: 22, marginBottom: 4, fontWeight: 500 }}>{copy.checkout}</span>
      <p style={{ marginTop: 0, color: 'var(--pact-checkout-muted-text)' }}>{copy.total}: {total}</p>
      <label htmlFor="pact-email" style={{ display: 'block', marginBottom: 6 }}>{copy.email}</label>
      <input id="pact-email" style={field} type="email" autoComplete="email" value={email} required onChange={(event) => setEmail(event.target.value)} />
      {fields.map((item) => {
        const id = `pact-field-${item.key}`, problem = fieldErrors[item.key];
        const label = item.required ? item.label : `${item.label} (optional)`;
        return <div key={item.key} style={{ marginTop: 12 }}>
          {item.type === 'checkbox'
            ? <label htmlFor={id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input id={id} type="checkbox" checked={answers[item.key] === true} aria-invalid={Boolean(problem) || undefined} onChange={(event) => setAnswers((current) => ({ ...current, [item.key]: event.target.checked }))} />{label}</label>
            : <><label htmlFor={id} style={{ display: 'block', marginBottom: 6 }}>{label}</label><input id={id} style={field} type={item.type === 'number' ? 'number' : 'text'} step={item.type === 'number' ? 'any' : undefined} value={String(answers[item.key] ?? '')} aria-invalid={Boolean(problem) || undefined} onChange={(event) => setAnswers((current) => ({ ...current, [item.key]: event.target.value }))} /></>}
          {problem && <p role="alert" style={{ margin: '6px 0 0', color: 'var(--pact-checkout-danger)' }}>{problem}</p>}
        </div>;
      })}
      {paymentMethods.length > 1 && <fieldset style={{ border: 0, padding: 0, margin: '16px 0 0' }}><legend style={{ marginBottom: 8 }}>{copy.method}</legend>{paymentMethods.map((option) => <label key={option} style={{ display: 'inline-flex', gap: 5, marginRight: 12, alignItems: 'center', fontSize: 12 }}><input type="radio" name="settle-payment-method" value={option} checked={method === option} onChange={() => setMethod(option)} />{option === 'usdt' ? 'USDT' : option === 'card' ? 'Card' : 'Bank'}{option !== 'usdt' ? ' (soon)' : ''}</label>)}</fieldset>}
      {error && <p role="alert" style={{ color: 'var(--pact-checkout-danger)' }}>{error}</p>}
      <button type="submit" disabled={busy || paymentMethods.length === 0} style={{ ...field, marginTop: 16, borderRadius: 9999, background: 'var(--pact-checkout-primary)', color: 'var(--pact-checkout-primary-text)', border: 0, cursor: 'pointer', fontWeight: 500 }}>
        {busy ? copy.starting : buttonLabel}
      </button>
    </>}
  </form>;
}
