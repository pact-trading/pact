'use client';

import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * A choice between a few options, as native radio buttons in bordered cards, so arrow keys,
 * labels and screen readers work without extra code. Matches the gas policy picker.
 */
export function RadioCards<T extends string>({
  legend,
  value,
  onChange,
  options,
  disabled,
  columns = 2,
  className,
}: {
  legend: string;
  value: T;
  onChange: (value: T) => void;
  options: Array<{ value: T; title: ReactNode; body?: ReactNode }>;
  disabled?: boolean;
  columns?: 1 | 2 | 3;
  className?: string;
}) {
  const name = useId();
  return (
    <fieldset className={cn('grid gap-2', className)} disabled={disabled}>
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      <div className={cn('grid gap-2', columns === 2 && 'sm:grid-cols-2', columns === 3 && 'sm:grid-cols-3')}>
        {options.map(option => (
          <label
            key={option.value}
            className={cn(
              'flex cursor-pointer gap-3 rounded-2xl border p-3.5 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40',
              value === option.value
                ? 'border-foreground bg-raised'
                : 'border-border hover:border-foreground/30',
              disabled && 'cursor-not-allowed opacity-60',
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              className="mt-1 accent-[var(--pact-ink)]"
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span className="min-w-0">
              <span className="block text-[15px] font-medium">{option.title}</span>
              {option.body && <span className="block text-sm text-muted-foreground">{option.body}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
