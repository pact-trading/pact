'use client';

import { IconPlayerPlay, IconShieldCheck, IconShieldX } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, useTransition } from 'react';
import type { DrainAttack, DrainRun } from '@pactagent/core/platform-types';
import { runDrainSimulation } from '@/server/actions/merchant';
import { humanize, shortHash, usd } from '@/lib/format';
import { Button } from '../../ui/button';
import { Notice } from '../../ui/notice';

/** The merchant's USDT balance, or a dash when it could not be read. */
const balance = (minor: string | null) => (minor === null ? '—' : usd(minor));

const attackLabel: Record<DrainAttack, string> = {
  replay: 'Replays',
  dust: 'Dust payments',
  arbitrary_calldata: 'Arbitrary calldata',
  spend_merchant_funds: 'Strangers spending your USDT',
  over_gas_cap: 'Over the gas cap',
  stale_deadline: 'Stale deadlines',
};

/** Runs the drain script against the relayer and replays the attempts one by one. */
export function DrainSimulation({ readOnly }: { readOnly: boolean }) {
  const router = useRouter();
  const [run, setRun] = useState<DrainRun | null>(null);
  const [shown, setShown] = useState(0);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!run || shown >= run.attempts.length) return;
    const timer = window.setTimeout(
      () => setShown(n => Math.min(run.attempts.length, n + (n < 12 ? 1 : 4))),
      shown < 12 ? 140 : 60,
    );
    return () => window.clearTimeout(timer);
  }, [run, shown]);
  useEffect(() => {
    list.current?.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }, [shown]);

  const done = run !== null && shown >= run.attempts.length;
  const refused = run?.attempts.slice(0, shown).filter(a => a.result === 'refused').length ?? 0;
  const byAttack = run
    ? Object.entries(
        run.attempts.reduce<Record<string, typeof run.attempts>>(
          (groups, a) => ({ ...groups, [a.attack]: [...(groups[a.attack] ?? []), a] }),
          {},
        ),
      )
    : [];

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {!readOnly && (
          <Button
            variant="dark"
            disabled={pending || (run !== null && !done)}
            onClick={() =>
              start(async () => {
                setError('');
                const result = await runDrainSimulation();
                if (!result.ok) return setError(result.error.message);
                setRun(result.data);
                setShown(0);
                router.refresh();
              })
            }
          >
            <IconPlayerPlay className="size-4.5" />
            {pending ? 'Starting…' : run ? 'Run again' : 'Run the drain attack'}
          </Button>
        )}
        <p className="text-sm text-muted-foreground">
          Replays, dust, arbitrary calldata, gas-heavy calls, 50 fresh accounts signing refunds of your USDT
          and stale deadlines, sent straight at the relayer.
        </p>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {run && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <div className="overflow-hidden rounded-2xl border border-ink-line bg-ink text-[13px] text-ink-foreground">
            <div className="flex items-center justify-between border-b border-ink-line px-4 py-2 font-mono">
              <span>drain-attack.ts</span>
              <span className={done ? 'text-primary' : ''}>
                {shown}/{run.attempts.length}
              </span>
            </div>
            <ol ref={list} className="max-h-80 overflow-y-auto p-3 font-mono leading-relaxed">
              {run.attempts.slice(0, shown).map(a => (
                <li key={a.id} className="flex gap-2">
                  <span className={a.result === 'refused' ? 'text-[#ffb3a8]' : 'text-[#d9ff7a]'}>
                    {a.result === 'refused' ? '✗ refused' : '✓ sent'}
                  </span>
                  <span className="min-w-0 truncate text-white/80">{a.label}</span>
                  <span className="ml-auto shrink-0 text-white/50">
                    {a.reason} · L{a.layer}
                  </span>
                </li>
              ))}
              {done && (
                <li className="mt-2 text-primary">
                  Relayer sent {run.legitimateSent} transactions for the attacker. Attack attempts sent: 0.
                </li>
              )}
            </ol>
          </div>
          <div className="grid content-start gap-3">
            <Notice
              tone={done ? 'success' : 'shield'}
              title={done ? `All ${run.attempts.length} attempts refused` : `${refused} refused so far`}
              role="status"
            >
              {done
                ? 'No transaction was sent for the attacker, and none of your USDT moved.'
                : 'Each attempt is checked against the limits before anything is sent.'}
            </Notice>
            <div className="rounded-2xl border border-border p-4 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Your USDT before</span>
                <span className="font-medium">{balance(run.merchantBalanceBeforeMinor)}</span>
              </div>
              <div className="mt-1 flex justify-between">
                <span className="text-muted-foreground">Your USDT after</span>
                <span className="font-medium">{done ? balance(run.merchantBalanceAfterMinor) : '…'}</span>
              </div>
              {done && run.merchantBalanceBeforeMinor !== null && run.merchantBalanceAfterMinor !== null && (
                <p className="mt-2 flex items-center gap-1.5 text-success">
                  {run.merchantBalanceBeforeMinor === run.merchantBalanceAfterMinor ? (
                    <IconShieldCheck className="size-4" />
                  ) : (
                    <IconShieldX className="size-4" />
                  )}
                  {run.merchantBalanceBeforeMinor === run.merchantBalanceAfterMinor
                    ? 'Unchanged. Only calls you sign can spend it.'
                    : 'Changed only by real payments that arrived meanwhile.'}
                </p>
              )}
            </div>
            {done && (
              <ul className="grid gap-1.5 rounded-2xl border border-border p-4 text-sm">
                {byAttack.map(([attack, attempts]) => (
                  <li key={attack} className="flex justify-between gap-3">
                    <span>{attackLabel[attack as DrainAttack]}</span>
                    <span className="text-muted-foreground">
                      {attempts?.length} × {humanize(attempts?.[0]?.reason ?? '')}
                    </span>
                  </li>
                ))}
                <li className="mt-1 text-[13px] text-muted-foreground">
                  Example attacker: {shortHash(run.attempts.at(-1)?.actor ?? '')}
                </li>
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
