'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { AgentSession } from '@pactagent/core/platform-types';
import {
  prepareAgentLimits,
  prepareRevokeAgent,
  submitAgentLimits,
  submitRevokeAgent,
} from '@/server/actions/customer';
import { fromMinor, toMinor } from '@/lib/format';
import { useSignedAction } from '../../auth/use-signed-action';
import { Button } from '../../ui/button';
import { AmountInput, Field } from '../../ui/field';
import { Notice } from '../../ui/notice';
import { useToast } from '../../ui/toast';

const safe = (value: string) => {
  try {
    return toMinor(value || '0').toString();
  } catch {
    return '0';
  }
};

export function AgentLimits({ session }: { session: AgentSession }) {
  const router = useRouter();
  const toast = useToast();
  const signed = useSignedAction();
  const [perCall, setPerCall] = useState(fromMinor(session.perCallCapMinor));
  const [daily, setDaily] = useState(fromMinor(session.dailyCapMinor));
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const active = session.status === 'active';
  const run = <T,>(
    prepare: Parameters<typeof signed<T>>[0],
    submit: Parameters<typeof signed<T>>[1],
    message: string,
  ) =>
    start(async () => {
      setError('');
      const result = await signed(prepare, submit);
      if (result.ok) {
        toast(message);
        router.refresh();
      } else if (result.error.code !== 'cancelled') setError(result.error.message);
    });
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Most per call" hint="Enforced by its account">
          {id => (
            <AmountInput
              id={id}
              value={perCall}
              onChange={e => /^\d*(\.\d{0,6})?$/.test(e.target.value) && setPerCall(e.target.value)}
              disabled={!active}
            />
          )}
        </Field>
        <Field label="Most per day" hint="Resets at midnight UTC">
          {id => (
            <AmountInput
              id={id}
              value={daily}
              onChange={e => /^\d*(\.\d{0,6})?$/.test(e.target.value) && setDaily(e.target.value)}
              disabled={!active}
            />
          )}
        </Field>
      </div>
      {error && <Notice tone="danger">{error}</Notice>}
      {active && (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="dark"
            disabled={pending}
            onClick={() =>
              run(
                () =>
                  prepareAgentLimits(session.id, {
                    perCallCapMinor: safe(perCall),
                    dailyCapMinor: safe(daily),
                  }),
                submitAgentLimits,
                'Limits updated',
              )
            }
          >
            Save limits
          </Button>
          <Button
            variant="danger"
            disabled={pending}
            onClick={() =>
              run(() => prepareRevokeAgent(session.id), submitRevokeAgent, `${session.name} revoked`)
            }
          >
            Revoke agent
          </Button>
        </div>
      )}
      <p className="text-[13px] text-muted-foreground">
        Changing limits or revoking takes one passkey confirmation and applies to the very next call.
      </p>
    </div>
  );
}
