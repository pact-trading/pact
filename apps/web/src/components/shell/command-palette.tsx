'use client';

import { IconArrowRight, IconCornerDownLeft, IconSearch, type Icon } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

export interface Command {
  id: string;
  label: string;
  group: string;
  href: string;
  icon: Icon;
  /** Extra words that should match, e.g. "refund" for Orders. */
  keywords?: string;
}

/** Ranks a command for a query: label prefix first, then label words, then keywords. */
function score(command: Command, query: string): number {
  if (!query) return 1;
  const label = command.label.toLowerCase();
  if (label.startsWith(query)) return 4;
  if (label.split(/\s+/).some(word => word.startsWith(query))) return 3;
  if (label.includes(query)) return 2;
  return `${command.group} ${command.keywords ?? ''}`.toLowerCase().includes(query) ? 1 : 0;
}

/**
 * ⌘K / Ctrl+K command palette: jump to any screen or start a common action.
 * A combobox over a listbox; arrows move, Enter opens, Escape closes and returns focus.
 */
export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const baseId = useId();

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return commands
      .map((command, index) => ({ command, rank: score(command, q), index }))
      .filter(item => item.rank > 0)
      .sort((a, b) => b.rank - a.rank || a.index - b.index)
      .map(item => item.command);
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    setQuery('');
    setActive(0);
    const frame = requestAnimationFrame(() => input.current?.focus());
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, [open]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open || typeof document === 'undefined') return null;

  const go = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    router.push(command.href);
  };

  const groups: Array<{ name: string; items: Array<{ command: Command; index: number }> }> = [];
  results.forEach((command, index) => {
    const group = groups.find(g => g.name === command.group);
    if (group) group.items.push({ command, index });
    else groups.push({ name: command.group, items: [{ command, index }] });
  });

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-start justify-center p-3 pt-[12vh] sm:p-6 sm:pt-[14vh]">
      <div
        aria-hidden
        className="absolute inset-0 animate-fade-in bg-black/45 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search Pact"
        className="relative w-full max-w-xl animate-fade-in overflow-hidden rounded-3xl border border-border bg-card shadow-panel motion-reduce:animate-none"
        onKeyDown={event => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActive(i => Math.min(results.length - 1, i + 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive(i => Math.max(0, i - 1));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            go(results[active]);
          } else if (event.key === 'Tab') {
            // Keep focus in the search field; the list is driven by the arrow keys.
            event.preventDefault();
            input.current?.focus();
          }
        }}
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <IconSearch className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={input}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${baseId}-list`}
            aria-activedescendant={results[active] ? `${baseId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-label="Search screens and actions"
            placeholder="Search screens and actions"
            value={query}
            onChange={event => setQuery(event.target.value)}
            className="h-14 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          />
          <kbd className="hidden rounded-md border border-border px-1.5 py-0.5 text-[12px] text-muted-foreground sm:inline">
            Esc
          </kbd>
        </div>
        <ul
          ref={list}
          id={`${baseId}-list`}
          role="listbox"
          aria-label="Results"
          className="max-h-[min(420px,60vh)] overflow-y-auto p-2"
        >
          {results.length === 0 && (
            <li className="px-3 py-8 text-center text-[15px] text-muted-foreground">
              No screen or action matches “{query}”.
            </li>
          )}
          {groups.map(group => (
            <li key={group.name} role="presentation">
              <p className="px-3 pt-2 pb-1 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
                {group.name}
              </p>
              <ul role="presentation">
                {group.items.map(({ command, index }) => (
                  <li
                    key={command.id}
                    id={`${baseId}-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={index === active}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => go(command)}
                    className={cn(
                      'flex h-11 cursor-pointer items-center gap-3 rounded-xl px-3 text-[15px]',
                      index === active ? 'bg-chip text-foreground' : 'text-subtle-foreground',
                    )}
                  >
                    <command.icon className="size-[18px] shrink-0" stroke={1.6} aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{command.label}</span>
                    {index === active ? (
                      <IconCornerDownLeft className="size-4 text-muted-foreground" aria-hidden />
                    ) : (
                      <IconArrowRight className="size-4 text-transparent" aria-hidden />
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
        <p className="flex items-center gap-3 border-t border-border px-4 py-2.5 text-[13px] text-muted-foreground">
          <span>↑ ↓ to move</span>
          <span>Enter to open</span>
          <span className="ml-auto hidden sm:inline">⌘ K anywhere</span>
        </p>
      </div>
    </div>,
    document.body,
  );
}
