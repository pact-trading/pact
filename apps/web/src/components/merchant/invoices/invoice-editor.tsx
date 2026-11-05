'use client';

import { IconEye, IconPlus, IconTrash } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';
import { createInvoice } from '@/server/actions/merchant';
import { toMinor, usd } from '@/lib/format';
import { Button } from '../../ui/button';
import { Card, CardBody, CardHeader } from '../../ui/card';
import { Dialog } from '../../ui/dialog';
import { AmountInput, Field, Input, Textarea } from '../../ui/field';
import { Notice } from '../../ui/notice';
import { useToast } from '../../ui/toast';
import { InvoicePreview } from './invoice-preview';

type Line = { key: number; description: string; quantity: string; price: string };
const safeMinor = (value: string) => {
  try {
    return toMinor(value || '0');
  } catch {
    return 0n;
  }
};

const EMAIL = /^\S+@\S+\.\S+$/;

export function InvoiceEditor({
  defaultDue,
  merchantName,
  logoUrl = null,
  brandColor = '#c6ff34',
  feeMode = 'merchant',
}: {
  defaultDue: string;
  merchantName: string;
  logoUrl?: string | null;
  brandColor?: string;
  feeMode?: 'merchant' | 'customer';
}) {
  const router = useRouter();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [due, setDue] = useState(defaultDue);
  const [memo, setMemo] = useState('');
  const [allowPartial, setAllowPartial] = useState(true);
  const [lines, setLines] = useState<Line[]>([{ key: 1, description: '', quantity: '1', price: '' }]);
  const [error, setError] = useState('');
  const [tried, setTried] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [pending, start] = useTransition();
  const total = useMemo(
    () =>
      lines.reduce(
        (sum, l) => sum + safeMinor(l.price) * BigInt(/^\d+$/.test(l.quantity) ? l.quantity : '0'),
        0n,
      ),
    [lines],
  );
  const update = (key: number, patch: Partial<Line>) =>
    setLines(list => list.map(l => (l.key === key ? { ...l, ...patch } : l)));
  const filled = lines.filter(l => l.description.trim());
  const emailError = !email.trim()
    ? 'Enter the payer’s email address.'
    : EMAIL.test(email.trim())
      ? ''
      : 'Use an address like ap@client.example.';
  const lineError = !filled.length
    ? 'Add at least one line with a description.'
    : filled.some(l => safeMinor(l.price) <= 0n || !/^[1-9]\d*$/.test(l.quantity))
      ? 'Each line needs a whole quantity and a price above $0.'
      : '';
  const dueError = due ? '' : 'Choose a due date.';
  const invalid = Boolean(emailError || lineError || dueError);

  const save = (status: 'draft' | 'sent') =>
    start(async () => {
      setTried(true);
      setError('');
      if (invalid) return;
      const result = await createInvoice({
        customerEmail: email,
        customerName: name,
        dueAt: due ? new Date(`${due}T23:59:00Z`).toISOString() : undefined,
        memo,
        allowPartial,
        status,
        lines: lines
          .filter(l => l.description.trim())
          .map(l => ({
            description: l.description,
            quantity: Number(l.quantity),
            unitAmount: l.price || '0',
          })),
      });
      if (!result.ok) return setError(result.error.message);
      toast(
        status === 'sent'
          ? `${result.data.number} sent to ${result.data.customerEmail}`
          : `${result.data.number} saved as a draft`,
      );
      router.push(`/dashboard/invoices/${result.data.id}`);
    });

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader title="Invoice" description={`From ${merchantName}`} />
        <CardBody className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Payer email"
              hint="They sign in with this email to pay. No wallet needed."
              error={tried && emailError ? emailError : undefined}
            >
              {id => (
                <Input
                  id={id}
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="ap@client.example"
                  aria-invalid={tried && Boolean(emailError)}
                  required
                />
              )}
            </Field>
            <Field label="Company or name">
              {id => (
                <Input
                  id={id}
                  value={name}
                  onChange={e => setName(e.target.value)}
                  placeholder="Acme Robotics"
                />
              )}
            </Field>
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">Line items</p>
            <div className="grid gap-2">
              {lines.map((line, index) => (
                <div
                  key={line.key}
                  className="grid grid-cols-[1fr_auto] gap-2 sm:grid-cols-[minmax(0,1fr)_80px_140px_auto]"
                >
                  <Input
                    aria-label={`Item ${index + 1} description`}
                    value={line.description}
                    onChange={e => update(line.key, { description: e.target.value })}
                    placeholder="Service or deliverable"
                    className="col-span-2 sm:col-span-1"
                  />
                  <Input
                    aria-label={`Item ${index + 1} quantity`}
                    inputMode="numeric"
                    value={line.quantity}
                    onChange={e =>
                      /^\d{0,4}$/.test(e.target.value) && update(line.key, { quantity: e.target.value })
                    }
                  />
                  <AmountInput
                    aria-label={`Item ${index + 1} unit price`}
                    value={line.price}
                    onChange={e =>
                      /^\d*(\.\d{0,6})?$/.test(e.target.value) && update(line.key, { price: e.target.value })
                    }
                    placeholder="0.00"
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove item ${index + 1}`}
                    disabled={lines.length === 1}
                    onClick={() => setLines(list => list.filter(l => l.key !== line.key))}
                  >
                    <IconTrash className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              onClick={() =>
                setLines(list => [
                  ...list,
                  { key: Math.max(...list.map(l => l.key)) + 1, description: '', quantity: '1', price: '' },
                ])
              }
            >
              <IconPlus className="size-4" />
              Add line
            </Button>
            {tried && lineError && (
              <p className="mt-1 text-[13px] text-destructive" role="alert">
                {lineError}
              </p>
            )}
          </div>
          <Field label="Note to the payer">
            {id => (
              <Textarea
                id={id}
                value={memo}
                onChange={e => setMemo(e.target.value)}
                placeholder="Thanks for working with us."
              />
            )}
          </Field>
        </CardBody>
      </Card>
      <div className="grid content-start gap-6">
        <Card>
          <CardHeader title="Terms" />
          <CardBody className="grid gap-4">
            <Field
              label="Due date"
              hint="Reminders go out 7 days and 1 day before, and when it becomes overdue."
              error={tried && dueError ? dueError : undefined}
            >
              {id => (
                <Input
                  id={id}
                  type="date"
                  value={due}
                  aria-invalid={tried && Boolean(dueError)}
                  onChange={e => setDue(e.target.value)}
                />
              )}
            </Field>
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 size-4 accent-[var(--pact-ink)]"
                checked={allowPartial}
                onChange={e => setAllowPartial(e.target.checked)}
              />
              <span>
                <span className="font-medium">Allow partial payments</span>
                <span className="block text-muted-foreground">
                  The payer can pay in instalments until the balance is zero.
                </span>
              </span>
            </label>
            <div className="flex items-baseline justify-between border-t border-border-subtle pt-4">
              <span className="text-muted-foreground">{feeMode === 'customer' ? 'Subtotal' : 'Total'}</span>
              <span className="text-2xl font-semibold">{usd(total)}</span>
            </div>
            {feeMode === 'customer' && (
              <p className="text-[13px] text-muted-foreground">
                Your fee setting is “customer pays”, so a payment processing fee line is added when you save.
                The invoice shows the exact amount.
              </p>
            )}
            {error && <Notice tone="danger">{error}</Notice>}
            {tried && invalid && !error && (
              <Notice tone="danger">Fix the highlighted details before saving.</Notice>
            )}
            <div className="grid gap-2">
              <Button variant="dark" onClick={() => save('sent')} disabled={pending}>
                {pending ? 'Saving…' : 'Send invoice'}
              </Button>
              <Button onClick={() => save('draft')} disabled={pending}>
                Save draft
              </Button>
              <Button variant="ghost" onClick={() => setPreviewing(true)}>
                <IconEye className="size-4" />
                Preview as customer
              </Button>
            </div>
            <p className="text-[13px] text-muted-foreground">
              The payer can acknowledge it with one signature (“I owe this invoice”) and pay through the same
              zero-fee checkout as your products.
            </p>
          </CardBody>
        </Card>
      </div>
      <Dialog
        open={previewing}
        onClose={() => setPreviewing(false)}
        title="Customer view"
        description="A preview of what the payer opens from the link, with your brand. Nothing is saved yet."
        footer={
          <>
            <Button variant="ghost" onClick={() => setPreviewing(false)}>
              Keep editing
            </Button>
            <Button
              variant="dark"
              disabled={pending}
              onClick={() => {
                setPreviewing(false);
                save('sent');
              }}
            >
              Send invoice
            </Button>
          </>
        }
      >
        <InvoicePreview
          merchantName={merchantName}
          logoUrl={logoUrl}
          brandColor={brandColor}
          number="New invoice"
          customerName={name.trim() || null}
          customerEmail={email.trim() || 'No email yet'}
          lines={filled.map(l => ({
            key: String(l.key),
            description: l.description.trim(),
            quantity: /^\d+$/.test(l.quantity) ? Number(l.quantity) : 0,
            amountMinor: safeMinor(l.price) * BigInt(/^\d+$/.test(l.quantity) ? l.quantity : '0'),
          }))}
          totalMinor={total}
          dueAt={due ? new Date(`${due}T23:59:00Z`).toISOString() : null}
          memo={memo.trim()}
          allowPartial={allowPartial}
        />
        {feeMode === 'customer' && (
          <p className="mt-3 text-[13px] text-muted-foreground">
            A payment processing fee line is added to this total when you save.
          </p>
        )}
      </Dialog>
    </div>
  );
}
