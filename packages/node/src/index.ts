import { PactClient, fetchTransport, type Transport } from '@pactagent/core';

export interface PactNodeOptions {
  apiKey: string;
  baseUrl?: string;
  transport?: Transport;
  fetch?: typeof fetch;
}

/** Server-only client. Keep apiKey out of browser and mobile bundles. */
export function createPactNodeClient(options: PactNodeOptions): PactClient {
  if (!options.apiKey) throw new Error('Pact API key is required');
  if (!options.transport && !options.baseUrl) throw new Error('Pact baseUrl or transport is required');
  return new PactClient({
    apiKey: options.apiKey,
    transport: options.transport ?? fetchTransport(options.baseUrl!, options.fetch),
  });
}

export * from '@pactagent/core';
