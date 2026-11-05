'use client';

import { IconArrowRight, IconFlask, IconPlayerPlay } from '@tabler/icons-react';
import { useId, useState, useTransition } from 'react';
import type { AgentRequestTrace, AgentScenario } from '@/server/data/parts/financing';
import { simulateAgentRequest } from '@/server/actions/financing';
import { cn } from '@/lib/cn';
import { usd } from '@/lib/format';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { Notice } from '../../ui/notice';

/** Demo control (mock data only): one agent request through the same x402 engine as real traffic. */
export function SimulateRequest({ scenarios }: { scenarios: AgentScenario[] }) {
  const name = useId();
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState(scenarios[0]?.id ?? '');
  const [result, setResult] = useState<AgentRequestTrace | null>(null);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  if (scenarios.length === 0) return null;

  const close = () => {
    if (pending) return;
    setOpen(false);
    setResult(null);
    setError('');
  };
  const send = () =>
    start(async () => {
      setError('');
      setResult(null);
      const outcome = await simulateAgentRequest(choice);
      if (!outcome.ok) return setError(outcome.error.message);
      // The action revalidates the dashboard, so the list behind the dialog is already fresh.
      setResult(outcome.data);
    });

  return (
    <>
      <Button variant="dark" size="sm" onClick={() => setOpen(true)}>
        <IconPlayerPlay className="size-4" />
        Simulate a request
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title="Simulate a request"
        description="Demo: one agent calls your paid API through the same x402 engine as real traffic, and the result is recorded."
        footer={
          <>
            <Button onClick={close} disabled={pending}>
              Close
            </Button>
            <Button variant="dark" onClick={send} disabled={pending || !choice}>
              <IconFlask className="size-4" />
              {pending ? 'Sending…' : result ? 'Send another' : 'Send request'}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <fieldset className="grid gap-2" disabled={pending}>
            <legend className="mb-1.5 text-sm font-medium">Request</legend>
            {scenarios.map(scenario => (
              <label
                key={scenario.id}
                className={cn(
                  'flex cursor-pointer gap-3 rounded-2xl border p-3.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40',
                  choice === scenario.id
                    ? 'border-foreground bg-raised'
                    : 'border-border hover:border-foreground/30',
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={scenario.id}
                  checked={choice === scenario.id}
                  onChange={() => {
                    setChoice(scenario.id);
                    setResult(null);
                  }}
                  className="mt-1 accent-[var(--pact-ink)]"
                />
                <span className="min-w-0">
                  <span className="block text-[15px] font-medium">{scenario.label}</span>
                  <span className="block text-sm text-muted-foreground">{scenario.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
          {error && <Notice tone="danger">{error}</Notice>}
          {/* Shown once the action's revalidated page has landed, so "View trace" is never lost to it. */}
          {result && !pending && (
            <Notice
              tone={result.call.status === 'settled' ? 'success' : 'shield'}
              title={
                result.call.status === 'settled'
                  ? `Paid and answered: ${usd(result.call.amountMinor)} settled`
                  : `Refused before payment: ${result.call.reason}`
              }
              action={
                <Button asChild size="sm" variant="ghost">
                  {/*
                   * A plain link: a client-side navigation started right after the server action
                   * that revalidated this page can be dropped by the router, and the trace must open.
                   */}
                  <a href={`/dashboard/agents/requests/${result.call.id}`}>
                    View trace
                    <IconArrowRight className="size-4" />
                  </a>
                </Button>
              }
            >
              {result.refusal
                ? `${result.refusal.detail} Nothing was charged.`
                : `${result.call.agentName} got a 200 response from ${result.call.url}.`}
            </Notice>
          )}
        </div>
      </Dialog>
    </>
  );
}
