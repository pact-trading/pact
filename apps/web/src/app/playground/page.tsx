import type { Metadata } from 'next';
import { Playground } from '@/components/playground/playground';
import { configFromSearch } from '@/components/playground/config';

export const metadata: Metadata = { title: 'Checkout playground' };

export default async function PlaygroundPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Share links open with their settings on the first render; repeated or unknown params are ignored.
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams))
    if (typeof value === 'string') query.set(key, value);
  return <Playground initial={configFromSearch(query)} />;
}
