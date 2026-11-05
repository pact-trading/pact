import {
  IconBolt,
  IconBox,
  IconHeadset,
  IconPuzzle,
  IconSchool,
  IconWorldSearch,
  type Icon,
} from '@tabler/icons-react';
import { cn } from '@/lib/cn';

const art: Record<string, { icon: Icon; tile: string }> = {
  prod_audit: { icon: IconWorldSearch, tile: 'bg-ink text-primary' },
  prod_sprint: { icon: IconBolt, tile: 'bg-primary text-primary-foreground' },
  prod_support: { icon: IconHeadset, tile: 'bg-success-soft text-success' },
  prod_toolkit: { icon: IconPuzzle, tile: 'bg-warning-soft text-warning' },
  prod_workshop: { icon: IconSchool, tile: 'bg-chip text-foreground' },
};
const fallback = [
  'bg-chip text-foreground',
  'bg-ink text-primary',
  'bg-success-soft text-success',
  'bg-warning-soft text-warning',
];

/** A product image for products without one: a tinted tile with an icon. */
export function ProductArt({
  productId,
  imageUrl,
  name,
  className,
}: {
  productId: string;
  imageUrl: string | null;
  name: string;
  className?: string;
}) {
  if (imageUrl)
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={imageUrl}
        alt={name}
        className={cn('w-full object-cover', className)}
        referrerPolicy="no-referrer"
      />
    );
  const known = art[productId];
  const Glyph = known?.icon ?? IconBox;
  const tile =
    known?.tile ?? fallback[[...productId].reduce((sum, c) => sum + c.charCodeAt(0), 0) % fallback.length];
  return (
    <div aria-hidden className={cn('grid w-full place-items-center', tile, className)}>
      <Glyph className="size-16" stroke={1.5} />
    </div>
  );
}
