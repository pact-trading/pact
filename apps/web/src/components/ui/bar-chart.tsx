import { cn } from '@/lib/cn';

/** Compact daily bar chart. Values are plain numbers; labels and titles are preformatted. */
export function BarChart({
  points,
  className,
  height = 160,
  emptyLabel = 'No activity in this period',
}: {
  points: Array<{ label: string; value: number; title: string }>;
  className?: string;
  height?: number;
  emptyLabel?: string;
}) {
  const max = Math.max(...points.map(p => p.value), 0);
  return (
    <figure className={cn('w-full', className)}>
      <div
        className="relative flex items-end gap-1.5"
        style={{ height }}
        role="img"
        aria-label={points.map(p => p.title).join('; ')}
      >
        {max === 0 && (
          <p className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
            {emptyLabel}
          </p>
        )}
        {points.map(point => (
          <div key={point.label} className="group relative flex h-full flex-1 items-end">
            <div
              className="w-full rounded-t-md bg-success/80 transition-colors group-hover:bg-success"
              style={{ height: max ? `${Math.max(point.value > 0 ? 3 : 0, (point.value / max) * 100)}%` : 0 }}
            />
            <span className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 rounded-lg bg-foreground px-2 py-1 text-[12px] whitespace-nowrap text-background group-hover:block">
              {point.title}
            </span>
          </div>
        ))}
      </div>
      <figcaption className="mt-2 flex justify-between text-[12px] text-muted-foreground">
        <span>{points[0]?.label}</span>
        <span>{points[Math.floor(points.length / 2)]?.label}</span>
        <span>{points.at(-1)?.label}</span>
      </figcaption>
    </figure>
  );
}
