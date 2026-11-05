import { IconAlertTriangle, IconCircleCheck, IconInfoCircle } from '@tabler/icons-react';
import type { FinancedInvoice } from '@/server/data/parts/financing';
import { usd } from '@/lib/format';
import { percent } from '../merchant/financing/financing-parts';

/**
 * Plain risk notes from the merchant's own records and the contract's rules. They are labelled as
 * assumptions: Pact does not underwrite, score or guarantee these invoices.
 */
export function RiskNotes({ invoice }: { invoice: FinancedInvoice }) {
  const debtor = invoice.debtor.company ?? invoice.debtor.name;
  const { invoicesPaid, invoicesOverdue, invoicesPaidLate } = invoice.debtorHistory;
  const { terms } = invoice;
  const lateHistory = invoicesOverdue + invoicesPaidLate > 0;
  const notes = [
    invoice.acknowledged
      ? { tone: 'good', text: `${debtor} signed “I owe this invoice”, recorded onchain.` }
      : { tone: 'warn', text: `${debtor} has not acknowledged this invoice yet.` },
    {
      tone: lateHistory ? 'warn' : 'info',
      text: `With ${invoice.merchantName}, ${debtor} has ${invoicesPaid} other invoice${invoicesPaid === 1 ? '' : 's'} paid (${invoicesPaidLate} late) and ${invoicesOverdue} overdue now.`,
    },
    {
      tone: 'info',
      text: `Priced at ${terms.pricing.days} days × ${percent(terms.pricing.dayRateBps)}${terms.pricing.latePremiumBps ? `, plus ${percent(terms.pricing.latePremiumBps)} for the late history` : ''}: the same rule for every invoice, not a credit score.`,
    },
    {
      tone: 'good',
      text: `${debtor} pays through the usual payment link and the contract sends it straight to the holders. ${invoice.merchantName} cannot redirect it.`,
    },
    {
      tone: 'good',
      text: `The contract holds ${percent(terms.reserveBps)} of what you buy as a reserve. Paid within ${terms.graceDays} days after maturity: you get a ${percent(terms.lateFeeBps)} late fee from it. Unpaid after that: you get the reserve, and ${invoice.merchantName} owes you the rest as a buy-back.`,
    },
    {
      tone: 'warn',
      text: `The buy-back is ${invoice.merchantName}’s obligation, recorded onchain, beyond the ${usd(terms.reserveMinor)} reserve. Pact does not guarantee it.`,
    },
  ] as const;
  return (
    <ul className="grid gap-3 text-sm">
      {notes.map(note => (
        <li key={note.text} className="flex gap-2.5">
          {note.tone === 'good' ? (
            <IconCircleCheck aria-hidden className="mt-0.5 size-4.5 shrink-0 text-success" />
          ) : note.tone === 'warn' ? (
            <IconAlertTriangle aria-hidden className="mt-0.5 size-4.5 shrink-0 text-warning" />
          ) : (
            <IconInfoCircle aria-hidden className="mt-0.5 size-4.5 shrink-0 text-muted-foreground" />
          )}
          <span className="text-subtle-foreground">{note.text}</span>
        </li>
      ))}
    </ul>
  );
}
