import { cn } from '@/lib/cn';
import { CopyButton } from './copy-button';

export function CodeBlock({
  code,
  title,
  className,
  diff = false,
}: {
  code: string;
  title?: string;
  className?: string;
  diff?: boolean;
}) {
  return (
    <div
      className={cn(
        'min-w-0 overflow-hidden rounded-2xl border border-ink-line bg-ink text-[#e8e8e8]',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-ink-line py-1.5 pr-1.5 pl-4">
        <span className="truncate font-mono text-[13px] text-ink-foreground">{title ?? 'code'}</span>
        <CopyButton
          value={diff ? code.replace(/^[+-] ?/gm, '') : code}
          label="Copy code"
          className="text-ink-foreground hover:bg-white/10 hover:text-white"
        />
      </div>
      <pre className="overflow-x-auto p-4 text-[13px] leading-relaxed">
        <code>
          {diff
            ? code.split('\n').map((line, i) => (
                <span
                  key={i}
                  className={cn(
                    'block',
                    line.startsWith('+') && 'bg-[#c6ff34]/12 text-[#d9ff7a]',
                    line.startsWith('-') && 'bg-[#ff8a7a]/12 text-[#ffb3a8]',
                  )}
                >
                  {line || ' '}
                </span>
              ))
            : code}
        </code>
      </pre>
    </div>
  );
}
