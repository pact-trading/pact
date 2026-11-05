'use client';

import Link from 'next/link';
import { IconClockPlay, IconFlask, IconLayoutList, IconRefresh, IconUsers, IconX } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, useTransition } from 'react';
import { advanceClock, resetDemo } from '@/server/actions/demo';
import { setScenario } from '@/server/actions/lab';
import { SCENARIOS, type ScenarioId } from '@/server/data/parts/lab';
import { dateTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useToast } from '../ui/toast';

const roleLabel = {
  merchant: 'Merchant',
  accountant: 'Accountant',
  customer: 'Customer',
  investor: 'Investor',
  compliance: 'Compliance',
} as const;

const groups = [
  { group: 'screens', label: 'Shape every screen' },
  { group: 'data', label: 'Change the demo data' },
] as const;

/**
 * Mock mode only: who you are viewing as, the review scenario, the screens index,
 * the shortened demo clock, and a data reset.
 */
export function DemoBar({
  role,
  name,
  now,
  offsetDays,
  scenario = 'happy',
}: {
  role: keyof typeof roleLabel | null;
  name: string | null;
  now: string;
  offsetDays: number;
  scenario?: ScenarioId;
}) {
  const router = useRouter();
  const toast = useToast();
  const selectId = useId();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<ScenarioId>(scenario);
  useEffect(() => setSelected(scenario), [scenario]);
  const run = (work: () => Promise<{ ok: boolean }>, message: string) =>
    start(async () => {
      const result = await work();
      if (result.ok) toast(message);
      router.refresh();
    });
  const choose = (id: ScenarioId) => {
    setSelected(id);
    start(async () => {
      const result = await setScenario(id);
      const info = SCENARIOS.find(s => s.id === id)!;
      if (result.ok) toast(result.data.changed ?? `Scenario: ${info.label}`);
      else {
        toast(result.error.message, 'danger');
        setSelected(scenario);
      }
      router.refresh();
    });
  };
  const active = SCENARIOS.find(s => s.id === scenario) ?? SCENARIOS[0];
  return (
    <div className="sticky top-0 z-40 border-b border-ink-line bg-ink text-[13px] text-ink-foreground">
      <div className="mx-auto flex h-10 max-w-[1600px] items-center gap-2 px-3 sm:gap-3 sm:px-4">
        <span className="inline-flex shrink-0 items-center gap-1.5 font-medium text-white">
          <IconFlask className="size-4 text-primary" />
          Demo<span className="hidden lg:inline"> · mock data</span>
        </span>
        <Link
          href="/demo"
          className="inline-flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1 hover:bg-white/10 hover:text-white"
        >
          <IconUsers className="size-4 shrink-0" />
          <span className="truncate">
            {role ? (
              <>
                {roleLabel[role]}
                <span className="hidden sm:inline"> · {name}</span>
              </>
            ) : (
              <>
                Choose<span className="hidden sm:inline"> a viewpoint</span>
              </>
            )}
          </span>
        </Link>
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <label htmlFor={selectId} className="sr-only">
            Review scenario
          </label>
          <select
            id={selectId}
            value={selected}
            disabled={pending}
            onChange={event => choose(event.target.value as ScenarioId)}
            title={active.description}
            className={cn(
              'h-7 w-[6.5rem] cursor-pointer truncate rounded-full border border-ink-line bg-ink pr-1 pl-2.5 text-[13px] text-white hover:bg-white/10 focus-visible:border-white focus-visible:outline-none disabled:opacity-60 sm:w-auto',
              scenario !== 'happy' && 'border-primary/60 text-primary',
            )}
          >
            {groups.map(({ group, label }) => (
              <optgroup key={group} label={label}>
                {SCENARIOS.filter(s => s.group === group).map(s => (
                  <option key={s.id} value={s.id} title={s.description}>
                    {s.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <Link
            href="/demo/screens"
            aria-label="Screens"
            className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 hover:bg-white/10 hover:text-white"
          >
            <IconLayoutList className="size-4" />
            <span className="hidden sm:inline">Screens</span>
          </Link>
          <button
            type="button"
            onClick={() => setOpen(v => !v)}
            aria-expanded={open}
            aria-label="Demo clock"
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2 py-1 hover:bg-white/10 hover:text-white',
              offsetDays > 0 && 'text-primary',
            )}
          >
            <IconClockPlay className="size-4" />
            <span className="hidden lg:inline">{dateTime(now)}</span>
            {offsetDays > 0 && <span>+{offsetDays}d</span>}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(resetDemo, 'Demo data reset')}
            aria-label="Reset demo data"
            className="inline-flex items-center gap-1.5 rounded-full px-2 py-1 hover:bg-white/10 hover:text-white disabled:opacity-50"
          >
            <IconRefresh className={cn('size-4', pending && 'animate-spin')} />
            <span className="hidden sm:inline">Reset</span>
          </button>
        </div>
      </div>
      {scenario !== 'happy' && (
        <div className="border-t border-ink-line">
          <div role="status" className="mx-auto flex max-w-[1600px] items-center gap-2 px-3 py-1.5 sm:px-4">
            <p className="min-w-0 flex-1">
              <span className="font-medium text-primary">{active.label}.</span> {active.description}
              {active.group === 'data' && (
                <span className="hidden sm:inline"> Reset restores the seeded data.</span>
              )}
            </p>
            <button
              type="button"
              disabled={pending}
              onClick={() => choose('happy')}
              className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 font-medium text-white hover:bg-white/10 disabled:opacity-50"
            >
              <IconX className="size-3.5" />
              <span>Happy path</span>
            </button>
          </div>
        </div>
      )}
      {open && (
        <div className="border-t border-ink-line">
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-2 px-3 py-2 sm:px-4">
            <span className="mr-1">
              <span className="text-white">{dateTime(now)}.</span> Demo clock, shortened for the video. Move
              time forward to reach renewals and due dates:
            </span>
            {[1, 7, 30].map(days => (
              <button
                key={days}
                type="button"
                disabled={pending}
                onClick={() =>
                  run(() => advanceClock(days), `Clock moved forward ${days} day${days > 1 ? 's' : ''}`)
                }
                className="rounded-full border border-ink-line px-3 py-1 font-medium text-white hover:bg-white/10 disabled:opacity-50"
              >
                +{days} day{days > 1 ? 's' : ''}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
