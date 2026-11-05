'use client';

import { useCallback, useMemo } from 'react';
import { createPublicClient, http, maxUint256, parseAbi, type Address, type Hash } from 'viem';
import { usePactAuth } from '@/components/auth/auth-context';
import { chainFor } from '@/lib/live-wallet';

const gasTankAbi = parseAbi([
  'function deposit(address merchant) payable',
  'function setDailyCap(uint256 cap)',
  'function withdraw(uint256 amount)',
  'function balanceOf(address) view returns (uint256)',
  'function dailyCap(address) view returns (uint256)',
]);
const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
]);
const swapRouterAbi = parseAbi([
  'struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }',
  'function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)',
]);

export interface MerchantChainState {
  walletWei: bigint;
  walletUsdtMinor: bigint;
  tankWei: bigint;
  dailyCapWei: bigint;
  routerAllowance: bigint;
  escrowAllowance: bigint;
  customerUsdtMinor: bigint | null;
}

/**
 * The merchant's own transactions, sent from the connected wallet: gas tank deposit and daily cap,
 * USDT approvals for fees (Router) and refunds (escrow), and a WBT→USDT swap paid to a recipient.
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
    if (!reader || !network || !merchant || !network.contracts.gasTank) return null;
    const { gasTank, usdt, router, escrow } = network.contracts;
    const [
      walletWei,
      walletUsdtMinor,
      tankWei,
      dailyCapWei,
      routerAllowance,
      escrowAllowance,
      customerUsdtMinor,
    ] = await Promise.all([
      reader.getBalance({ address: merchant }),
      reader.readContract({ address: usdt, abi: erc20Abi, functionName: 'balanceOf', args: [merchant] }),
      reader.readContract({ address: gasTank, abi: gasTankAbi, functionName: 'balanceOf', args: [merchant] }),
      reader.readContract({ address: gasTank, abi: gasTankAbi, functionName: 'dailyCap', args: [merchant] }),
      reader.readContract({
        address: usdt,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [merchant, router],
      }),
      reader.readContract({
        address: usdt,
        abi: erc20Abi,
        functionName: 'allowance',
        args: [merchant, escrow],
      }),
      customer
        ? reader.readContract({ address: usdt, abi: erc20Abi, functionName: 'balanceOf', args: [customer] })
        : Promise.resolve(null),
    ]);
    return {
      walletWei,
      walletUsdtMinor,
      tankWei,
      dailyCapWei,
      routerAllowance,
      escrowAllowance,
      customerUsdtMinor,
    };
  }, [reader, network, merchant, customer]);

  const send = useCallback(
    async (
      write: (client: Awaited<ReturnType<NonNullable<typeof live>['merchantWallet']>>) => Promise<Hash>,
    ) => {
      if (!live || !reader) throw new Error('Connect your business wallet first.');
      const client = await live.merchantWallet();
      const hash = await write(client);
      const receipt = await reader.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== 'success') throw new Error('The transaction failed on chain.');
      return hash;
    },
    [live, reader],
  );
  const contracts = () => {
    if (!network?.contracts.gasTank) throw new Error('The API did not return contract addresses.');
    return { ...network.contracts, gasTank: network.contracts.gasTank };
  };

  return {
    available: Boolean(live?.merchant && network?.contracts.gasTank),
    localFork: live?.config.localFork ?? false,
    faucetUrl: network?.faucetUrl ?? 'https://faucet.testnet.whitechain.io',
    merchant,
    customer,
    read,
    deposit: (wei: bigint) =>
      send(c =>
        c.writeContract({
          account: c.account!,
          chain: c.chain,
          address: contracts().gasTank,
          abi: gasTankAbi,
          functionName: 'deposit',
          args: [merchant!],
          value: wei,
        }),
      ),
    setDailyCap: (wei: bigint) =>
      send(c =>
        c.writeContract({
          account: c.account!,
          chain: c.chain,
          address: contracts().gasTank,
          abi: gasTankAbi,
          functionName: 'setDailyCap',
          args: [wei],
        }),
      ),
    withdraw: (wei: bigint) =>
      send(c =>
        c.writeContract({
          account: c.account!,
          chain: c.chain,
          address: contracts().gasTank,
          abi: gasTankAbi,
          functionName: 'withdraw',
          args: [wei],
        }),
      ),
    /** Fees go to the Router and refunds come from the escrow, so both pull USDT from the merchant. */
    approveUsdt: (spender: 'router' | 'escrow', amount: bigint = maxUint256) =>
      send(c =>
        c.writeContract({
          account: c.account!,
          chain: c.chain,
          address: contracts().usdt,
          abi: erc20Abi,
          functionName: 'approve',
          args: [contracts()[spender] as Address, amount],
        }),
      ),
    /** Swaps WBT for USDT on the testnet DEX, paid straight to the recipient (e.g. the test customer). */
    swapToUsdt: (recipient: Address, wei: bigint) =>
      send(c =>
        c.writeContract({
          account: c.account!,
          chain: c.chain,
          address: network!.dex.swapRouter,
          abi: swapRouterAbi,
          functionName: 'exactInputSingle',
          args: [
            {
              tokenIn: network!.dex.wrappedNative,
              tokenOut: contracts().usdt,
              fee: network!.dex.fee,
              recipient,
              amountIn: wei,
              amountOutMinimum: 0n,
              sqrtPriceLimitX96: 0n,
            },
          ],
          value: wei,
        }),
      ),
    /** Local fork only: test funds for the merchant wallet or the customer account. */
    async localFaucet(as: 'merchant' | 'customer', amounts: { wbt?: string; usdt?: string }) {
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
      return body as { wbt: string; usdt: string };
    },
  };
}
