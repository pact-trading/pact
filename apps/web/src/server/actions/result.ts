import 'server-only';
import { DataError } from '../data/errors';

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

/** Server actions return errors as values: thrown errors are redacted in production builds. */
export async function attempt<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    if (error instanceof DataError) return { ok: false, error: { code: error.code, message: error.message } };
    console.error(error);
    return { ok: false, error: { code: 'unexpected', message: 'Something went wrong. Please try again.' } };
  }
}
