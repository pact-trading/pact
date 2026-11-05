import { cn } from '@/lib/cn';

/** A ring gauge, e.g. gas tank runway in days against a target. */
export function Gauge({
  value,
  max,
  label,
  sublabel,
  tone = 'success',
  size = 132,
  className,
}: {
  value: number;
  max: number;
  label: string;
  sublabel: string;
  tone?: 'success' | 'warning' | 'danger';
  size?: number;
  className?: string;
}) {
  const stroke = 10;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = Math.max(0, Math.min(1, max === 0 ? 0 : value / max));
  const color =
    tone === 'danger' ? 'var(--destructive)' : tone === 'warning' ? 'var(--warning)' : 'var(--success)';
  return (
    <div
      className={cn('relative grid shrink-0 place-items-center', className)}
      style={{ width: size, height: size }}
      role="img"
      aria-label={`${label} ${sublabel}`}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="var(--chip)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - ratio)}
        />
      </svg>
      <div className="absolute text-center">
        <div className="text-[28px] leading-none font-semibold">{label}</div>
        <div className="mt-1 text-[13px] text-muted-foreground">{sublabel}</div>
      </div>
    </div>
  );
}
