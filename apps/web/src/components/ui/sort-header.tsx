import Link from 'next/link';
import { IconArrowDown, IconArrowUp, IconSelector } from '@tabler/icons-react';
import { cn } from '@/lib/cn';
import { Th } from './table';

export type SortDir = 'asc' | 'desc';
export interface Sort<K extends string = string> {
  key: K | null;
  dir: SortDir;
}

/** Reads `?sort=&dir=`, ignoring columns the list does not offer. */
export function readSort<K extends string>(
  params: { sort?: string; dir?: string },
  keys: readonly K[],
): Sort<K> {
  const key = keys.includes(params.sort as K) ? (params.sort as K) : null;
  return { key, dir: params.dir === 'asc' ? 'asc' : 'desc' };
}

type SortValue = string | number | bigint | boolean | null | undefined;

/**
 * Sorts a copy of `rows` on the server. Missing values always go last; ties keep their original
 * (newest first) order. Without an active column the rows are returned as they came.
 */
export function sortRows<T, K extends string>(
  rows: T[],
  sort: Sort<K>,
  values: Record<K, (row: T) => SortValue>,
): T[] {
  if (!sort.key) return rows;
  const value = values[sort.key];
  const sign = sort.dir === 'asc' ? 1 : -1;
  return rows
    .map((row, index) => ({ row, index, v: value(row) }))
    .sort((a, b) => {
      const empty = (v: SortValue) => v === null || v === undefined || v === '';
      if (empty(a.v) || empty(b.v))
        return empty(a.v) === empty(b.v) ? a.index - b.index : empty(a.v) ? 1 : -1;
      const x = a.v!;
      const y = b.v!;
      const order =
        typeof x === 'string' && typeof y === 'string'
          ? x.localeCompare(y, 'en', { sensitivity: 'base', numeric: true })
          : x < y
            ? -1
            : x > y
              ? 1
              : 0;
      return order === 0 ? a.index - b.index : order * sign;
    })
    .map(item => item.row);
}

/** The query string for a list, dropping empty values. */
export function listHref(path: string, params: Record<string, string | null | undefined>): string {
  const query = new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])),
  ).toString();
  return query ? `${path}?${query}` : path;
}

/** The params that keep a list's sort when a tab or search changes. */
export const sortParams = (sort: Sort) => (sort.key ? { sort: sort.key, dir: sort.dir } : {});

/**
 * A sortable column header: a link that sorts the list on the server through `?sort=&dir=`, so
 * sorting works without JavaScript and survives reloads. The first click uses `first`; clicking
 * the active column flips the direction.
 */
export function SortHeader({
  label,
  column,
  sort,
  path,
  params = {},
  align,
  first = 'asc',
  className,
}: {
  label: string;
  column: string;
  sort: Sort;
  path: string;
  /** Every other query param the list keeps, such as the status tab and search. */
  params?: Record<string, string | null | undefined>;
  align?: 'right';
  /** Direction of the first click: ascending for names, descending for amounts and dates. */
  first?: SortDir;
  className?: string;
}) {
  const active = sort.key === column;
  const next: SortDir = active ? (sort.dir === 'asc' ? 'desc' : 'asc') : first;
  const Icon = !active ? IconSelector : sort.dir === 'asc' ? IconArrowUp : IconArrowDown;
  return (
    <Th
      align={align}
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
      className={className}
    >
      <Link
        href={listHref(path, { ...params, sort: column, dir: next })}
        scroll={false}
        className={cn(
          '-mx-1 inline-flex items-center gap-1 rounded-md px-1 transition-colors hover:text-foreground',
          align === 'right' && 'flex-row-reverse',
          active && 'text-foreground',
        )}
      >
        {label}
        <Icon aria-hidden className={cn('size-3.5 shrink-0', !active && 'opacity-50')} />
      </Link>
    </Th>
  );
}
