import type { Abi, Address } from 'viem';

type ContractRead = { address: Address; abi: Abi; functionName: string; args?: readonly unknown[] };
/**
 * Contract reads at one block. A real client sends them as one Multicall3 `aggregate3` eth_call; only
 * these audited views use it (their results do not depend on the caller). Clients without `multicall`
 * (test doubles) read one by one.
 */
export async function readAll(client: { multicall?: unknown; readContract: (args: never) => Promise<unknown> }, calls: ContractRead[], blockNumber: bigint): Promise<unknown[]> {
  if (typeof client.multicall === 'function' && process.env.RPC_MULTICALL !== '0')
    return (client.multicall as (args: unknown) => Promise<unknown[]>)({ contracts: calls, blockNumber, allowFailure: false });
  return Promise.all(calls.map(call => client.readContract({ ...call, blockNumber } as never)));
}
