'use client';

import { IconArrowLeft } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { cn } from '@/lib/cn';

export type CheckoutBack =
  | {
      href: string;
      label?: string;
      /** Go back in history when the payer came from this site; `href` is the fallback. */
      history?: boolean;
    }
  | { onClick: () => void; label?: string };

const styles = {
  icon: 'grid size-9 shrink-0 place-items-center rounded-full border border-border bg-card text-foreground transition-colors hover:bg-raised',
  link: 'inline-flex items-center justify-center gap-1.5 justify-self-center rounded-full px-3 py-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline',
};

/** The checkout's back arrow and "Back" link. */
export function BackControl({
  back,
  variant,
  className,
}: {
  back: CheckoutBack;
  variant: 'icon' | 'link';
  className?: string;
}) {
  const router = useRouter();
  const label = back.label ?? 'Back';
  const content =
    variant === 'icon' ? (
      <IconArrowLeft aria-hidden className="size-4" />
    ) : (
      <>
        <IconArrowLeft aria-hidden className="size-3.5" />
        {label}
      </>
    );
  const props = {
    className: cn(styles[variant], className),
    'aria-label': variant === 'icon' ? label : undefined,
  };
  if ('onClick' in back)
    return (
      <button type="button" onClick={back.onClick} {...props}>
        {content}
      </button>
    );
  return (
    <Link
      href={back.href}
      onClick={event => {
        if (!back.history) return;
        const sameSite = document.referrer.startsWith(window.location.origin);
        if (sameSite && window.history.length > 1) {
          event.preventDefault();
          router.back();
        }
      }}
      {...props}
    >
      {content}
    </Link>
  );
}
