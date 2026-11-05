import { forwardRef, type AnchorHTMLAttributes } from 'react';

/** The landing has no Next router: app components that use next/link render a plain anchor. */
const Link = forwardRef<
  HTMLAnchorElement,
  AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; scroll?: boolean; prefetch?: boolean }
>(({ scroll: _scroll, prefetch: _prefetch, ...props }, ref) => <a ref={ref} {...props} />);
Link.displayName = 'Link';
export default Link;
