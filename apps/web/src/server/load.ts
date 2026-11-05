import 'server-only';
import { notFound, redirect } from 'next/navigation';
import { DataError, NotWiredError } from './data/errors';
import { isMock } from './mode';

/**
 * Loads page data. A missing record becomes the 404 page; a screen whose API
 * endpoint does not exist yet returns the NotWiredError so the page can say so.
 */
export async function load<T>(work: () => Promise<T>): Promise<T | NotWiredError> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof NotWiredError) return error;
    if (error instanceof DataError && error.status === 404) notFound();
    // Pages render alongside their layout; a signed-out visitor is sent to sign in here too.
    if (error instanceof DataError && (error.status === 401 || error.status === 403))
      redirect(isMock ? '/demo' : '/login');
    throw error;
  }
}

export const isNotWired = (value: unknown): value is NotWiredError => value instanceof NotWiredError;
