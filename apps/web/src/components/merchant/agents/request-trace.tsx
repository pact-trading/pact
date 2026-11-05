import { IconCircleCheckFilled, IconCircleDashed, IconCircleXFilled } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import type { AgentRequestTrace } from '@/server/data/parts/financing';
import { cn } from '@/lib/cn';
import { dateTime, shortHash, usd } from '@/lib/format';
import { PublicRecord } from '../../states/public-record';
import { CodeBlock } from '../../ui/code-block';

type StepState = 'done' | 'refused' | 'skipped';
type Step = { id: string; title: string; state: StepState; detail: ReactNode; extra?: ReactNode };

function pretty(body: string) {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

/** Request → 402 price quote → payment authorisation → settlement → response, or where it stopped. */
export function RequestTrace({ trace }: { trace: AgentRequestTrace }) {
  const { call, agent, merchant, refusal } = trace;
  const owner = agent.owner.company ?? agent.owner.name;
  const price = call.scheme === 'upto' ? `up to ${usd(call.priceMinor)}` : usd(call.priceMinor);
  const stoppedAt = refusal?.stage ?? null;
  const steps: Step[] = [
    {
      id: 'request',
      title: 'Request',
      state: 'done',
      detail: (
        <>
          {call.agentName} sent <code className="text-[13px]">{`${call.method} ${call.url}`}</code> at{' '}
          {dateTime(call.createdAt)}.
        </>
      ),
    },
    {
      id: 'quote',
      title: '402 price quote',
      state: 'done',
      detail: `${merchant.name} answered 402 Payment Required: ${price} USDT, scheme ${call.scheme}, network ${trace.network}, paid to ${shortHash(merchant.address)}.`,
    },
    {
      id: 'authorise',
      title: 'Payment authorisation',
      state: stoppedAt === 'authorise' ? 'refused' : 'done',
      detail:
        stoppedAt === 'authorise'
          ? `Refused by the agent account: ${refusal!.reason}. ${refusal!.detail} No payment was signed.`
          : `Signed with the agent’s session key, inside the caps ${owner} set.`,
    },
    {
      id: 'settle',
      title: 'Settlement',
      state: stoppedAt === 'settle' ? 'refused' : stoppedAt ? 'skipped' : 'done',
      detail:
        stoppedAt === 'settle'
          ? `Refused by the facilitator: ${refusal!.reason}. ${refusal!.detail} Nothing moved.`
          : stoppedAt
            ? 'Not reached. Nothing was charged.'
            : `Settled ${usd(call.amountMinor)} in USDT through the Pact facilitator${call.scheme === 'upto' ? ', for what the request used' : ''}. The agent paid no gas.`,
      extra: call.txHash ? <PublicRecord hash={call.txHash} /> : undefined,
    },
    {
      id: 'respond',
      title: 'Response',
      state: stoppedAt ? 'skipped' : 'done',
      detail: stoppedAt
        ? `${call.responseStatus} again: no data was returned.`
        : `${call.responseStatus} OK: ${merchant.name} returned the data.`,
      extra:
        !stoppedAt && call.responseBody ? (
          <CodeBlock title="Response body" code={pretty(call.responseBody)} className="mt-1" />
        ) : undefined,
    },
  ];
  return (
    <ol className="grid gap-5" aria-label="Request steps">
      {steps.map((step, index) => (
        <li key={step.id} className="relative flex gap-3.5">
          {index < steps.length - 1 && (
            <span aria-hidden className="absolute top-6 bottom-[-1.25rem] left-[9px] w-px bg-border" />
          )}
          {step.state === 'done' ? (
            <IconCircleCheckFilled aria-hidden className="relative size-5 shrink-0 text-success" />
          ) : step.state === 'refused' ? (
            <IconCircleXFilled aria-hidden className="relative size-5 shrink-0 text-destructive" />
          ) : (
            <IconCircleDashed
              aria-hidden
              className="relative size-5 shrink-0 bg-card text-muted-foreground"
            />
          )}
          <div className="min-w-0 flex-1">
            <p className={cn('text-[15px] font-medium', step.state === 'skipped' && 'text-muted-foreground')}>
              {step.title}
              <span className="sr-only">
                {step.state === 'done' ? ', done' : step.state === 'refused' ? ', refused' : ', not reached'}
              </span>
            </p>
            <p
              className={cn(
                'mt-0.5 text-sm [overflow-wrap:anywhere]',
                step.state === 'refused' ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {step.detail}
            </p>
            {step.extra && <div className="mt-2">{step.extra}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}
