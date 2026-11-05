'use client';

import { IconPlus } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { Product } from '@pactagent/core/commerce-types';
import { createProduct, updateProduct } from '@/server/actions/merchant';
import { fromMinor, toMinor } from '@/lib/format';
import { CheckoutFieldsEditor, toCheckoutFields, toFieldRows, type CheckoutFieldRow } from '../checkout-fields-editor';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { AmountInput, Field, Input, Select, Textarea } from '../../ui/field';
import { Notice } from '../../ui/notice';
import { useToast } from '../../ui/toast';

type Draft = { name: string; description: string; price: string; status: Product['status']; fields: CheckoutFieldRow[] };

function ProductFields({
  draft,
  onChange,
  error,
}: {
  draft: Draft;
  onChange: (draft: Draft) => void;
  error: string;
}) {
  return (
    <div className="grid gap-4">
      <Field label="Name">
        {id => (
          <Input
            id={id}
            value={draft.name}
            onChange={e => onChange({ ...draft, name: e.target.value })}
            maxLength={120}
            required
            placeholder="Website audit"
          />
        )}
      </Field>
      <Field label="Description" hint="Shown on the checkout page.">
        {id => (
          <Textarea
            id={id}
            value={draft.description}
            onChange={e => onChange({ ...draft, description: e.target.value })}
            maxLength={500}
          />
        )}
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Price" hint="Charged in USDT, shown in dollars.">
          {id => (
            <AmountInput
              id={id}
              value={draft.price}
              onChange={e =>
                /^\d*(\.\d{0,6})?$/.test(e.target.value) && onChange({ ...draft, price: e.target.value })
              }
              placeholder="490.00"
              required
            />
          )}
        </Field>
        <Field label="Status">
          {id => (
            <Select
              id={id}
              value={draft.status}
              onChange={e => onChange({ ...draft, status: e.target.value as Product['status'] })}
            >
              <option value="active">Active, can be bought</option>
              <option value="draft">Draft, hidden</option>
              <option value="archived">Archived</option>
            </Select>
          )}
        </Field>
      </div>
      <CheckoutFieldsEditor rows={draft.fields} onChange={fields => onChange({ ...draft, fields })} />
      {error && <Notice tone="danger">{error}</Notice>}
    </div>
  );
}

const toInput = (draft: Draft) => ({
  name: draft.name,
  description: draft.description,
  status: draft.status,
  priceMinor: toMinor(draft.price || '0').toString(),
  checkoutFields: toCheckoutFields(draft.fields),
});

export function NewProductButton({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>({ name: '', description: '', price: '', status: 'active', fields: [] });
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      setError('');
      if (!draft.price || toMinor(draft.price) <= 0n) return setError('Enter a price above zero.');
      const result = await createProduct(toInput(draft));
      if (!result.ok) return setError(result.error.message);
      toast(`${result.data.name} created`);
      setOpen(false);
      setDraft({ name: '', description: '', price: '', status: 'active', fields: [] });
      router.push(`/dashboard/products/${result.data.id}`);
    });
  return (
    <>
      <Button variant="primary" size="sm" onClick={() => setOpen(true)} disabled={disabled}>
        <IconPlus className="size-4" />
        New product
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="New product"
        description="A one-time purchase with its own hosted checkout link."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="dark" onClick={save} disabled={pending || !draft.name.trim()}>
              {pending ? 'Creating…' : 'Create product'}
            </Button>
          </>
        }
      >
        <ProductFields draft={draft} onChange={setDraft} error={error} />
      </Dialog>
    </>
  );
}

export function EditProductForm({ product, readOnly }: { product: Product; readOnly: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [draft, setDraft] = useState<Draft>({
    name: product.name,
    description: product.description,
    price: fromMinor(product.prices[0]?.amountMinor ?? '0'),
    status: product.status,
    fields: toFieldRows(product.checkoutFields),
  });
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      setError('');
      const result = await updateProduct(product.id, toInput(draft));
      if (!result.ok) return setError(result.error.message);
      toast('Product saved');
      router.refresh();
    });
  return (
    <form
      onSubmit={event => {
        event.preventDefault();
        save();
      }}
      className="grid gap-5"
    >
      <fieldset disabled={readOnly} className="contents">
        <ProductFields draft={draft} onChange={setDraft} error={error} />
      </fieldset>
      {!readOnly && (
        <div className="flex gap-2">
          <Button type="submit" variant="dark" disabled={pending}>
            {pending ? 'Saving…' : 'Save changes'}
          </Button>
          <p className="self-center text-[13px] text-muted-foreground">
            Saving creates revision {product.revision + 1}. Paid orders keep the price they were bought at.
          </p>
        </div>
      )}
    </form>
  );
}
