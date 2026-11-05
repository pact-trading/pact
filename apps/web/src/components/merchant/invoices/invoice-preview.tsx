import { IconLock } from '@tabler/icons-react';
import { date, usd } from '@/lib/format';

/** Black or white text, whichever reads better on `hex`. */
export function inkOn(hex: string) {
  const value = /^#[0-9a-f]{6}$/i.test(hex) ? hex.slice(1) : 'c6ff34';
  const [r, g, b] = [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16) / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.4 ? '#0e1116' : '#ffffff';
}

export interface PreviewLine {
  key: string;
  description: string;
  quantity: number;
  amountMinor: bigint;
}

/**
 * What the payer sees when they open the invoice link, drawn from the same figures the
 * server stores. The pay button is inert: this is a preview.
 */
export function InvoicePreview({
  merchantName,
  logoUrl,
  brandColor,
  number,
  customerName,
  customerEmail,
  lines,
  totalMinor,
  paidMinor = 0n,
  dueAt,
  memo,
  allowPartial,
}: {
  merchantName: string;
  logoUrl: string | null;
  brandColor: string;
  number: string;
  customerName: string | null;
  customerEmail: string;
  lines: PreviewLine[];
  totalMinor: bigint;
  paidMinor?: bigint;
  dueAt: string | null;
  memo: string;
  allowPartial: boolean;
}) {
  const remaining = totalMinor - paidMinor;
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-background">
      <div className="flex items-center gap-3 border-b border-border bg-card px-5 py-4">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" className="size-9 rounded-xl object-cover" />
        ) : (
          <span
            aria-hidden
            className="grid size-9 place-items-center rounded-xl text-sm font-semibold"
            style={{ background: brandColor, color: inkOn(brandColor) }}
          >
            {merchantName.slice(0, 1).toUpperCase()}
          </span>
        )}
        <div className="min-w-0">
          <p className="truncate font-semibold">{merchantName}</p>
          <p className="text-[13px] text-muted-foreground">Invoice {number}</p>
        </div>
      </div>
      <div className="grid gap-4 p-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="text-sm text-muted-foreground">Prepared for</p>
            <p className="font-medium">{customerName || customerEmail}</p>
            {customerName && <p className="text-[13px] text-muted-foreground">{customerEmail}</p>}
          </div>
          <div className="text-right">
            <p className="text-sm text-muted-foreground">Amount due</p>
            <p className="text-2xl font-semibold tracking-tight">{usd(remaining)}</p>
            <p className="text-[13px] text-muted-foreground">
              {dueAt ? `Due ${date(dueAt)}` : 'Due on receipt'}
            </p>
          </div>
        </div>
        <ul className="divide-y divide-border-subtle rounded-xl border border-border bg-card text-sm">
          {lines.length === 0 && <li className="px-4 py-3 text-muted-foreground">No line items yet</li>}
          {lines.map(line => (
            <li key={line.key} className="flex justify-between gap-3 px-4 py-3">
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {line.description || 'Untitled item'}
                {line.quantity > 1 && <span className="text-muted-foreground"> × {line.quantity}</span>}
              </span>
              <span className="shrink-0 font-medium">{usd(line.amountMinor)}</span>
            </li>
          ))}
          <li className="flex justify-between gap-3 px-4 py-3 font-semibold">
            <span>Total</span>
            <span>{usd(totalMinor)}</span>
          </li>
          {paidMinor > 0n && (
            <li className="flex justify-between gap-3 px-4 py-3 text-muted-foreground">
              <span>Already paid</span>
              <span>−{usd(paidMinor)}</span>
            </li>
          )}
        </ul>
        {memo && <p className="rounded-xl bg-raised p-3 text-sm text-subtle-foreground">{memo}</p>}
        <div
          aria-hidden
          className="flex h-11 items-center justify-center rounded-full text-[15px] font-semibold"
          style={{ background: brandColor, color: inkOn(brandColor) }}
        >
          Pay {usd(remaining)}
        </div>
        <p className="flex items-center justify-center gap-1.5 text-center text-[13px] text-muted-foreground">
          <IconLock className="size-3.5" />
          {allowPartial ? 'Pay in full or in parts.' : 'Paid in full.'} Sign in with email or a passkey.
        </p>
      </div>
    </div>
  );
}
