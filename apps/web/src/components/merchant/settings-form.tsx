'use client';

import { IconLock } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { MerchantSettings } from '@pactagent/core/api-types';
import type { MerchantPreferences } from '@/server/data/types';
import { updatePreferences, updateSettings } from '@/server/actions/merchant';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardBody, CardHeader } from '../ui/card';
import { CopyButton } from '../ui/copy-button';
import { Field, Input } from '../ui/field';
import { Notice } from '../ui/notice';
import { useToast } from '../ui/toast';
import { RadioCards } from '../portal/radio-cards';
import { inkOn } from './invoices/invoice-preview';

const HEX = /^#[0-9a-f]{6}$/i;
const swatches = ['#c6ff34', '#0e1116', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#059669'];

function logoError(value: string) {
  if (!value) return '';
  try {
    return new URL(value).protocol === 'https:' ? '' : 'Use an https:// address.';
  } catch {
    return 'Enter a full address, like https://example.com/logo.png.';
  }
}

/** The logo, or the first letter on the brand colour when there is no logo or it fails to load. */
function BrandMark({
  name,
  logo,
  color,
  size = 40,
}: {
  name: string;
  logo: string;
  color: string;
  size?: number;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (logo && !logoError(logo) && failed !== logo)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logo}
        alt=""
        onError={() => setFailed(logo)}
        className="rounded-xl object-cover"
        style={{ width: size, height: size }}
      />
    );
  return (
    <span
      aria-hidden
      className="grid place-items-center rounded-xl font-semibold"
      style={{ width: size, height: size, background: color, color: inkOn(color) }}
    >
      {(name.trim() || '?').slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * Brand, refund policy, fees and payout. Fields start from the saved settings and the page
 * remounts the form after a save, so it always shows what is stored, never seed values.
 */
export function SettingsForm({
  settings,
  preferences,
  readOnly,
}: {
  settings: MerchantSettings;
  /** Null when the data source cannot store brand colour and fee mode yet. */
  preferences: MerchantPreferences | null;
  readOnly: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(settings.brandName);
  const [logo, setLogo] = useState(settings.logoUrl ?? '');
  const [color, setColor] = useState(preferences?.brandColor ?? '#c6ff34');
  const [days, setDays] = useState(String(Math.round(settings.refundWindowSeconds / 86_400)));
  const [feeMode, setFeeMode] = useState<MerchantPreferences['feeMode']>(preferences?.feeMode ?? 'merchant');
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();

  const errors = {
    name: name.trim() ? '' : 'Enter your business name.',
    logo: logoError(logo.trim()),
    color: HEX.test(color) ? '' : 'Use a six-digit hex colour, like #c6ff34.',
    days: /^\d+$/.test(days) && Number(days) >= 1 && Number(days) <= 365 ? '' : 'Choose 1 to 365 days.',
  };
  const invalid = Object.values(errors).some(Boolean);
  const show = (key: keyof typeof errors) => (tried && errors[key] ? errors[key] : undefined);
  const previewColor = HEX.test(color) ? color : '#c6ff34';

  const save = () =>
    start(async () => {
      setTried(true);
      setError('');
      if (invalid) return;
      const saved = await updateSettings({
        brandName: name.trim(),
        logoUrl: logo.trim() || null,
        refundWindowSeconds: Math.round(Number(days) * 86_400),
      });
      if (!saved.ok) return setError(saved.error.message);
      if (preferences) {
        const prefs = await updatePreferences({ brandColor: color, feeMode });
        if (!prefs.ok) return setError(prefs.error.message);
      }
      toast('Settings saved');
      router.refresh();
    });

  return (
    <form
      className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]"
      noValidate
      onSubmit={event => {
        event.preventDefault();
        save();
      }}
    >
      <div className="grid min-w-0 gap-6">
        <Card>
          <CardHeader title="Brand" description="Shown at checkout, on receipts and on invoices." />
          <CardBody>
            <fieldset disabled={readOnly} className="grid gap-5">
              <Field label="Business name" error={show('name')}>
                {id => (
                  <Input
                    id={id}
                    value={name}
                    onChange={e => setName(e.target.value)}
                    maxLength={80}
                    aria-invalid={Boolean(show('name'))}
                    required
                  />
                )}
              </Field>
              <Field label="Logo URL" hint="A public HTTPS image, square works best." error={show('logo')}>
                {id => (
                  <Input
                    id={id}
                    type="url"
                    value={logo}
                    onChange={e => setLogo(e.target.value)}
                    placeholder="https://…"
                    aria-invalid={Boolean(show('logo'))}
                  />
                )}
              </Field>
              {preferences && (
                <Field
                  label="Brand colour"
                  hint="Used for the pay button on your customer previews."
                  error={show('color')}
                >
                  {id => (
                    <div className="grid gap-2">
                      <div className="flex items-center gap-2">
                        <input
                          type="color"
                          aria-label="Pick brand colour"
                          value={previewColor}
                          onChange={e => setColor(e.target.value)}
                          className="h-11 w-14 shrink-0 cursor-pointer rounded-[14px] border border-input bg-card p-1"
                        />
                        <Input
                          id={id}
                          value={color}
                          onChange={e => setColor(e.target.value.trim())}
                          maxLength={7}
                          className="font-mono"
                          aria-invalid={Boolean(show('color'))}
                        />
                      </div>
                      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Suggested colours">
                        {swatches.map(swatch => (
                          <button
                            key={swatch}
                            type="button"
                            aria-label={`Use ${swatch}`}
                            aria-pressed={color.toLowerCase() === swatch}
                            onClick={() => setColor(swatch)}
                            className="size-7 rounded-full border border-border ring-offset-2 ring-offset-card aria-pressed:ring-2 aria-pressed:ring-foreground"
                            style={{ background: swatch }}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </Field>
              )}
            </fieldset>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Refunds" />
          <CardBody>
            <fieldset disabled={readOnly}>
              <Field
                label="Refund window, in days"
                hint="Refunds after this are refused by the contract. Each payment keeps the window it was paid under."
                error={show('days')}
              >
                {id => (
                  <Input
                    id={id}
                    inputMode="numeric"
                    value={days}
                    aria-invalid={Boolean(show('days'))}
                    onChange={e => /^\d{0,3}$/.test(e.target.value) && setDays(e.target.value)}
                  />
                )}
              </Field>
            </fieldset>
          </CardBody>
        </Card>

        {preferences && (
          <Card>
            <CardHeader
              title="Fee mode"
              description="Who carries the 1% Pact fee on new invoices."
              action={<Badge tone="outline">Demo</Badge>}
            />
            <CardBody>
              <RadioCards
                legend="Who pays the fee"
                value={feeMode}
                onChange={setFeeMode}
                disabled={readOnly}
                options={[
                  {
                    value: 'merchant',
                    title: 'I absorb the fee',
                    body: 'Customers pay the price you set. The fee comes out of your payout.',
                  },
                  {
                    value: 'customer',
                    title: 'Customer pays the fee',
                    body: 'New invoices get a payment processing fee line, so your payout nets the full amount.',
                  },
                ]}
              />
              <p className="mt-3 text-[13px] text-muted-foreground">
                Product checkouts always charge the product price. Network gas is set on the gas tank page.
              </p>
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader
            title="Payout"
            description="USDT settles here in the same block as each payment. Pact never holds your funds."
          />
          <CardBody className="grid gap-3">
            <Field label="Payout account">
              {id => (
                <div className="flex min-w-0 items-center gap-1 rounded-[14px] border border-input bg-raised py-1 pr-1 pl-3.5">
                  <input
                    id={id}
                    readOnly
                    value={settings.payoutAddress}
                    className="min-w-0 flex-1 truncate bg-transparent font-mono text-sm outline-none"
                  />
                  <CopyButton value={settings.payoutAddress} label="Copy payout account" />
                </div>
              )}
            </Field>
            <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
              <IconLock className="mt-0.5 size-4 shrink-0" />
              Your own account, created with your passkey. Changing it needs a signed request and is not
              offered in the dashboard.
            </p>
          </CardBody>
        </Card>

        {error && <Notice tone="danger">{error}</Notice>}
        {tried && invalid && <Notice tone="danger">Fix the highlighted fields to save.</Notice>}
        {!readOnly && (
          <Button type="submit" variant="dark" className="justify-self-start" disabled={pending}>
            {pending ? 'Saving…' : 'Save settings'}
          </Button>
        )}
      </div>

      <aside className="grid gap-3 lg:sticky lg:top-6" aria-label="Live preview">
        <p className="text-sm font-medium text-muted-foreground">Live preview</p>
        <div className="overflow-hidden rounded-2xl border border-border bg-background shadow-panel">
          <div className="flex items-center gap-3 border-b border-border bg-card px-5 py-4">
            <BrandMark name={name} logo={logo.trim()} color={previewColor} />
            <div className="min-w-0">
              <p className="truncate font-semibold" data-testid="preview-brand">
                {name.trim() || 'Your business'}
              </p>
              <p className="text-[13px] text-muted-foreground">Secure checkout</p>
            </div>
          </div>
          <div className="grid gap-4 p-5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm text-muted-foreground">Website audit</span>
              <span className="text-2xl font-semibold tracking-tight">$490.00</span>
            </div>
            <div
              aria-hidden
              className="flex h-11 items-center justify-center rounded-full text-[15px] font-semibold"
              style={{ background: previewColor, color: inkOn(previewColor) }}
            >
              Pay $490.00
            </div>
            <p className="text-center text-[13px] text-muted-foreground">
              Refund window: {/^\d+$/.test(days) && Number(days) > 0 ? days : '—'} day
              {days === '1' ? '' : 's'}
            </p>
          </div>
        </div>
        <p className="text-[13px] text-muted-foreground">Sample item. Changes apply when you save.</p>
      </aside>
    </form>
  );
}

/** Business name and logo, inline in onboarding. Starts from what is saved. */
export function BrandQuickForm({ settings }: { settings: MerchantSettings }) {
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState(settings.brandName);
  const [logo, setLogo] = useState(settings.logoUrl ?? '');
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const nameError = name.trim() ? '' : 'Enter your business name.';
  const logoProblem = logoError(logo.trim());
  return (
    <form
      noValidate
      className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-start"
      onSubmit={event => {
        event.preventDefault();
        start(async () => {
          setTried(true);
          setError('');
          if (nameError || logoProblem) return;
          const result = await updateSettings({ brandName: name.trim(), logoUrl: logo.trim() || null });
          if (!result.ok) return setError(result.error.message);
          toast('Brand saved');
          router.refresh();
        });
      }}
    >
      <Field label="Business name" error={tried && nameError ? nameError : undefined}>
        {id => (
          <Input
            id={id}
            value={name}
            maxLength={80}
            aria-invalid={tried && Boolean(nameError)}
            onChange={e => setName(e.target.value)}
          />
        )}
      </Field>
      <Field label="Logo URL" error={tried && logoProblem ? logoProblem : undefined}>
        {id => (
          <Input
            id={id}
            type="url"
            value={logo}
            placeholder="https://…"
            aria-invalid={tried && Boolean(logoProblem)}
            onChange={e => setLogo(e.target.value)}
          />
        )}
      </Field>
      <Button type="submit" variant="dark" className="sm:mt-[26px]" disabled={pending}>
        {pending ? 'Saving…' : 'Save brand'}
      </Button>
      {error && (
        <Notice tone="danger" className="sm:col-span-3">
          {error}
        </Notice>
      )}
    </form>
  );
}
