'use client';

import { IconExternalLink, IconShare } from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { Button } from '../../ui/button';
import { CodeBlock } from '../../ui/code-block';
import { CopyButton } from '../../ui/copy-button';
import { Dialog } from '../../ui/dialog';

/** A hosted link with copy, QR code and an "open" button. Products and invoices share it. */
export function ShareDialog({
  name,
  url,
  qr,
  disabled,
  disabledReason = 'Activate the product to share it',
  label = 'Share',
  description = 'A hosted checkout anyone can pay with email or a passkey.',
  openLabel = 'Open checkout',
  note = 'Payments made through this link show up in Orders. The price is fixed by the server; editing the product later never changes a paid order.',
  snippet = true,
}: {
  name: string;
  url: string;
  qr: ReactNode;
  disabled?: boolean;
  disabledReason?: string;
  label?: string;
  description?: string;
  openLabel?: string;
  note?: ReactNode;
  snippet?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        onClick={() => setOpen(true)}
        disabled={disabled}
        title={disabled ? disabledReason : undefined}
      >
        <IconShare className="size-4" />
        {label}
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Share ${name}`} description={description}>
        <div className="grid gap-5 sm:grid-cols-[auto_1fr] sm:items-start">
          <div className="justify-self-center">{qr}</div>
          <div className="grid min-w-0 gap-3">
            <div className="flex min-w-0 items-center gap-1 rounded-[14px] border border-input bg-raised py-1 pr-1 pl-3.5">
              <code className="min-w-0 flex-1 truncate text-sm" title={url}>
                {url}
              </code>
              <CopyButton value={url} label="Copy link" showLabel />
            </div>
            <Button asChild size="sm" className="justify-self-start">
              <a href={url} target="_blank" rel="noreferrer">
                <IconExternalLink className="size-4" />
                {openLabel}
              </a>
            </Button>
            {note && <p className="text-[13px] text-muted-foreground">{note}</p>}
          </div>
        </div>
        {snippet && (
          <CodeBlock
            className="mt-5"
            title="Or link from your site"
            code={`<a href="${url}">Pay with Pact</a>`}
          />
        )}
      </Dialog>
    </>
  );
}
