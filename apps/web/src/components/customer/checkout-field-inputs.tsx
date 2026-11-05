'use client';

import type { CheckoutAnswer, CheckoutField } from '@pactagent/core/checkout-fields';
import { Field, Input } from '../ui/field';

/** The merchant's extra questions on a hosted checkout. */
export function CheckoutFieldInputs({
  fields,
  answers,
  errors,
  onChange,
}: {
  fields: readonly CheckoutField[];
  answers: Record<string, CheckoutAnswer>;
  errors: Record<string, string>;
  onChange: (key: string, value: CheckoutAnswer) => void;
}) {
  if (!fields.length) return null;
  return (
    <div className="grid gap-4">
      {fields.map(field =>
        field.type === 'checkbox' ? (
          <div key={field.key} className="grid gap-1.5">
            <label className="flex items-start gap-3 text-sm font-medium">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--pact-ink)]"
                checked={answers[field.key] === true}
                onChange={event => onChange(field.key, event.target.checked)}
                aria-invalid={Boolean(errors[field.key]) || undefined}
              />
              <span>{field.required ? field.label : `${field.label} (optional)`}</span>
            </label>
            {errors[field.key] && (
              <p className="text-[13px] text-destructive" role="alert">
                {errors[field.key]}
              </p>
            )}
          </div>
        ) : (
          <Field
            key={field.key}
            label={field.required ? field.label : `${field.label} (optional)`}
            error={errors[field.key]}
          >
            {id => (
              <Input
                id={id}
                type={field.type === 'number' ? 'number' : 'text'}
                step={field.type === 'number' ? 'any' : undefined}
                maxLength={field.type === 'text' ? 500 : undefined}
                value={String(answers[field.key] ?? '')}
                onChange={event => onChange(field.key, event.target.value)}
                aria-invalid={Boolean(errors[field.key]) || undefined}
              />
            )}
          </Field>
        ),
      )}
    </div>
  );
}
