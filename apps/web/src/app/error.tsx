'use client';

import { RouteError } from '@/components/states/route-error';

/** Fallback for routes without their own boundary (payment links, legal pages, playground). */
export default function ErrorPage(props: { error: Error & { digest?: string }; reset: () => void }) {
  return <RouteError {...props} standalone />;
}
