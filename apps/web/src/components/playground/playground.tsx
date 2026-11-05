'use client';

import {
  IconCheck,
  IconCode,
  IconDeviceDesktop,
  IconDeviceMobile,
  IconLink,
  IconPalette,
  IconPhoto,
  IconSparkles,
} from '@tabler/icons-react';
import Link from 'next/link';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/cn';
import { PactLogo } from '../brand/pact-logo';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { CodeBlock } from '../ui/code-block';
import { Dialog } from '../ui/dialog';
import { AmountInput, Field, Input, Select } from '../ui/field';
import { codeTabs, generatedCode, previewOnly, type CodeTab } from './code';
import {
  allMethods,
  configToSearch,
  LIMITS,
  LOGO_BYTES,
  primaryTextColor,
  shareableLogo,
  validAmount,
  type EmbedMode,
  type FontChoice,
  type PaymentType,
  type PlaygroundConfig,
  type PlaygroundFeatures,
  type PlaygroundView,
  type PreviewMethod,
  type PreviewStep,
} from './config';
import { EmbedStage } from './embed-stage';
import { Iphone } from './preview/iphone';
import { Safari } from './preview/safari';

const steps: Array<{ value: PreviewStep; label: string }> = [
  { value: 'information', label: 'Information' },
  { value: 'payment', label: 'Payment' },
  { value: 'processing', label: 'Processing' },
  { value: 'success', label: 'Success' },
  { value: 'refund', label: 'Refund' },
  { value: 'expired', label: 'Expired' },
  { value: 'failed', label: 'Failed' },
];

const layouts: Array<{ value: EmbedMode; label: string }> = [
  { value: 'link', label: 'Full page' },
  { value: 'inline', label: 'Embedded' },
  { value: 'modal', label: 'Popup' },
];

const methodLabels: Record<PreviewMethod, { label: string; preview: boolean }> = {
  account: { label: 'Account balance', preview: false },
  card: { label: 'Card', preview: true },
  bank: { label: 'Bank transfer', preview: true },
};

const swatches = [
  ['Pact lime', '#c6ff34'],
  ['Blue', '#2463eb'],
  ['Violet', '#7055d8'],
  ['Green', '#13845a'],
  ['Amber', '#b76d20'],
  ['Rose', '#c54b6c'],
  ['Slate', '#334155'],
] as const;

const switchClass =
  'relative h-6 w-10 shrink-0 cursor-pointer appearance-none rounded-full bg-input transition-colors before:absolute before:top-0.5 before:left-0.5 before:size-5 before:rounded-full before:bg-white before:shadow before:transition-transform checked:bg-foreground checked:before:translate-x-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:before:transition-none';

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-1">
      <h2 className="pb-1 text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function PreviewBadge() {
  return (
    <Badge
      tone="outline"
      className="py-0 text-[12px]"
      title="Shown in this preview only; the real checkout cannot do it yet"
    >
      Preview
    </Badge>
  );
}

function SwitchRow({
  label,
  preview,
  checked,
  disabled,
  onChange,
  hint,
}: {
  label: string;
  preview?: boolean;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 text-sm has-[:disabled]:cursor-not-allowed">
      <span className="grid">
        <span className="flex items-center gap-2">
          {label}
          {preview && <PreviewBadge />}
        </span>
        {hint && <span className="text-[12px] text-muted-foreground">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.target.checked)}
        className={switchClass}
      />
    </label>
  );
}

/** Builds the checkout's look and features, previews it in a device frame and hands over the code. */
export function Playground({ initial }: { initial: { config: PlaygroundConfig; view: PlaygroundView } }) {
  const [config, setConfig] = useState(initial.config);
  const [step, setStep] = useState<PreviewStep>(initial.view.step);
  const [device, setDevice] = useState(initial.view.device);
  const [panel, setPanel] = useState<'features' | 'style'>('features');
  const [email, setEmail] = useState('');
  const [amountDraft, setAmountDraft] = useState(initial.config.amount);
  const [hexDraft, setHexDraft] = useState(initial.config.primary);
  const [uploadError, setUploadError] = useState('');
  const [shared, setShared] = useState<'copied' | 'failed' | null>(null);
  const [codeOpen, setCodeOpen] = useState(false);
  const [tab, setTab] = useState<CodeTab>('React');
  const tabs = useId();
  const featuresTab = useRef<HTMLButtonElement>(null);
  const styleTab = useRef<HTMLButtonElement>(null);
  const firstRender = useRef(true);

  // Small screens open in the phone frame unless the link names a device.
  useEffect(() => {
    if (
      !new URLSearchParams(window.location.search).has('d') &&
      window.matchMedia('(max-width: 639px)').matches
    )
      setDevice('phone');
  }, []);

  // The address bar always holds the share link for what is on screen.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    window.history.replaceState(
      null,
      '',
      window.location.pathname + configToSearch(config, { step, device }),
    );
  }, [config, step, device]);

  const update = <K extends keyof PlaygroundConfig>(key: K, value: PlaygroundConfig[K]) =>
    setConfig(current => ({ ...current, [key]: value }));
  const feature = (key: keyof PlaygroundFeatures, value: boolean) =>
    setConfig(current => ({ ...current, features: { ...current.features, [key]: value } }));
  const toggleMethod = (method: PreviewMethod, on: boolean) =>
    setConfig(current => {
      const next = allMethods.filter(m => (m === method ? on : current.methods.includes(m)));
      return next.length ? { ...current, methods: next } : current;
    });

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type))
      return setUploadError('Choose a PNG, JPEG, WebP or SVG image.');
    if (file.size > LOGO_BYTES) return setUploadError('Choose an image under 24 KB.');
    setUploadError('');
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') update('logo', reader.result);
    };
    reader.onerror = () => setUploadError('That image could not be read. Try another file.');
    reader.readAsDataURL(file);
  };

  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShared('copied');
    } catch {
      setShared('failed');
    }
    window.setTimeout(() => setShared(null), 2400);
  };

  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = panel === 'features' ? 'style' : 'features';
    setPanel(next);
    (next === 'features' ? featuresTab : styleTab).current?.focus();
  };

  const logoLeftOut = config.logo !== '' && !shareableLogo(config.logo);
  const amountError = validAmount(amountDraft) ? undefined : 'Enter an amount above $0, up to two decimals.';
  const previewNotes = previewOnly(config);

  const stage = (
    <EmbedStage
      config={config}
      step={step}
      onStep={setStep}
      device={device}
      email={email}
      onEmailChange={setEmail}
    />
  );

  return (
    <div className="min-h-[calc(100dvh-2.5rem)] bg-background [.no-demo_&]:min-h-dvh">
      <header className="border-b border-border bg-card">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3 sm:px-6">
          <Link href="/dashboard" aria-label="Pact dashboard" className="rounded-md">
            <PactLogo width={92} />
          </Link>
          <h1 className="border-l border-border pl-5 text-base font-semibold">Checkout playground</h1>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="hidden md:inline">Explore other checkout formats</span>
            <span className="sr-only md:hidden">Checkout format</span>
            <Select
              aria-label="Checkout format"
              value={config.embed}
              onChange={event => update('embed', event.target.value as EmbedMode)}
              className="h-9 w-auto rounded-full py-0 text-sm font-medium"
            >
              {layouts.map(layout => (
                <option key={layout.value} value={layout.value}>
                  {layout.label}
                </option>
              ))}
            </Select>
          </label>
          <div className="ml-auto flex items-center gap-2">
            <span className="sr-only" role="status">
              {shared === 'copied'
                ? 'Share link copied'
                : shared === 'failed'
                  ? 'Copy the link from the address bar'
                  : ''}
            </span>
            <Button variant="ghost" size="sm" onClick={() => void share()}>
              {shared === 'copied' ? (
                <IconCheck aria-hidden className="size-4" />
              ) : (
                <IconLink aria-hidden className="size-4" />
              )}
              {shared === 'copied'
                ? logoLeftOut
                  ? 'Copied, without the logo'
                  : 'Link copied'
                : shared === 'failed'
                  ? 'Copy from the address bar'
                  : 'Share'}
            </Button>
            <Button variant="primary" size="sm" onClick={() => setCodeOpen(true)}>
              <IconCode aria-hidden className="size-4" />
              Start building
            </Button>
          </div>
        </div>
      </header>

      <div className="grid gap-4 p-4 sm:p-6 lg:grid-cols-[350px_minmax(0,1fr)] lg:items-start">
        <aside
          aria-label="Checkout settings"
          className="min-w-0 rounded-2xl border border-border bg-card shadow-panel lg:sticky lg:top-14 lg:max-h-[calc(100dvh-7.5rem)] lg:overflow-y-auto"
        >
          <div
            role="tablist"
            aria-label="Settings"
            className="sticky top-0 z-10 flex border-b border-border bg-card px-3"
          >
            {(
              [
                ['features', 'Features', IconSparkles, featuresTab],
                ['style', 'Style', IconPalette, styleTab],
              ] as const
            ).map(([value, label, Icon, ref]) => (
              <button
                key={value}
                ref={ref}
                type="button"
                role="tab"
                id={`${tabs}-${value}-tab`}
                aria-controls={`${tabs}-${value}`}
                aria-selected={panel === value}
                tabIndex={panel === value ? 0 : -1}
                onClick={() => setPanel(value)}
                onKeyDown={onTabKey}
                className={cn(
                  '-mb-px flex flex-1 items-center justify-center gap-2 border-b-2 px-3 py-4 text-sm font-medium transition-colors',
                  panel === value
                    ? 'border-foreground text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon aria-hidden className="size-4.5" />
                {label}
              </button>
            ))}
          </div>

          <div
            role="tabpanel"
            id={`${tabs}-features`}
            aria-labelledby={`${tabs}-features-tab`}
            hidden={panel !== 'features'}
            className="grid gap-7 p-5"
          >
            <Group title="Payment setup">
              <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
                Payment type
                <Select
                  value={config.type}
                  onChange={event => update('type', event.target.value as PaymentType)}
                  className="h-9 w-auto rounded-full py-0 text-sm"
                >
                  <option value="one-time">One-time payment</option>
                  <option value="recurring">Recurring payment</option>
                  <option value="invoice">Invoice payment</option>
                </Select>
              </label>
              <SwitchRow
                label="Promotion codes"
                preview
                checked={config.features.promo}
                onChange={v => feature('promo', v)}
              />
              <SwitchRow
                label="Calculate tax"
                preview
                checked={config.features.tax}
                onChange={v => feature('tax', v)}
              />
              <SwitchRow
                label="Suggest product"
                preview
                checked={config.features.upsell}
                disabled={config.type === 'invoice'}
                hint={config.type === 'invoice' ? 'Not offered on invoices' : undefined}
                onChange={v => feature('upsell', v)}
              />
            </Group>

            <Group title="Payment methods">
              <div role="group" aria-label="Payment methods">
                {allMethods.map(method => (
                  <SwitchRow
                    key={method}
                    label={methodLabels[method].label}
                    preview={methodLabels[method].preview}
                    checked={config.methods.includes(method)}
                    disabled={config.methods.length === 1 && config.methods.includes(method)}
                    onChange={on => toggleMethod(method, on)}
                  />
                ))}
              </div>
              <p className="text-[12px] text-muted-foreground">Keep at least one method on.</p>
            </Group>

            <Group title="Wallet">
              <SwitchRow
                label="Low wallet balance"
                checked={config.features.lowBalance}
                hint="Shows what a payer with too little balance sees"
                onChange={v => feature('lowBalance', v)}
              />
            </Group>

            <Group title="Customer details">
              <SwitchRow
                label="Phone"
                preview
                checked={config.features.phone}
                onChange={v => feature('phone', v)}
              />
              <SwitchRow
                label="Billing address"
                preview
                checked={config.features.billing}
                onChange={v => feature('billing', v)}
              />
              <SwitchRow
                label="Shipping address"
                preview
                checked={config.features.shipping}
                onChange={v => feature('shipping', v)}
              />
            </Group>

            <Group title="Payment details">
              <Field label="Amount" error={amountError} hint="In dollars. The payer always sees dollars.">
                {id => (
                  <AmountInput
                    id={id}
                    value={amountDraft}
                    aria-invalid={amountError ? true : undefined}
                    onChange={event => {
                      const value = event.target.value;
                      if (!/^\d{0,7}(\.\d{0,2})?$/.test(value)) return;
                      setAmountDraft(value);
                      if (validAmount(value)) update('amount', value);
                    }}
                  />
                )}
              </Field>
            </Group>

            <Group title="Advanced options">
              <Field label="Continue button label" hint="The button on the information step.">
                {id => (
                  <Input
                    id={id}
                    value={config.buttonLabel}
                    maxLength={LIMITS.buttonLabel}
                    onFocus={() => setStep('information')}
                    onChange={event => update('buttonLabel', event.target.value)}
                  />
                )}
              </Field>
            </Group>

            {previewNotes.length > 0 && (
              <p className="rounded-xl bg-raised px-3 py-2.5 text-[13px] text-muted-foreground">
                Settings marked Preview show in this preview only. The real checkout does not offer them yet.
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                setPanel('style');
                styleTab.current?.focus();
              }}
              className="flex items-center justify-between rounded-xl border border-border px-4 py-3 text-left text-sm hover:bg-raised"
            >
              Make checkout feel like your brand
              <span className="flex items-center gap-1.5 font-medium">
                Customize style <IconPalette aria-hidden className="size-4" />
              </span>
            </button>
          </div>

          <div
            role="tabpanel"
            id={`${tabs}-style`}
            aria-labelledby={`${tabs}-style-tab`}
            hidden={panel !== 'style'}
            className="grid gap-7 p-5"
          >
            <Group title="Theme">
              <div role="group" aria-label="Theme" className="grid grid-cols-2 gap-2">
                {(['light', 'dark'] as const).map(theme => (
                  <button
                    key={theme}
                    type="button"
                    aria-pressed={config.theme === theme}
                    onClick={() => update('theme', theme)}
                    className={cn(
                      'grid gap-2 rounded-xl border p-2 text-left text-sm font-medium transition-colors',
                      config.theme === theme
                        ? 'border-foreground'
                        : 'border-border hover:border-foreground/40',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'grid h-14 grid-cols-[1fr_1.4fr] gap-1.5 rounded-lg p-2',
                        theme === 'light' ? 'bg-[#f3f4f6]' : 'bg-[#090909]',
                      )}
                    >
                      <span className="grid content-start gap-1">
                        <i
                          className={cn(
                            'h-1.5 w-8 rounded-full',
                            theme === 'light' ? 'bg-[#d3d6dc]' : 'bg-[#333]',
                          )}
                        />
                        <i
                          className={cn(
                            'h-2.5 w-10 rounded-full',
                            theme === 'light' ? 'bg-[#0e1116]' : 'bg-[#f2f3f5]',
                          )}
                        />
                      </span>
                      <span className={cn('rounded-md', theme === 'light' ? 'bg-white' : 'bg-[#121212]')} />
                    </span>
                    <span className="flex items-center justify-between px-1">
                      {theme === 'light' ? 'Light' : 'Dark'}
                      {config.theme === theme && <IconCheck aria-hidden className="size-4" />}
                    </span>
                  </button>
                ))}
              </div>
            </Group>

            <Group title="Brand color">
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  aria-label="Brand color picker"
                  value={config.primary}
                  onChange={event => {
                    update('primary', event.target.value);
                    setHexDraft(event.target.value);
                  }}
                  className="size-11 shrink-0 cursor-pointer rounded-xl border border-input bg-card p-1"
                />
                <Input
                  aria-label="Brand color hex value"
                  value={hexDraft}
                  maxLength={7}
                  spellCheck={false}
                  aria-invalid={/^#[0-9a-f]{6}$/i.test(hexDraft) ? undefined : true}
                  onChange={event => {
                    const value = event.target.value.startsWith('#')
                      ? event.target.value
                      : `#${event.target.value}`;
                    if (!/^#[0-9a-fA-F]{0,6}$/.test(value)) return;
                    setHexDraft(value);
                    if (value.length === 7) update('primary', value.toLowerCase());
                  }}
                  className="font-mono"
                />
              </div>
              <div role="group" aria-label="Brand color presets" className="mt-2 flex flex-wrap gap-2">
                {swatches.map(([name, value]) => (
                  <button
                    key={value}
                    type="button"
                    aria-label={name}
                    aria-pressed={config.primary.toLowerCase() === value}
                    onClick={() => {
                      update('primary', value);
                      setHexDraft(value);
                    }}
                    style={{ background: value, color: primaryTextColor(value) }}
                    className="grid size-8 place-items-center rounded-full ring-offset-2 ring-offset-card aria-pressed:ring-2 aria-pressed:ring-foreground"
                  >
                    {config.primary.toLowerCase() === value && <IconCheck aria-hidden className="size-4" />}
                  </button>
                ))}
              </div>
            </Group>

            <Group title="Typography and shape">
              <label className="flex min-h-11 items-center justify-between gap-3 text-sm">
                Font
                <Select
                  value={config.font}
                  onChange={event => update('font', event.target.value as FontChoice)}
                  className="h-9 w-auto rounded-full py-0 text-sm"
                >
                  <option value="system">Geist</option>
                  <option value="serif">Serif</option>
                  <option value="mono">Monospace</option>
                </Select>
              </label>
              <label className="grid gap-2 py-2 text-sm">
                <span className="flex justify-between">
                  Corner radius{' '}
                  <output className="text-muted-foreground tabular-nums">{config.radius}px</output>
                </span>
                <input
                  type="range"
                  min={0}
                  max={LIMITS.radius}
                  value={config.radius}
                  onChange={event => update('radius', Number(event.target.value))}
                  className="w-full accent-foreground"
                />
              </label>
            </Group>

            <Group title="Business details">
              <Field label="Business name">
                {id => (
                  <Input
                    id={id}
                    value={config.brandName}
                    maxLength={LIMITS.brandName}
                    onChange={event => update('brandName', event.target.value)}
                  />
                )}
              </Field>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-xl border border-border bg-raised text-muted-foreground">
                  {config.logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={config.logo} alt="Current logo" className="size-full object-contain" />
                  ) : (
                    <IconPhoto aria-hidden className="size-5" />
                  )}
                </span>
                <label className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-full border border-border px-3.5 text-sm font-medium hover:bg-raised has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring">
                  <IconPhoto aria-hidden className="size-4" />
                  {config.logo ? 'Replace logo' : 'Upload logo'}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    onChange={upload}
                    className="sr-only"
                  />
                </label>
                {config.logo && (
                  <Button variant="ghost" size="sm" onClick={() => update('logo', '')}>
                    Remove
                  </Button>
                )}
              </div>
              <p className="text-[12px] text-muted-foreground">PNG, JPEG, WebP or SVG, up to 24 KB.</p>
              {uploadError && (
                <p role="alert" className="text-[13px] text-destructive">
                  {uploadError}
                </p>
              )}
              {logoLeftOut && (
                <p className="text-[13px] text-muted-foreground" data-testid="logo-not-shared">
                  This logo is too large for a share link, so shared links show the business initial instead.
                  Logos under 2 KB are included.
                </p>
              )}
            </Group>
          </div>
        </aside>

        <section aria-label="Checkout preview" className="grid min-w-0 justify-items-center gap-4">
          {device === 'phone' ? (
            <Iphone
              className="w-full"
              style={{ maxWidth: 'min(390px, calc((100dvh - 12rem) * 433 / 882))', minWidth: 300 }}
            >
              <div className="min-h-full pt-11">{stage}</div>
            </Iphone>
          ) : (
            <Safari
              url="Pact Checkout"
              className="w-full"
              style={{ maxWidth: 'max(640px, calc((100dvh - 12rem) * 1203 / 753))' }}
            >
              {stage}
            </Safari>
          )}
          <div
            role="toolbar"
            aria-label="Preview controls"
            className="flex flex-wrap items-center justify-center gap-3"
          >
            <div
              role="group"
              aria-label="Device"
              className="flex rounded-full border border-border bg-card p-1"
            >
              {(
                [
                  ['desktop', 'Desktop view', IconDeviceDesktop],
                  ['phone', 'Phone view', IconDeviceMobile],
                ] as const
              ).map(([value, label, Icon]) => (
                <button
                  key={value}
                  type="button"
                  aria-label={label}
                  aria-pressed={device === value}
                  onClick={() => setDevice(value)}
                  className={cn(
                    'grid size-8 place-items-center rounded-full transition-colors',
                    device === value
                      ? 'bg-chip text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon aria-hidden className="size-4.5" />
                </button>
              ))}
            </div>
            <Select
              aria-label="Checkout state"
              value={step}
              onChange={event => setStep(event.target.value as PreviewStep)}
              className="h-10 w-auto rounded-full py-0 text-sm"
            >
              {steps.map(item => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </Select>
            <span className="text-[13px] text-muted-foreground">Preview only. No payment is made.</span>
          </div>
        </section>
      </div>

      <Dialog
        open={codeOpen}
        onClose={() => setCodeOpen(false)}
        title="Start building"
        description="Code for this configuration. Keep the API key on your server."
        className="sm:max-w-3xl"
      >
        <div className="grid gap-3">
          <div role="tablist" aria-label="Code language" className="flex flex-wrap gap-1">
            {codeTabs.map(item => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={tab === item}
                onClick={() => setTab(item)}
                className={cn(
                  'h-9 rounded-full px-3.5 text-sm font-medium transition-colors',
                  tab === item ? 'bg-foreground text-background' : 'text-subtle-foreground hover:bg-chip',
                )}
              >
                {item}
              </button>
            ))}
          </div>
          <div role="tabpanel" aria-label={`${tab} code`}>
            <CodeBlock
              title={tab === 'curl' ? 'Terminal' : tab === 'Node server' ? 'server.ts' : 'checkout.tsx'}
              code={generatedCode(tab, config)}
            />
          </div>
        </div>
      </Dialog>
    </div>
  );
}
