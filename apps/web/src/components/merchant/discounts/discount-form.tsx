'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { Product } from '@pactagent/core/commerce-types';
import { createDiscount, archiveDiscount } from '@/server/actions/commerce';
import type { Discount, DiscountInput } from '@/server/data/parts/commerce';
import { toMinor } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';

export function DiscountForm({ products, plans }: { products: Product[]; plans: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<Discount['kind']>('percent');
  const [value, setValue] = useState('');
  const [duration, setDuration] = useState<Discount['duration']>('once');
  const [periods, setPeriods] = useState('2');
  const [max, setMax] = useState('');
  const [starts, setStarts] = useState('');
  const [expires, setExpires] = useState('');
  const [productsSelected, setProductsSelected] = useState<string[]>([]);
  const scopes = [...products.map(p => ({ id: p.id, label: p.name })), ...plans.map(p => ({ id: p.id, label: `${p.name} (plan)` }))];
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const submit = () => start(async () => {
    setError('');
    let stored: string;
    try {
      if (kind === 'percent') {
        // Parsed from the text: 19.99 * 100 is not 1999 in floating point.
        const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value.trim());
        if (!match) throw new Error();
        const basisPoints = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
        if (basisPoints <= 0 || basisPoints > 10_000) throw new Error();
        stored = String(basisPoints);
      } else stored = toMinor(value).toString();
    } catch { setError('Enter a percentage from 0.01 to 100, or a USDT amount above zero.'); return; }
    const input: DiscountInput = { code, kind, value: stored, duration, periods: duration === 'repeating' ? Number(periods) : null,
      maxRedemptions: max ? Number(max) : null, startsAt: starts ? new Date(`${starts}T00:00:00Z`).toISOString() : null, expiresAt: expires ? new Date(`${expires}T23:59:59Z`).toISOString() : null,
      productIds: productsSelected.length ? productsSelected : null };
    const result = await createDiscount(input);
    if (!result.ok) { setError(result.error.message); return; }
    setCode(''); setValue(''); router.refresh();
  });
  return <form onSubmit={event => { event.preventDefault(); submit(); }} className="grid gap-4 rounded-2xl border border-border bg-card p-5">
    <h2 className="text-lg font-semibold">New discount</h2>
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label="Code">{id => <Input id={id} value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="LAUNCH20" required />}</Field>
      <Field label="Type">{id => <Select id={id} value={kind} onChange={e => setKind(e.target.value as Discount['kind'])}><option value="percent">Percentage</option><option value="fixed">Fixed USDT</option></Select>}</Field>
      <Field label={kind === 'percent' ? 'Percent off' : 'USDT off'}>{id => <Input id={id} value={value} onChange={e => setValue(e.target.value)} inputMode="decimal" placeholder={kind === 'percent' ? '20' : '5.00'} required />}</Field>
      <Field label="Duration">{id => <Select id={id} value={duration} onChange={e => setDuration(e.target.value as Discount['duration'])}><option value="once">Once</option><option value="repeating">Repeating</option><option value="forever">Forever</option></Select>}</Field>
      {duration === 'repeating' && <Field label="Periods">{id => <Input id={id} value={periods} onChange={e => setPeriods(e.target.value)} type="number" min="1" max="1000" required />}</Field>}
      <Field label="Maximum uses" hint="Leave empty for no limit">{id => <Input id={id} value={max} onChange={e => setMax(e.target.value)} type="number" min="1" />}</Field>
      <Field label="Start date" hint="Optional">{id => <Input id={id} value={starts} onChange={e => setStarts(e.target.value)} type="date" />}</Field>
      <Field label="End date" hint="Optional">{id => <Input id={id} value={expires} onChange={e => setExpires(e.target.value)} type="date" />}</Field>
    </div>
    {scopes.length > 0 && <fieldset className="grid gap-2"><legend className="text-sm font-medium">Applies to</legend><p className="text-xs text-muted-foreground">Leave all unchecked for all products and plans.</p>{scopes.map(scope => <label key={scope.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={productsSelected.includes(scope.id)} onChange={e => setProductsSelected(e.target.checked ? [...productsSelected, scope.id] : productsSelected.filter(id => id !== scope.id))} />{scope.label}</label>)}</fieldset>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Button type="submit" variant="primary" disabled={pending}>{pending ? 'Creating…' : 'Create discount'}</Button>
  </form>;
}

export function ArchiveDiscount({ id }: { id: string }) {
  const router = useRouter(); const [pending, start] = useTransition(); const [error, setError] = useState('');
  return <span className="inline-flex items-center gap-2"><Button size="sm" variant="secondary" disabled={pending} onClick={() => start(async () => {
    if (!window.confirm('Archive this discount? Existing subscriptions keep their agreed price.')) return;
    const result = await archiveDiscount(id); if (!result.ok) { setError(result.error.message); return; } router.refresh();
  })}>{pending ? 'Archiving…' : 'Archive'}</Button>{error && <span role="alert" className="text-xs text-destructive">{error}</span>}</span>;
}
