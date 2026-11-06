'use client';

import { IconCoins, IconRobot } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import type { Address } from 'viem';
import { usePactAuth } from '@/components/auth/auth-context';
import { useSignedAction } from '@/components/auth/use-signed-action';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { AmountInput, Field, Input } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { toMinor } from '@/lib/format';
import { agentMerchants, fundAgent, prepareCreateAgent, submitCreateAgent } from '@/server/actions/customer';

/**
 * Live mode: create an agent account you own. You sign its limits and a bounded USDT approval for
 * Permit2 in one confirmation; the relayer deploys and configures it, so you pay no gas.
 */
export function CreateAgent() {
  const auth = usePactAuth();
  const router = useRouter();
  const toast = useToast();
  const signed = useSignedAction();
  const [merchants, setMerchants] = useState<Array<{ id: string; name: string; address: string }> | null>(
    null,
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState('Research agent');
  const [perCall, setPerCall] = useState('0.01');
  const [daily, setDaily] = useState('0.10');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  useEffect(() => {
    void agentMerchants().then(r => {
      const list = r.ok ? r.data : [];
      setMerchants(list);
      setSelected(list.map(m => m.id));
    });
  }, []);
  if (!auth.live) return null;
  const create = () =>
    start(async () => {
      setError('');
      let perCallMinor: bigint, dailyMinor: bigint;
      try {
        perCallMinor = toMinor(perCall);
        dailyMinor = toMinor(daily);
      } catch {
        return setError('Use amounts like 0.01.');
      }
      if (!selected.length) return setError('Choose at least one business the agent may pay.');
      const result = await signed(
        () =>
          prepareCreateAgent({
            name: name.trim() || 'My agent',
            perCallCapMinor: perCallMinor.toString(),
            dailyCapMinor: dailyMinor.toString(),
            merchantIds: selected,
          }),
        (token, signatures) => submitCreateAgent(token, signatures),
      );
      if (!result.ok) {
        if (result.error.code !== 'cancelled') setError(result.error.message);
        return;
      }
      toast(`${result.data.name} created`);
      router.push(`/portal/agents/${result.data.id}`);
    });
  return (
    <Card>
      <CardHeader
        title="Create an agent"
        description="Its account is yours. Limits are enforced by the account contract; you can revoke it anytime."
        action={<IconRobot className="size-5 text-muted-foreground" />}
      />
      <CardBody className="grid gap-4">
        {merchants !== null && merchants.length === 0 ? (
          <Notice tone="info">
            Buy from or subscribe to a business first; an agent can only pay businesses you choose.
          </Notice>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Name">
                {id => <Input id={id} value={name} onChange={e => setName(e.target.value)} />}
              </Field>
              <Field label="Most per call">
                {id => (
                  <AmountInput
                    id={id}
                    value={perCall}
                    onChange={e => /^\d*(\.\d{0,6})?$/.test(e.target.value) && setPerCall(e.target.value)}
                  />
                )}
              </Field>
              <Field label="Most per day" hint="Up to $100">
                {id => (
                  <AmountInput
                    id={id}
                    value={daily}
                    onChange={e => /^\d*(\.\d{0,6})?$/.test(e.target.value) && setDaily(e.target.value)}
                  />
                )}
              </Field>
            </div>
            {merchants && merchants.length > 0 && (
              <fieldset className="grid gap-2">
                <legend className="mb-1 text-sm font-medium">May pay</legend>
                {merchants.map(m => (
                  <label key={m.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.includes(m.id)}
                      onChange={e =>
                        setSelected(s => (e.target.checked ? [...s, m.id] : s.filter(x => x !== m.id)))
                      }
                    />
                    {m.name}{' '}
                    <span className="font-mono text-xs text-muted-foreground">
                      {m.address.slice(0, 6)}…{m.address.slice(-4)}
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            {error && <Notice tone="danger">{error}</Notice>}
            <Button
              variant="dark"
              className="justify-self-start"
              disabled={pending || !merchants}
              onClick={create}
            >
              {pending ? 'Creating…' : 'Create agent'}
            </Button>
          </>
        )}
      </CardBody>
    </Card>
  );
}

/**
 * Puts USDT in the agent's own account. On a local fork: 1 test USDT. On the testnet: send test USDT
 * to the account; it pays in USDT and never needs WBT.
 */
export function FundAgentButton({ id, account }: { id: string; account: Address }) {
  const auth = usePactAuth();
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState('');
  if (!auth.live) return null;
  if (!auth.live.config.localFork)
    return (
      <p className="mb-4 text-sm text-muted-foreground">
        To fund it, send test USDT to <span className="font-mono break-all">{account}</span>. It pays in USDT
        and never needs WBT.
      </p>
    );
  return (
    <div className="grid gap-2">
      <Button
        size="sm"
        className="justify-self-start"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError('');
            const result = await fundAgent(id);
            if (!result.ok) return setError(result.error.message);
            toast('1 test USDT added to the agent account');
            router.refresh();
          })
        }
      >
        <IconCoins className="size-4" /> {pending ? 'Adding…' : 'Add 1 test USDT'}
      </Button>
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}
