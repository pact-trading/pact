'use client';

import type { CheckoutField, CheckoutFieldType } from '@pactagent/core/checkout-fields';
import { Button } from '../ui/button';
import { Field, Input, Select } from '../ui/field';

export type CheckoutFieldRow = { key?: string; label: string; type: CheckoutFieldType; required: boolean };

export const toFieldRows = (fields: readonly CheckoutField[] = []): CheckoutFieldRow[] =>
  fields.map(field => ({ key: field.key, label: field.label, type: field.type, required: Boolean(field.required) }));

/** Keeps the keys of saved questions, so answers on past orders still match, and names new ones from their label. */
export function toCheckoutFields(rows: readonly CheckoutFieldRow[]): CheckoutField[] {
  const filled = rows.filter(row => row.label.trim());
  const used = new Set(filled.flatMap(row => (row.key ? [row.key] : [])));
  return filled.map(row => {
    let key = row.key;
    if (!key) {
      const words = row.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30);
      const base = /^[a-z]/.test(words) ? words : `field_${words}`.replace(/_+$/, '');
      key = base;
      for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
      used.add(key);
    }
    return { key, label: row.label.trim(), type: row.type, ...(row.required ? { required: true } : {}) };
  });
}

/** Extra questions for the customer. Answers are saved on the order and sent in webhooks. */
export function CheckoutFieldsEditor({
  rows,
  onChange,
}: {
  rows: CheckoutFieldRow[];
  onChange: (rows: CheckoutFieldRow[]) => void;
}) {
  const edit = (index: number, change: Partial<CheckoutFieldRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...change } : row)));
  return (
    <fieldset className="grid gap-3">
      <legend className="text-sm font-medium">Checkout fields</legend>
      <p className="text-[13px] text-muted-foreground">
        Ask the customer for anything you need with the order. Answers appear on the order and in webhooks.
      </p>
      {rows.map((row, index) => (
        <div key={row.key ?? `new-${index}`} className="grid gap-3 rounded-[14px] border border-border p-3 sm:grid-cols-[minmax(0,1fr)_130px]">
          <Field label="Question">
            {id => (
              <Input
                id={id}
                value={row.label}
                maxLength={120}
                placeholder="Company name"
                onChange={event => edit(index, { label: event.target.value })}
              />
            )}
          </Field>
          <Field label="Answer type">
            {id => (
              <Select
                id={id}
                value={row.type}
                onChange={event => edit(index, { type: event.target.value as CheckoutFieldType })}
              >
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="checkbox">Checkbox</option>
              </Select>
            )}
          </Field>
          <div className="flex items-center justify-between gap-3 sm:col-span-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-[var(--pact-ink)]"
                checked={row.required}
                onChange={event => edit(index, { required: event.target.checked })}
              />
              Required
            </label>
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange(rows.filter((_, i) => i !== index))}>
              Remove
            </Button>
          </div>
        </div>
      ))}
      {rows.length < 20 && (
        <div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => onChange([...rows, { label: '', type: 'text', required: false }])}
          >
            Add field
          </Button>
        </div>
      )}
    </fieldset>
  );
}
