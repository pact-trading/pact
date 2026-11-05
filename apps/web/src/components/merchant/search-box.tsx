import { IconSearch } from '@tabler/icons-react';

/** A GET search form; keeps other query params (like the active tab) as hidden fields. */
export function SearchBox({
  placeholder,
  value,
  keep,
}: {
  placeholder: string;
  value?: string;
  keep?: Record<string, string | undefined>;
}) {
  return (
    <form role="search" className="relative w-full sm:w-72">
      {Object.entries(keep ?? {}).map(
        ([name, v]) => v && <input key={name} type="hidden" name={name} value={v} />,
      )}
      <IconSearch
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        type="search"
        name="q"
        defaultValue={value}
        placeholder={placeholder}
        aria-label={placeholder}
        className="h-10 w-full rounded-full border border-input bg-card pr-4 pl-10 text-[15px] placeholder:text-muted-foreground/70 focus-visible:border-foreground focus-visible:outline-none"
      />
    </form>
  );
}
