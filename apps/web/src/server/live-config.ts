import 'server-only';
import type { LiveConfig } from '@/lib/live-wallet';
import { publicApi } from './api-client';

let cached: { at: number; network: LiveConfig['network'] } | null = null;

/** Chain access for the browser. Read at request time, so a redeployed local suite needs no rebuild. */
export async function liveConfig(): Promise<LiveConfig> {
  if (!cached || Date.now() - cached.at > 30_000) {
    const network = await publicApi<NonNullable<LiveConfig['network']>>('/v1/network').catch(() => null);
    cached = { at: Date.now(), network };
  }
  return {
    localFork: process.env.PACT_LOCAL_FORK === '1',
    rpcUrl: process.env.PACT_CHAIN_RPC_URL ?? 'https://rpc.testnet.whitechain.io',
    privyConfigured: Boolean(process.env.NEXT_PUBLIC_PRIVY_APP_ID),
    network: cached.network,
  };
}
