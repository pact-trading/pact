import {
  IconAlertTriangleFilled,
  IconCircleCheckFilled,
  IconCircleDashed,
  IconInfoCircle,
} from '@tabler/icons-react';
import type {
  FinancedInvoice,
  FinancingAssumptions,
  FinancingEvent,
  FinancingHolder,
  FinancingStatus,
  FinancingTerms,
} from '@/server/data/parts/financing';
import { cn } from '@/lib/cn';
import { date, dateTime, usd } from '@/lib/format';
import { PublicRecord } from '../../states/public-record';
import { Badge, type Tone } from '../../ui/badge';
import { DetailList } from '../../ui/card';
import { Notice } from '../../ui/notice';
import { Table, Td, Th, Tr } from '../../ui/table';
import { Timeline, type TimelineTone } from '../../ui/timeline';

/** "3%", "0.5%", "3.09%". */
export function percent(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

const tone: Record<FinancingStatus, Tone> = {
  eligible: 'outline',
  requested: 'warning',
  funded: 'success',
  overdue: 'danger',
  defaulted: 'danger',
  repaid: 'success',
  bought_back: 'neutral',
};

const merchantLabel: Record<FinancingStatus, string> = {
  eligible: 'Eligible',
  requested: 'Requested',
  funded: 'Funded',
  overdue: 'Overdue',
  defaulted: 'Defaulted',
  repaid: 'Repaid',
  bought_back: 'Bought back',
};

const investorLabel: Record<FinancingStatus, string> = { ...merchantLabel, requested: 'Listed' };

export function financingLabel(status: FinancingStatus, audience: 'merchant' | 'investor' = 'merchant') {
  return (audience === 'investor' ? investorLabel : merchantLabel)[status];
}

export function FinancingBadge({
  status,
  audience = 'merchant',
  className,
}: {
  status: FinancingStatus | null;
  audience?: 'merchant' | 'investor';
  className?: string;
}) {
  if (!status)
    return (
      <Badge tone="outline" className={className}>
        Not eligible
      </Badge>
    );
  return (
    <Badge tone={tone[status]} className={className}>
      <span aria-hidden className="size-1.5 rounded-full bg-current opacity-70" />
      {financingLabel(status, audience)}
    </Badge>
  );
}

/** The demo's fixed rules, labelled as assumptions wherever terms appear. */
export function AssumptionsNotice({
  assumptions: a,
  className,
}: {
  assumptions: FinancingAssumptions;
  className?: string;
}) {
  return (
    <Notice tone="info" title="Demo terms are assumptions" className={className}>
      Investors buy at {percent(a.dayRateBps)} off face value per day to maturity, plus{' '}
      {percent(a.latePremiumBps)} if the customer has paid late before. Pact keeps {percent(a.feeBps)} and the
      contract holds back {percent(a.reserveBps)} until the customer pays. Paid late: a{' '}
      {percent(a.lateFeeBps)} late fee from the reserve. Unpaid {a.graceDays} days after maturity: the reserve
      goes to the investors and the business buys back the rest. This is not underwriting, a credit score or a
      guarantee.
    </Notice>
  );
}

const assumption = <span className="text-[13px] font-normal text-muted-foreground">assumption</span>;

function discountLabel(terms: FinancingTerms) {
  const { dayRateBps, days, latePremiumBps } = terms.pricing;
  return `${days} days × ${percent(dayRateBps)}${latePremiumBps ? ` + ${percent(latePremiumBps)} late history` : ''}`;
}

/** The offer for the whole invoice, priced when it was listed. */
export function OfferTerms({
  terms,
  audience,
}: {
  terms: FinancingTerms;
  audience: 'merchant' | 'investor';
}) {
  if (audience === 'investor')
    return (
      <DetailList
        items={[
          { label: 'Face value', value: usd(terms.faceMinor), hint: 'What the customer owes' },
          {
            label: (
              <>
                Price ({percent(terms.discountBps)} discount, {assumption})
              </>
            ),
            value: usd(terms.priceMinor),
            hint: discountLabel(terms),
          },
          {
            label: 'Return if paid in full',
            value: `${usd(BigInt(terms.faceMinor) - BigInt(terms.priceMinor))} · ${percent(terms.returnBps)}`,
            hint: terms.days > 0 ? `About ${percent(terms.annualBps)} a year, simple` : undefined,
          },
          {
            label: 'Maturity',
            value: date(terms.maturityAt),
            hint: `${terms.days} day${terms.days === 1 ? '' : 's'} · transfers stop ${dateTime(terms.recordDateAt)}`,
          },
          {
            label: 'If paid late',
            value: `+${percent(terms.lateFeeBps)} late fee`,
            hint: `From the reserve, if paid within ${terms.graceDays} days of maturity`,
          },
          {
            label: 'If unpaid after that',
            value: 'Reserve, then buy-back',
            hint: `The ${percent(terms.reserveBps)} reserve is paid to holders; the business owes the rest`,
          },
        ]}
      />
    );
  return (
    <DetailList
      items={[
        { label: 'Face value', value: usd(terms.faceMinor) },
        {
          label: (
            <>
              Investors’ discount ({percent(terms.discountBps)}, {assumption})
            </>
          ),
          value: `−${usd(terms.discountMinor)}`,
          hint: discountLabel(terms),
        },
        {
          label: (
            <>
              Pact’s fee ({percent(terms.feeBps)}, {assumption})
            </>
          ),
          value: `−${usd(terms.feeMinor)}`,
        },
        {
          label: <span className="font-medium text-foreground">Net advance to you</span>,
          value: <span className="text-lg font-semibold">{usd(terms.netAdvanceMinor)}</span>,
          hint: 'If everything is sold and the customer pays on time',
        },
        {
          label: <>Paid when investors buy</>,
          value: usd(terms.upfrontMinor),
          hint: `The other ${usd(terms.reserveMinor)} (${percent(terms.reserveBps)}) is held as a reserve until the customer pays`,
        },
        {
          label: 'Maturity',
          value: date(terms.maturityAt),
          hint: `The invoice’s due date. Grace period until ${date(terms.graceEndsAt)}`,
        },
      ]}
    />
  );
}

/** How much of the invoice investors hold, as a bar. */
export function FundingBar({ invoice, className }: { invoice: FinancedInvoice; className?: string }) {
  const face = BigInt(invoice.terms.faceMinor);
  const sold = BigInt(invoice.funding.soldMinor);
  const share = face > 0n ? Number((sold * 1000n) / face) / 10 : 0;
  return (
    <div className={cn('grid gap-1.5', className)}>
      <div
        className="h-2 overflow-hidden rounded-full bg-chip"
        role="progressbar"
        aria-label="Funded"
        aria-valuenow={Math.round(share)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className="h-full rounded-full bg-success" style={{ width: `${share}%` }} />
      </div>
      <p className="text-[13px] text-muted-foreground">
        {usd(sold)} of {usd(face)} funded
        {invoice.funding.open && sold < face ? ` · ${usd(invoice.funding.unsoldMinor)} still for sale` : ''}
      </p>
    </div>
  );
}

type Step = { label: string; at: string | null; state: 'done' | 'current' | 'todo' | 'bad'; note?: string };

/**
 * Eligible → listed → funded → repaid. Past maturity the last step shows the grace period,
 * the default, or the buy-back instead.
 */
export function FinancingSteps({
  invoice,
  audience = 'merchant',
}: {
  invoice: FinancedInvoice;
  audience?: 'merchant' | 'investor';
}) {
  const order: FinancingStatus[] = ['eligible', 'requested', 'funded', 'repaid'];
  const status = invoice.status;
  const reached =
    status === 'overdue' || status === 'defaulted' || status === 'bought_back'
      ? 2
      : status
        ? order.indexOf(status)
        : -1;
  const holders = invoice.holders.map(h => h.organization).join(', ');
  const last: Step =
    status === 'overdue'
      ? {
          label: 'Overdue',
          at: invoice.overdueAt,
          state: 'bad',
          note: `In the grace period until ${date(invoice.terms.graceEndsAt)}. A ${percent(invoice.terms.lateFeeBps)} late fee now applies.`,
        }
      : status === 'defaulted'
        ? {
            label: 'Defaulted',
            at: invoice.defaultedAt,
            state: 'bad',
            note: `Token frozen. Reserve paid to holders; ${usd(invoice.buyBackMinor)} buy-back owed.`,
          }
        : status === 'bought_back'
          ? {
              label: 'Bought back',
              at: invoice.boughtBackAt,
              state: 'done',
              note: 'The business paid the holders in full.',
            }
          : {
              label: 'Repaid',
              at: invoice.repaidAt,
              state: reached >= 3 ? 'done' : reached === 2 ? 'current' : 'todo',
              note: reached === 2 ? `Due ${date(invoice.terms.maturityAt)}` : undefined,
            };
  const steps: Step[] = [
    {
      label: 'Eligible',
      at: null,
      state: reached >= 0 ? 'done' : 'bad',
      note:
        reached >= 0 ? 'Sent, acknowledged, unpaid and not yet due' : (invoice.ineligibleReason ?? undefined),
    },
    {
      label: audience === 'investor' ? 'Listed' : 'Requested',
      at: invoice.requestedAt,
      state: reached >= 1 ? 'done' : reached === 0 ? 'current' : 'todo',
    },
    {
      label: 'Funded',
      at: invoice.fundedAt,
      state: reached >= 2 ? 'done' : reached === 1 ? 'current' : 'todo',
      note:
        reached === 1 && BigInt(invoice.funding.soldMinor) > 0n
          ? `${usd(invoice.funding.soldMinor)} of ${usd(invoice.terms.faceMinor)} so far`
          : holders && audience === 'merchant'
            ? `By ${holders}`
            : undefined,
    },
    last,
  ];
  return (
    <ol className="grid gap-3" aria-label="Financing progress">
      {steps.map(step => (
        <li key={step.label} className="flex items-start gap-3">
          {step.state === 'done' ? (
            <IconCircleCheckFilled aria-hidden className="mt-0.5 size-5 shrink-0 text-success" />
          ) : step.state === 'bad' ? (
            <IconAlertTriangleFilled aria-hidden className="mt-0.5 size-5 shrink-0 text-destructive" />
          ) : step.state === 'current' ? (
            <IconInfoCircle aria-hidden className="mt-0.5 size-5 shrink-0 text-warning" />
          ) : (
            <IconCircleDashed aria-hidden className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className={cn('text-[15px] font-medium', step.state === 'todo' && 'text-muted-foreground')}>
                {step.label}
                <span className="sr-only">
                  {step.state === 'done'
                    ? ', done'
                    : step.state === 'bad'
                      ? ', needs attention'
                      : step.state === 'current'
                        ? ', next'
                        : ', not yet'}
                </span>
              </p>
              {step.at && <p className="text-[13px] text-muted-foreground">{date(step.at)}</p>}
            </div>
            {step.note && <p className="text-sm text-muted-foreground">{step.note}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Who holds the claim: face value, what they paid, what they have received and what is still owed. */
export function HoldersTable({ holders, keptMinor }: { holders: FinancingHolder[]; keptMinor?: string }) {
  const kept = keptMinor ? BigInt(keptMinor) : 0n;
  return (
    <Table className="min-w-0">
      <thead>
        <tr>
          <Th>Holder</Th>
          <Th align="right">Face value</Th>
          <Th align="right">Paid</Th>
          <Th align="right">Received</Th>
          <Th align="right">Still owed</Th>
        </tr>
      </thead>
      <tbody>
        {holders.map(h => (
          <Tr key={h.id} className="hover:bg-transparent">
            <Td>
              <p className="font-medium">
                {h.organization}
                {h.you && <span className="font-normal text-muted-foreground"> (you)</span>}
              </p>
              {!h.approved && <p className="text-[13px] text-warning">No longer approved</p>}
            </Td>
            <Td align="right">{usd(h.faceMinor)}</Td>
            <Td align="right" className="text-muted-foreground">
              {usd(h.paidMinor)}
            </Td>
            <Td align="right">{usd(h.receivedMinor)}</Td>
            <Td align="right" className="font-medium">
              {usd(h.owedMinor)}
            </Td>
          </Tr>
        ))}
        {kept > 0n && (
          <Tr className="hover:bg-transparent">
            <Td className="text-muted-foreground">Kept by you (not sold)</Td>
            <Td align="right" className="text-muted-foreground">
              {usd(kept)}
            </Td>
            <Td colSpan={3} className="text-[13px] text-muted-foreground">
              Paid to you directly when the customer pays
            </Td>
          </Tr>
        )}
      </tbody>
    </Table>
  );
}

const eventTone: Record<FinancingEvent['kind'], TimelineTone> = {
  requested: 'default',
  cancelled: 'default',
  withdrawn: 'warning',
  closed: 'default',
  funded: 'success',
  advance: 'success',
  payment: 'success',
  repaid: 'success',
  reserve: 'success',
  transfer: 'default',
  overdue: 'danger',
  defaulted: 'danger',
  bought_back: 'warning',
  refused: 'warning',
};

export function FinancingTimeline({ events }: { events: FinancingEvent[] }) {
  if (events.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Nothing has happened yet. Requests and payments appear here.
      </p>
    );
  return (
    <Timeline
      items={events.map(e => ({
        id: e.id,
        title: e.title,
        detail: e.detail,
        at: dateTime(e.at),
        tone: eventTone[e.kind],
        extra: e.txHash ? <PublicRecord hash={e.txHash} /> : undefined,
      }))}
    />
  );
}
