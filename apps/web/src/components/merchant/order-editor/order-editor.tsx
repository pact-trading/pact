'use client';

import {
  IconCircleCheckFilled,
  IconExternalLink,
  IconLoader2,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { createManualOrder, quoteOrder } from '@/server/actions/commerce';
import type {
  ManualOrderCreated,
  ManualOrderInput,
  ManualOrderOptions,
  OrderQuote,
} from '@/server/data/parts/commerce';
import { fromMinor, usd } from '@/lib/format';
import { RadioCards } from '../../portal/radio-cards';
import { Button } from '../../ui/button';
import { Card, CardBody, CardHeader } from '../../ui/card';
import { CopyButton } from '../../ui/copy-button';
import { AmountInput, Field, Input, Select, Textarea } from '../../ui/field';
import { Notice } from '../../ui/notice';
import { useToast } from '../../ui/toast';

type Line = { key: number; productId: string; description: string; quantity: string; unitAmount: string };
const AMOUNT = /^\d*(\.\d{0,6})?$/;
const blank = (key: number): Line => ({ key, productId: '', description: '', quantity: '1', unitAmount: '' });
const lineFields = ['product', 'description', 'quantity', 'price'] as const;

/**
 * Create an order by hand: who it is for, what is on it and a note. Every amount on screen comes
 * from the server's quote, so the total shown is the total the customer is charged.
 */
export function OrderEditor({ options }: { options: ManualOrderOptions }) {
  const toast = useToast();
  const [who, setWho] = useState<'existing' | 'new'>(options.customers.length ? 'existing' : 'new');
  const [customerId, setCustomerId] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [lines, setLines] = useState<Line[]>([blank(1)]);
  const [note, setNote] = useState('');
  const [quote, setQuote] = useState<OrderQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState('');
  const [tried, setTried] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<ManualOrderCreated | null>(null);
  const [pending, start] = useTransition();
  const request = useRef(0);

  const input = useMemo<ManualOrderInput>(
    () => ({
      customer: who === 'existing' ? { kind: 'existing', id: customerId } : { kind: 'new', name, email },
      lines: lines.map(l => ({
        productId: l.productId || null,
        description: l.description,
        quantity: l.quantity,
        unitAmount: l.unitAmount,
      })),
      note,
    }),
    [who, customerId, name, email, lines, note],
  );

  // A live quote from the server, a moment after the last keystroke.
  useEffect(() => {
    const id = ++request.current;
    setQuoting(true);
    const timer = window.setTimeout(async () => {
      const result = await quoteOrder(input);
      if (id !== request.current) return;
      setQuoting(false);
      if (result.ok) {
        setQuote(result.data);
        setQuoteError('');
      } else setQuoteError(result.error.message);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [input]);

  const errors = tried ? (quote?.errors ?? {}) : {};
  const update = (key: number, patch: Partial<Line>) =>
    setLines(list => list.map(l => (l.key === key ? { ...l, ...patch } : l)));
  const pick = (key: number, productId: string) => {
    const product = options.products.find(p => p.id === productId);
    // Catalog lines take their name and price from the catalog. The plain number (never a
    // formatted "1,500.00") stays in the field, in case the line is switched back to custom.
    update(
      key,
      product
        ? { productId, description: product.name, unitAmount: fromMinor(product.priceMinor) }
        : { productId: '' },
    );
  };

  const save = () =>
    start(async () => {
      setTried(true);
      setError('');
      const fresh = await quoteOrder(input);
      if (fresh.ok) setQuote(fresh.data);
      if (fresh.ok && Object.keys(fresh.data.errors).length) return;
      const result = await createManualOrder(input);
      if (!result.ok) return setError(result.error.message);
      setCreated(result.data);
      toast(`Order created for ${result.data.customerName}`);
    });

  if (created)
    return (
      <Card className="max-w-2xl">
        <CardBody className="grid gap-5">
          <div className="flex items-center gap-3">
            <IconCircleCheckFilled aria-hidden className="size-9 shrink-0 text-success" />
            <div>
              <h2 className="text-xl font-semibold">Order created</h2>
              <p className="text-sm text-muted-foreground">
                {usd(created.totalMinor)} for {created.customerName} ({created.customerEmail}). It shows as
                open until they pay.
              </p>
            </div>
          </div>
          <div className="grid gap-1.5">
            <p className="text-sm font-medium">Pay link</p>
            <div className="flex min-w-0 items-center gap-1 rounded-[14px] border border-input bg-raised py-1 pr-1 pl-3.5">
              <code className="min-w-0 flex-1 truncate text-sm" title={created.payUrl} data-testid="pay-url">
                {created.payUrl}
              </code>
              <CopyButton value={created.payUrl} label="Copy pay link" showLabel />
            </div>
            <p className="text-[13px] text-muted-foreground">
              Send it to {created.customerEmail}. Only that customer can open the order after signing in.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="dark">
              <Link href={`/dashboard/orders/${created.orderId}`}>View order</Link>
            </Button>
            <Button asChild>
              <a href={created.payUrl} target="_blank" rel="noreferrer">
                <IconExternalLink className="size-4" />
                Open pay page
              </a>
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setCreated(null);
                setTried(false);
                setCustomerId('');
                setName('');
                setEmail('');
                setLines([blank(1)]);
                setNote('');
              }}
            >
              Create another
            </Button>
          </div>
        </CardBody>
      </Card>
    );

  const hasErrors = Boolean(quote && Object.keys(quote.errors).length);
  return (
    <form
      noValidate
      className="grid gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]"
      onSubmit={event => {
        event.preventDefault();
        save();
      }}
    >
      <div className="grid min-w-0 content-start gap-6">
        <Card>
          <CardHeader title="Customer" description="They sign in with this email to see and pay the order." />
          <CardBody className="grid gap-4">
            <RadioCards
              legend="Who is it for?"
              value={who}
              onChange={setWho}
              options={[
                { value: 'existing', title: 'Existing customer' },
                { value: 'new', title: 'New customer', body: 'Added to your customers with the order.' },
              ]}
            />
            {who === 'existing' ? (
              <Field label="Customer" error={errors.customer}>
                {id => (
                  <Select
                    id={id}
                    value={customerId}
                    onChange={e => setCustomerId(e.target.value)}
                    aria-invalid={Boolean(errors.customer) || undefined}
                  >
                    <option value="">Choose a customer</option>
                    {options.customers.map(c => (
                      <option key={c.id} value={c.id}>
                        {[c.name ?? c.email, c.company, c.name ? c.email : null].filter(Boolean).join(' · ')}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Name" error={errors.name}>
                  {id => (
                    <Input
                      id={id}
                      value={name}
                      onChange={e => setName(e.target.value)}
                      placeholder="Jamie Rivera"
                      autoComplete="off"
                      aria-invalid={Boolean(errors.name) || undefined}
                    />
                  )}
                </Field>
                <Field label="Email" error={errors.email}>
                  {id => (
                    <Input
                      id={id}
                      type="email"
                      value={email}
                      onChange={e => setEmail(e.target.value)}
                      placeholder="jamie@studio.example"
                      autoComplete="off"
                      aria-invalid={Boolean(errors.email) || undefined}
                    />
                  )}
                </Field>
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Items" description="Pick from your catalog or add a custom item." />
          <CardBody className="grid gap-4">
            {lines.map((line, index) => {
              const n = index + 1;
              const catalog = Boolean(line.productId);
              const lineErrors = lineFields
                .map(field => errors[`line.${index}.${field}`])
                .filter((message): message is string => Boolean(message));
              const bad = (field: (typeof lineFields)[number]) =>
                Boolean(errors[`line.${index}.${field}`]) || undefined;
              return (
                <div
                  key={line.key}
                  className="grid gap-2 border-b border-border-subtle pb-4 last:border-b-0 last:pb-0"
                >
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)_76px_132px_auto]">
                    <Select
                      aria-label={`Item ${n}`}
                      value={line.productId}
                      onChange={e => pick(line.key, e.target.value)}
                      aria-invalid={bad('product')}
                      className="col-span-2 sm:col-span-1"
                    >
                      <option value="">Custom item</option>
                      {options.products.map(p => (
                        <option key={p.id} value={p.id}>
                          {p.name} · {usd(p.priceMinor)}
                        </option>
                      ))}
                    </Select>
                    <Input
                      aria-label={`Item ${n} description`}
                      value={line.description}
                      readOnly={catalog}
                      onChange={e => update(line.key, { description: e.target.value })}
                      placeholder="Service or deliverable"
                      aria-invalid={bad('description')}
                      className="col-span-3 read-only:bg-raised read-only:text-subtle-foreground sm:col-span-1"
                    />
                    <Input
                      aria-label={`Item ${n} quantity`}
                      inputMode="numeric"
                      value={line.quantity}
                      onChange={e =>
                        /^\d{0,3}$/.test(e.target.value) && update(line.key, { quantity: e.target.value })
                      }
                      aria-invalid={bad('quantity')}
                    />
                    <div className="col-span-2 sm:col-span-1">
                      <AmountInput
                        aria-label={`Item ${n} unit price`}
                        value={line.unitAmount}
                        readOnly={catalog}
                        onChange={e =>
                          AMOUNT.test(e.target.value) && update(line.key, { unitAmount: e.target.value })
                        }
                        placeholder="0.00"
                        aria-invalid={bad('price')}
                        className="read-only:bg-raised read-only:text-subtle-foreground"
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Remove item ${n}`}
                      disabled={lines.length === 1}
                      onClick={() => setLines(list => list.filter(l => l.key !== line.key))}
                      className="col-start-3 row-start-1 sm:col-start-auto sm:row-start-auto"
                    >
                      <IconTrash className="size-4" />
                    </Button>
                  </div>
                  {catalog && (
                    <p className="text-[13px] text-muted-foreground">
                      Name and price come from your catalog.
                    </p>
                  )}
                  {lineErrors.map(message => (
                    <p key={message} className="text-[13px] text-destructive" role="alert">
                      {message}
                    </p>
                  ))}
                </div>
              );
            })}
            <div>
              <Button
                size="sm"
                variant="ghost"
                disabled={lines.length >= 20}
                onClick={() => setLines(list => [...list, blank(Math.max(...list.map(l => l.key)) + 1)])}
              >
                <IconPlus className="size-4" />
                Add item
              </Button>
            </div>
            {errors.lines && (
              <p className="text-[13px] text-destructive" role="alert">
                {errors.lines}
              </p>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Note" />
          <CardBody>
            <Field label="Note to the customer" hint="Optional. Shown on the pay page." error={errors.note}>
              {id => (
                <Textarea
                  id={id}
                  value={note}
                  onChange={e => setNote(e.target.value)}
                  placeholder="Thanks for the call today. This covers what we agreed."
                  aria-invalid={Boolean(errors.note) || undefined}
                />
              )}
            </Field>
          </CardBody>
        </Card>
      </div>

      <Card className="self-start lg:sticky lg:top-6">
        <CardHeader
          title="Summary"
          action={
            quoting && (
              <span
                className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground"
                role="status"
              >
                <IconLoader2 aria-hidden className="size-3.5 animate-spin" />
                Updating
              </span>
            )
          }
        />
        <CardBody className="grid gap-4">
          <ul className="grid gap-2 text-sm" aria-label="Priced items">
            {lines.map((line, index) => {
              const priced = quote?.lines[index];
              return (
                <li key={line.key} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 [overflow-wrap:anywhere] text-subtle-foreground">
                    {priced
                      ? `${priced.quantity} × ${priced.description}`
                      : line.description.trim() || `Item ${index + 1}`}
                  </span>
                  <span className="shrink-0 tabular-nums">{priced ? usd(priced.amountMinor) : '—'}</span>
                </li>
              );
            })}
          </ul>
          <div className="flex items-baseline justify-between border-t border-border-subtle pt-4">
            <span className="text-muted-foreground">Total</span>
            <span className="text-2xl font-semibold tabular-nums" data-testid="order-total">
              {usd(quote?.totalMinor ?? '0')}
            </span>
          </div>
          <p className="text-[13px] text-muted-foreground">
            Priced by the server from your catalog and the amounts above. The customer pays exactly this
            total, with no fees added. At least {usd(options.minimumMinor)}.
          </p>
          {quoteError && !error && <Notice tone="warning">{quoteError}</Notice>}
          {error && <Notice tone="danger">{error}</Notice>}
          {tried && hasErrors && !error && <Notice tone="danger">Fix the highlighted details first.</Notice>}
          <Button type="submit" variant="dark" disabled={pending}>
            {pending ? 'Creating…' : 'Create order'}
          </Button>
          <Button asChild variant="ghost">
            <Link href="/dashboard/orders">Cancel</Link>
          </Button>
        </CardBody>
      </Card>
    </form>
  );
}
