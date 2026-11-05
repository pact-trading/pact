import { IconCircleCheckFilled, IconReceiptRefund } from '@tabler/icons-react';
import { PublicRecord } from '../states/public-record';
import { dateTime, usd } from '@/lib/format';

/** What the customer keeps: who they paid, for what, when, and every refund. */
export function Receipt({
  merchant,
  item,
  amountMinor,
  paidAt,
  txHash,
  refunds = [],
  reference,
  method,
  title = 'Payment complete',
  note,
}: {
  merchant: string;
  item: string;
  amountMinor: string;
  paidAt: string;
  txHash: string | null;
  refunds?: Array<{
    id: string;
    amountMinor: string;
    reason: string;
    createdAt: string;
    txHash: string | null;
  }>;
  reference: string;
  /** How it was paid, e.g. "Visa ending 4242". */
  method?: string;
  title?: string;
  /** A line under the title, e.g. "Sample receipt" in the Playground. */
  note?: string;
}) {
  const refunded = refunds.reduce((t, r) => t + BigInt(r.amountMinor), 0n);
  return (
    <div className="grid gap-5">
      <div className="flex items-center gap-3">
        {refunded > 0n && refunded >= BigInt(amountMinor) ? (
          <IconReceiptRefund aria-hidden className="size-9 text-success" />
        ) : (
          <IconCircleCheckFilled aria-hidden className="size-9 text-success" />
        )}
        <div>
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="text-sm text-muted-foreground">{note ?? dateTime(paidAt)}</p>
        </div>
      </div>
      <dl className="divide-y divide-border-subtle rounded-2xl border border-border">
        {[
          ['Paid to', merchant],
          ['For', item],
          ['Amount', usd(amountMinor)],
          ...(method ? [['Paid with', method]] : []),
          ['Fees', 'None'],
          ...(refunded > 0n ? [['Refunded', `−${usd(refunded)}`]] : []),
          ['Reference', reference],
        ].map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="text-right text-[15px] font-medium [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      {refunds.length > 0 && (
        <div className="grid gap-2">
          {refunds.map(r => (
            <div
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-2xl bg-raised px-4 py-3 text-sm"
            >
              <span className="flex items-center gap-2">
                <IconReceiptRefund className="size-4 text-success" />
                Refund of {usd(r.amountMinor)} · {r.reason} · {dateTime(r.createdAt)}
              </span>
              <PublicRecord hash={r.txHash} audience="customer" />
            </div>
          ))}
        </div>
      )}
      <PublicRecord hash={txHash} audience="customer" className="justify-self-start" />
    </div>
  );
}
