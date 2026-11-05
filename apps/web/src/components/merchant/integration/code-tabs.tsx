'use client';

import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';
import { CodeBlock } from '../../ui/code-block';
import {
  codeLanguages,
  fileName,
  install,
  snippet,
  type CodeLanguage,
  type SnippetContext,
} from './snippets';

/** Pill tabs with arrow-key navigation, styled like LinkTabs. */
export function PillTabs<T extends string>({
  label,
  items,
  value,
  onChange,
  idPrefix,
}: {
  label: string;
  items: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  idPrefix: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKey = (event: KeyboardEvent, index: number) => {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const to = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : index + step;
    if (!step && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next = (to + items.length) % items.length;
    onChange(items[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={el => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${index}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={event => onKey(event, index)}
            className={cn(
              'inline-flex h-9 shrink-0 items-center rounded-full px-3.5 text-sm font-medium transition-colors',
              selected ? 'bg-foreground text-background' : 'text-subtle-foreground hover:bg-chip',
            )}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

/** React, Node server, React Native and curl versions of the same checkout, each with copy. */
export function CodeTabs({
  context,
  initial = 'React',
  showInstall = true,
}: {
  context: SnippetContext;
  initial?: CodeLanguage;
  showInstall?: boolean;
}) {
  const id = useId();
  const [language, setLanguage] = useState<CodeLanguage>(initial);
  const index = codeLanguages.indexOf(language);
  return (
    <div className="grid min-w-0 gap-3">
      <PillTabs
        label="Code language"
        idPrefix={id}
        items={codeLanguages.map(value => ({ value, label: value }))}
        value={language}
        onChange={setLanguage}
      />
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-tab-${index}`}
        className="grid min-w-0 gap-3"
      >
        {showInstall && <CodeBlock title="Install" code={install[language]} />}
        <CodeBlock title={fileName[language]} code={snippet(language, context)} />
      </div>
    </div>
  );
}
