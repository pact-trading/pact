import { IconReceiptRefund } from '@tabler/icons-react';
import { PublicRecord } from '../states/public-record';
import { dateTime, usd } from '@/lib/format';

/** A receipt for one refund: what came back, from whom, for what, and the public record. */
export function RefundReceipt({
  merchant,
  item,
  refund,
  reference,
  paidMinor,
  refundedBeforeMinor,
}: {
  merchant: string;
  item: string;
  refund: { id: string; amountMinor: string; reason: string; createdAt: string; txHash: string | null };
  /** The order the refund belongs to. */
  reference: string;
  paidMinor: string;
  /** Refunded on this order before this refund. */
  refundedBeforeMinor: bigint;
}) {
  const after = BigInt(paidMinor) - refundedBeforeMinor - BigInt(refund.amountMinor);
  return (
    <section className="grid gap-4 rounded-2xl border border-border bg-card p-5 shadow-panel sm:p-7">
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-full bg-success-soft text-success">
          <IconReceiptRefund className="size-5" />
        </span>
        <div>
          <h2 className="text-lg font-semibold">Refund receipt</h2>
          <p className="text-sm text-muted-foreground">{dateTime(refund.createdAt)}</p>
        </div>
      </div>
      <dl className="divide-y divide-border-subtle rounded-2xl border border-border">
        {[
          ['Refunded by', merchant],
          ['For', item],
          ['Amount', usd(refund.amountMinor)],
          ['Reason', refund.reason],
          ['Returned to', 'Your Pact balance'],
          ['You have paid', `${usd(after)} of ${usd(paidMinor)}`],
          ['Reference', `${refund.id} · ${reference}`],
        ].map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 px-4 py-3">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="text-right text-[15px] font-medium [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      <PublicRecord hash={refund.txHash} audience="customer" className="justify-self-start" />
    </section>
  );
}
