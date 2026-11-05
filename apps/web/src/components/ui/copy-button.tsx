'use client';

import { IconCheck, IconCopy } from '@tabler/icons-react';
import { useState } from 'react';
import { cn } from '@/lib/cn';

export function CopyButton({
  value,
  label = 'Copy',
  className,
  showLabel = false,
}: {
  value: string;
  label?: string;
  className?: string;
  showLabel?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        } catch {
          // Clipboard may be blocked; the value stays visible to select manually.
        }
      }}
      className={cn(
        'inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-chip hover:text-foreground',
        className,
      )}
    >
      {copied ? <IconCheck className="size-4 text-success" /> : <IconCopy className="size-4" />}
      {showLabel && (copied ? 'Copied' : label)}
    </button>
  );
}
