import 'server-only';
import { dataMode } from '../mode';
import type { DataSource } from './types';

/** The single entry point screens and actions use; never import a source directly. */
export async function getData(): Promise<DataSource> {
  if (dataMode === 'mock') return (await import('./mock/source')).mockSource;
  return (await import('./api/source')).apiSource;
}

export { DataError, NotWiredError } from './errors';
export type * from './types';
