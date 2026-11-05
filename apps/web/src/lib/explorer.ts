const EXPLORER = 'https://explorer.testnet.whitechain.io';

/** Mock data uses synthetic hashes, so links open the local mock explorer instead. */
const mock = process.env.NEXT_PUBLIC_PACT_DATA === 'mock';
/** A local fork's transactions exist only on the fork, so they open a local explorer page. */
const localFork = process.env.NEXT_PUBLIC_PACT_LOCAL_FORK === '1';

export function txUrl(hash: string): string {
  if (mock) return `/demo/explorer/tx/${hash}`;
  return localFork ? `/explorer/tx/${hash}` : `${EXPLORER}/tx/${hash}`;
}

export function addressUrl(address: string): string {
  if (mock) return `/demo/explorer/address/${address}`;
  return localFork ? `/explorer/address/${address}` : `${EXPLORER}/address/${address}`;
}

export const explorerIsMock = mock;
