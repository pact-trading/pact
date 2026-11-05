import { IconArrowUpRight } from '@tabler/icons-react';
import { cn } from '@/lib/cn';
import { txUrl } from '@/lib/explorer';
import { shortHash } from '@/lib/format';

/**
 * A link to the onchain record. Merchants see the hash; customers see plain words
 * ("View public record"), since they never need to know what a hash is.
 */
export function PublicRecord({
  hash,
  audience = 'merchant',
  className,
}: {
  hash: string | null | undefined;
  audience?: 'merchant' | 'customer';
  className?: string;
}) {
  if (!hash) return null;
  return (
    <a
      href={txUrl(hash)}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'inline-flex items-center gap-1 text-sm font-medium underline-offset-4 hover:underline',
        className,
      )}
    >
      {audience === 'customer' ? (
        'View public record'
      ) : (
        <code className="font-mono text-[13px]">{shortHash(hash)}</code>
      )}
      <IconArrowUpRight className="size-3.5" />
    </a>
  );
}
