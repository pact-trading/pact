'use client';

import { useCallback, useMemo } from 'react';
import { createPublicClient, http, parseAbi } from 'viem';
import { usePactAuth } from '@/components/auth/auth-context';
import { chainFor } from '@/lib/live-wallet';

const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);

export interface MerchantChainState {
  walletUsdtMinor: bigint;
  customerUsdtMinor: bigint | null;
}

/**
 * Live mode: chain reads for the merchant's setup (its USDT and its test customer's), and the
 * local fork's test faucet. The merchant's wallet sends nothing itself: it signs, and Pact's
 * relayer submits and pays the gas, so it never needs WBT.
 */
export function useMerchantChain() {
  const auth = usePactAuth();
  const live = auth.live;
  const network = live?.config.network ?? null;
  const reader = useMemo(
    () =>
      live
        ? createPublicClient({ chain: chainFor(live.config.rpcUrl), transport: http(live.config.rpcUrl) })
        : null,
    [live],
  );
  const merchant = live?.merchant?.address ?? null;
  const customer = live?.customer?.address ?? null;

  const read = useCallback(async (): Promise<MerchantChainState | null> => {
    if (!reader || !network || !merchant) return null;
    const { usdt } = network.contracts;
    const [walletUsdtMinor, customerUsdtMinor] = await Promise.all([
      reader.readContract({ address: usdt, abi: erc20Abi, functionName: 'balanceOf', args: [merchant] }),
      customer
        ? reader.readContract({ address: usdt, abi: erc20Abi, functionName: 'balanceOf', args: [customer] })
        : Promise.resolve(null),
    ]);
    return { walletUsdtMinor, customerUsdtMinor };
  }, [reader, network, merchant, customer]);

  return {
    available: Boolean(live?.merchant && network),
    localFork: live?.config.localFork ?? false,
    faucetUrl: network?.faucetUrl ?? 'https://faucet.testnet.whitechain.io',
    merchant,
    customer,
    read,
    /** Local fork only: test USDT for the merchant wallet or the customer account. */
    async localFaucet(as: 'merchant' | 'customer', amounts: { usdt: string }) {
      const address = as === 'merchant' ? merchant : customer;
      if (!address)
        throw new Error(
          as === 'merchant' ? 'Connect your business wallet first.' : 'Sign in a test customer first.',
        );
      const response = await fetch('/api/dev/faucet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ as, address, ...amounts }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          body.error === 'faucet_limit'
            ? 'That is more than the test faucet gives at once.'
            : 'The test faucet is unavailable.',
        );
      return body as { usdt: string };
    },
  };
}
