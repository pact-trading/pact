import { createPublicClient, http, parseAbi, type Address, type Hex } from 'viem';
import type { PasskeyChain } from './service.js';

const factoryAbi = parseAbi(['function accountAddress(bytes32 x, bytes32 y, uint256 salt) view returns (address)']);

/** Passkey accounts on Whitechain: the factory's counterfactual address, and whether code is there yet. */
export function viemPasskeyChain(rpcUrl: string, factory: Address): PasskeyChain {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }) });
  return {
    accountAddress: (x: Hex, y: Hex, salt: bigint) => client.readContract({ address: factory, abi: factoryAbi, functionName: 'accountAddress', args: [x, y, salt] }),
    isDeployed: async (account: Address) => ((await client.getCode({ address: account })) ?? '0x') !== '0x',
  };
}
