'use client';

import { IconPlayerPlay, IconRobot } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import type { AgentCall, AgentSession } from '@pactagent/core/platform-types';
import { runAgent } from '@/server/actions/customer';
import { reasonDetail } from '@/lib/reasons';
import { shortHash, usd } from '@/lib/format';
import { txUrl } from '@/lib/explorer';
import { cn } from '@/lib/cn';
import { Button } from '../../ui/button';
import { Notice } from '../../ui/notice';

type Line = { text: string; tone?: 'muted' | 'ok' | 'bad' | 'pay'; href?: string };

/** One x402 round trip per call: request → 402 → signed with the session key → settled → data. */
function transcript(call: AgentCall, index: number): Line[] {
  const head: Line[] = [
    { text: `→ [${index + 1}] GET ${call.url}`, tone: 'muted' },
    {
      text: `← 402 Payment Required · ${usd(call.priceMinor)} USDT, scheme ${call.scheme}, network eip155:1874`,
      tone: 'pay',
    },
  ];
  if (call.status === 'refused')
    return [
      ...head,
      {
        text: `✗ Refused by the agent account: ${call.reason}. ${reasonDetail(call.reason ?? '')} No payment sent.`,
        tone: 'bad',
      },
    ];
  return [
    ...head,
    { text: '✓ Signed with the session key, inside per-call and daily caps', tone: 'ok' },
    {
      text: `✓ Settled ${usd(call.amountMinor)} via the Pact facilitator · ${shortHash(call.txHash ?? '')}`,
      tone: 'ok',
      href: call.txHash ? txUrl(call.txHash) : undefined,
    },
    { text: `← 200 OK ${call.responseBody ?? ''}`, tone: 'muted' },
  ];
}

export function AgentConsole({ session, disabled }: { session: AgentSession; disabled?: boolean }) {
  const router = useRouter();
  const [calls, setCalls] = useState<AgentCall[]>([]);
  const [shown, setShown] = useState(0);
  const [error, setError] = useState('');
  const [after, setAfter] = useState<AgentSession | null>(null);
  const [pending, start] = useTransition();
  const box = useRef<HTMLDivElement>(null);
  const lines = calls.flatMap(transcript);

  useEffect(() => {
    if (shown >= lines.length) return;
    const timer = window.setTimeout(() => setShown(n => n + 1), 110);
    return () => window.clearTimeout(timer);
  }, [shown, lines.length]);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [shown]);

  const done = calls.length > 0 && shown >= lines.length;
  const settled = calls.filter(c => c.status === 'settled');
  const refused = calls.filter(c => c.status === 'refused');

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="dark"
          disabled={pending || disabled || (calls.length > 0 && !done)}
          onClick={() =>
            start(async () => {
              setError('');
              const result = await runAgent(session.id, 11);
              if (!result.ok) return setError(result.error.message);
              setCalls(result.data.calls);
              setAfter(result.data.session);
              setShown(0);
              router.refresh();
            })
          }
        >
          <IconPlayerPlay className="size-4.5" />
          {pending ? 'Starting…' : calls.length ? 'Run 11 more calls' : 'Run the agent: 11 paid calls'}
        </Button>
        <p className="text-sm text-muted-foreground">
          {session.name} calls {session.allowedMerchants[0]?.name ?? 'the business'}’s <code>risk-score</code>{' '}
          API at {usd('10000')} a call with an unmodified <code>@x402/fetch</code> client.
        </p>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      <div
        ref={box}
        className="h-80 overflow-y-auto rounded-2xl border border-ink-line bg-ink p-4 font-mono text-[13px] leading-relaxed text-ink-foreground"
      >
        {calls.length === 0 ? (
          <p className="flex items-center gap-2 text-white/60">
            <IconRobot className="size-4" />
            Waiting for the agent. Each call shows the full HTTP 402 round trip.
          </p>
        ) : (
          lines.slice(0, shown).map((line, i) =>
            line.href ? (
              <a
                key={i}
                href={line.href}
                target="_blank"
                rel="noreferrer"
                className="block text-[#d9ff7a] hover:underline"
              >
                {line.text}
              </a>
            ) : (
              <p
                key={i}
                className={cn(
                  line.tone === 'ok' && 'text-[#d9ff7a]',
                  line.tone === 'bad' && 'text-[#ffb3a8]',
                  line.tone === 'pay' && 'text-[#ffd98a]',
                  line.tone === 'muted' && 'text-white/70',
                )}
              >
                {line.text}
              </p>
            ),
          )
        )}
      </div>
      {done && after && (
        <Notice
          tone={refused.length ? 'shield' : 'success'}
          title={`${settled.length} paid, ${refused.length} refused`}
        >
          The agent spent {usd(after.spentTodayMinor)} of its {usd(after.dailyCapMinor)} daily cap.{' '}
          {refused.length
            ? `Call ${calls.indexOf(refused[0]) + 1} was refused before any payment: ${reasonDetail(refused[0].reason ?? '')}`
            : 'Every call settled in USDT.'}
        </Notice>
      )}
    </div>
  );
}
