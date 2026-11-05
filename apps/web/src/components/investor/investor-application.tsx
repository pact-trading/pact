'use client';

import { IconFlask, IconSend } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { applyAsInvestor } from '@/server/actions/financing';
import { usePactAuth } from '../auth/auth-context';
import { Button } from '../ui/button';
import { Card, CardBody, CardHeader } from '../ui/card';
import { Field, Input } from '../ui/field';
import { Notice } from '../ui/notice';
import { useToast } from '../ui/toast';

/**
 * Live mode: a new investor wallet tells compliance who it is. The registry records only the address,
 * region and expiry on chain; the name, organization and email stay with Pact.
 */
export function InvestorApplication({ applied }: { applied: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [form, setForm] = useState({ name: '', organization: '', email: '', region: '' });
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(value => ({ ...value, [key]: e.target.value }));
  if (applied) return null;
  return (
    <Card className="mb-6">
      <CardHeader
        title="Apply to invest"
        description="Pact compliance reviews your application and approves your wallet in the investor registry. Until then you can browse listings, and the contract refuses purchases."
      />
      <CardBody>
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={event => {
            event.preventDefault();
            start(async () => {
              setError('');
              const result = await applyAsInvestor({ ...form, region: form.region.trim().toUpperCase() });
              if (result.ok) {
                toast('Application sent to compliance');
                router.refresh();
              } else setError(result.error.message);
            });
          }}
        >
          <Field label="Your name">
            {id => <Input id={id} value={form.name} onChange={set('name')} required />}
          </Field>
          <Field label="Organization">
            {id => <Input id={id} value={form.organization} onChange={set('organization')} required />}
          </Field>
          <Field label="Email">
            {id => <Input id={id} type="email" value={form.email} onChange={set('email')} required />}
          </Field>
          <Field label="Country" hint="Two-letter code, such as GB">
            {id => <Input id={id} value={form.region} onChange={set('region')} maxLength={2} required />}
          </Field>
          <div className="sm:col-span-2">
            <Button type="submit" variant="dark" disabled={pending}>
              <IconSend className="size-4.5" /> {pending ? 'Sending…' : 'Send application'}
            </Button>
          </div>
          {error && (
            <Notice tone="danger" className="sm:col-span-2">
              {error}
            </Notice>
          )}
        </form>
      </CardBody>
    </Card>
  );
}

/** Local fork only: test USDT to invest with and WBT for gas, standing in for the faucet and a DEX swap. */
export function InvestorTestFunds({ address }: { address: string }) {
  const auth = usePactAuth();
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState('');
  if (!auth.live?.config.localFork) return null;
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-border p-3 text-sm">
      <IconFlask className="size-4.5 text-muted-foreground" />
      <span className="text-subtle-foreground">
        Local fork: test USDT to invest with. Pact pays the gas, so the wallet needs no WBT.
      </span>
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError('');
            const response = await fetch('/api/dev/faucet', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ as: 'investor', address, usdt: '100' }),
            });
            if (response.ok) {
              toast('Added 100 test USDT');
              router.refresh();
            } else setError('The test faucet did not respond.');
          })
        }
      >
        {pending ? 'Funding…' : 'Get 100 test USDT'}
      </Button>
      {error && <span className="text-danger">{error}</span>}
    </div>
  );
}
