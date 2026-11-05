'use client';

import { IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { toMinor, usd } from '@/lib/format';
import { cn } from '@/lib/cn';
import { CheckoutPreview } from './checkout-preview';
import { validAmount, type Device, type PlaygroundConfig, type PreviewStep } from './config';

/**
 * Shows the checkout where a merchant would put it: the hosted page a link opens, inline on the
 * merchant's order page, or as a popup over their store. The device frame wraps all three.
 */
export function EmbedStage({
  config,
  step,
  onStep,
  device,
  email,
  onEmailChange,
}: {
  config: PlaygroundConfig;
  step: PreviewStep;
  onStep: (step: PreviewStep) => void;
  device: Device;
  email: string;
  onEmailChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const preview = (embedded: boolean) => (
    <CheckoutPreview
      config={config}
      step={step}
      onStep={onStep}
      email={email}
      onEmailChange={onEmailChange}
      embedded={embedded}
    />
  );
  if (config.embed === 'link') return preview(false);

  const phone = device === 'phone';
  const brandName = config.brandName || 'Your business';
  const price = usd(validAmount(config.amount) ? toMinor(config.amount) : 0n);
  const product =
    config.type === 'invoice'
      ? 'Invoice INV-2026-001'
      : config.type === 'recurring'
        ? 'Growth plan'
        : 'Brand identity package';
  return (
    <div className={`theme-${config.theme} relative min-h-full bg-background text-foreground`}>
      <div className="flex items-center gap-5 border-b border-border bg-card px-5 py-3 text-sm">
        <strong className="font-semibold">{brandName}</strong>
        {!phone && (
          <span aria-hidden className="flex gap-4 text-muted-foreground">
            <span>Work</span>
            <span>Pricing</span>
            <span>Contact</span>
          </span>
        )}
      </div>
      <div className={cn('grid gap-6 p-5', !phone && 'grid-cols-[minmax(0,1fr)_minmax(0,1fr)] p-8')}>
        <div className="grid content-start gap-3">
          <div aria-hidden className="aspect-[4/3] rounded-2xl bg-linear-to-br from-chip to-border" />
          <h2 className="text-xl font-semibold">{product}</h2>
          <p className="text-sm text-muted-foreground">
            {config.type === 'recurring'
              ? 'Billed every month. Cancel anytime.'
              : 'Logo, type and a one-page guide, delivered in two weeks.'}
          </p>
          <p className="text-lg font-semibold tabular-nums">{price}</p>
          {config.embed === 'modal' && (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="h-10 justify-self-start rounded-full bg-foreground px-5 text-sm font-semibold text-background"
            >
              {config.type === 'recurring'
                ? 'Subscribe'
                : config.type === 'invoice'
                  ? 'Pay invoice'
                  : 'Buy now'}
            </button>
          )}
        </div>
        {config.embed === 'inline' && (
          <div className="min-w-0 overflow-hidden rounded-2xl border border-border shadow-panel">
            {preview(true)}
          </div>
        )}
      </div>
      {config.embed === 'modal' && open && (
        <div
          className={cn(
            'absolute inset-0 z-10 flex justify-center bg-black/45 p-4',
            phone ? 'items-end p-0' : 'items-start pt-10',
          )}
        >
          <div
            role="group"
            aria-label="Checkout popup"
            className={cn(
              'w-full max-w-[440px] overflow-hidden border border-border bg-card shadow-pop',
              phone ? 'rounded-t-3xl' : 'rounded-3xl',
            )}
          >
            <div className="flex justify-end px-3 pt-3">
              <button
                type="button"
                aria-label="Close the checkout popup"
                onClick={() => setOpen(false)}
                className="grid size-8 place-items-center rounded-full text-muted-foreground hover:bg-chip hover:text-foreground"
              >
                <IconX aria-hidden className="size-4" />
              </button>
            </div>
            {preview(true)}
          </div>
        </div>
      )}
    </div>
  );
}
