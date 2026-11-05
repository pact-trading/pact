'use client';

import { IconPlus } from '@tabler/icons-react';
import { usePactAuth } from '@/components/auth/auth-context';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { createPlan } from '@/server/actions/merchant';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { AmountInput, Field, Input, Select } from '../../ui/field';
import { Notice } from '../../ui/notice';
import { useToast } from '../../ui/toast';

export function NewPlanButton() {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [seconds, setSeconds] = useState(String(30 * 86_400));
  const live = Boolean(usePactAuth().live);
  const [max, setMax] = useState('12');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      setError('');
      const result = await createPlan({
        name,
        description,
        amount: amount || '0',
        periodSeconds: Number(seconds),
        maxPeriods: max ? Number(max) : undefined,
      });
      if (!result.ok) return setError(result.error.message);
      toast(`${result.data.name} created`);
      setOpen(false);
      router.refresh();
    });
  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
        <IconPlus className="size-4" />
        New plan
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New subscription plan"
        description="Customers sign one mandate with these terms. The contract refuses any pull above the cap or before the period ends."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="dark" onClick={save} disabled={pending || !name || !amount}>
              {pending ? 'Creating…' : 'Create plan'}
            </Button>
          </>
        }
      >
        <div className="grid gap-4">
          <Field label="Name">
            {id => (
              <Input id={id} value={name} onChange={e => setName(e.target.value)} placeholder="API Growth" />
            )}
          </Field>
          <Field label="What's included">
            {id => (
              <Input
                id={id}
                value={description}
                onChange={e => setDescription(e.target.value)}
                placeholder="50,000 API calls a month"
              />
            )}
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Price per period">
              {id => (
                <AmountInput
                  id={id}
                  value={amount}
                  onChange={e => /^\d*(\.\d{0,6})?$/.test(e.target.value) && setAmount(e.target.value)}
                  placeholder="49.00"
                />
              )}
            </Field>
            <Field label="Billing period">
              {id => (
                <Select id={id} value={seconds} onChange={e => setSeconds(e.target.value)}>
                  {live && <option value="120">Every 2 minutes (test)</option>}
                  {live && <option value="600">Every 10 minutes (test)</option>}
                  <option value={String(7 * 86_400)}>Weekly</option>
                  <option value={String(30 * 86_400)}>Monthly</option>
                  <option value={String(365 * 86_400)}>Yearly</option>
                </Select>
              )}
            </Field>
            <Field label="Max periods" hint="Blank for no limit">
              {id => (
                <Input
                  id={id}
                  inputMode="numeric"
                  value={max}
                  onChange={e => /^\d{0,3}$/.test(e.target.value) && setMax(e.target.value)}
                />
              )}
            </Field>
          </div>
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      </Dialog>
    </>
  );
}
