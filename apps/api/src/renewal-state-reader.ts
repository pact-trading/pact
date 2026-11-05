import { createPublicClient, http, keccak256, toFunctionSelector, type Abi, type Address, type Hex } from 'viem';
import { gasTankAbi, routerAbi, subscriptionV2Abi, type Addresses } from './chain.js';
import type { RenewalGrant } from './funded-renewal-store.js';
import type { RenewalSnapshot, RenewalStateReader } from './funded-renewals.js';

export interface RenewalReadPort {
  chainId(): Promise<number>;
  block(number?: bigint): Promise<{ number: bigint; hash: Hex; timestamp: bigint }>;
  code(address: Address, block: bigint): Promise<Hex | undefined>;
  read(address: Address, abi: Abi, name: string, args: readonly unknown[], block: bigint): Promise<unknown>;
}
// The renewal suite only: invoice financing (`receivables`) is not part of renewals.
export type RenewalRuntimeHashes = Record<Exclude<keyof Addresses, 'receivables'> | 'token', Hex>;
const equal = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

/** Read-only adapter. Every eth_call/code read has the SAME explicit block
 * number. A final canonical hash check detects a reorg during the read batch;
 * RPC failures propagate, with no latest-block or nonce fallback. */
export class ViemRenewalStateReader implements RenewalStateReader {
  private readonly addresses: Addresses;
  private readonly hashes: RenewalRuntimeHashes;
  constructor(addresses: Addresses, hashes: RenewalRuntimeHashes, private readonly port: RenewalReadPort) {
    this.addresses = { ...addresses }; this.hashes = { ...hashes };
  }
  static fromRpc(rpc: string, addresses: Addresses, hashes: RenewalRuntimeHashes) {
    const client = createPublicClient({ transport: http(rpc, { retryCount: 0, timeout: 15_000 }), cacheTime: 0 });
    return new ViemRenewalStateReader(addresses, hashes, {
      chainId: () => client.getChainId(),
      async block(number) {
        const block = await client.getBlock(number === undefined ? { blockTag: 'latest' } : { blockNumber: number });
        if (block.number === null || block.hash === null) throw new Error('Unmined renewal snapshot');
        return { number: block.number, hash: block.hash, timestamp: block.timestamp };
      },
      code: (address, blockNumber) => client.getCode({ address, blockNumber }),
      read: (address, abi, functionName, args, blockNumber) => client.readContract({ address, abi, functionName, args, blockNumber }),
    });
  }
  async read(grant: Readonly<RenewalGrant>): Promise<RenewalSnapshot> {
    const a = this.addresses;
    if (await this.port.chainId() !== 1874 || !equal(a.router, grant.router) || !equal(a.subscription, grant.manager)) throw new Error('Renewal reader suite mismatch');
    const head = await this.port.block();
    const { receivables: _financing, ...suite } = a;
    const contracts = { ...suite, token: grant.token };
    await Promise.all(Object.entries(contracts).map(async ([name, address]) => {
      const code = await this.port.code(address, head.number);
      if (!code || code === '0x' || keccak256(code) !== this.hashes[name as keyof RenewalRuntimeHashes]) throw new Error(`Renewal runtime mismatch: ${name}`);
    }));
    const call = (address: Address, abi: Abi, name: string, args: readonly unknown[] = []) => this.port.read(address, abi, name, args, head.number);
    const [state, allowed, token, managerRouter, routerToken, tank, tankRouter, mandateHash] = await Promise.all([
      call(a.subscription, subscriptionV2Abi, 'subscriptions', [grant.chainSubscriptionId]),
      call(a.router, routerAbi, 'allowed', [a.subscription, toFunctionSelector('charge(bytes32,uint256)')]),
      call(a.subscription, subscriptionV2Abi, 'usdt'), call(a.subscription, subscriptionV2Abi, 'router'),
      call(a.router, routerAbi, 'usdt'), call(a.router, routerAbi, 'gasTank'),
      call(a.gasTank, gasTankAbi, 'router'), call(a.subscription, subscriptionV2Abi, 'hashMandate', [grant.mandate]),
    ]);
    if (!equal(token, grant.token) || !equal(routerToken, grant.token) || !equal(managerRouter, a.router) || !equal(tank, a.gasTank) || !equal(tankRouter, a.router) || !equal(mandateHash, grant.mandateHash)) throw new Error('Renewal immutable/domain mismatch');
    if (!Array.isArray(state) || state.length !== 10 || !Array.isArray(allowed) || allowed.length !== 2 || typeof state[9] !== 'boolean' || allowed.some(v => typeof v !== 'boolean')) throw new Error('Malformed renewal state');
    const pinned = await this.port.block(head.number);
    if (pinned.number !== head.number || pinned.hash !== head.hash || pinned.timestamp !== head.timestamp) throw new Error('Renewal snapshot reorganized');
    return { chainId: 1874, manager: a.subscription, router: a.router, token: grant.token, subscriptionId: grant.chainSubscriptionId,
      blockNumber: head.number, blockHash: head.hash, timestamp: head.timestamp,
      subscription: { payer: state[0], merchant: state[1], planId: state[2], amountCap: BigInt(state[3]), periodSeconds: BigInt(state[4]), maxPeriods: Number(state[5]), chargedPeriods: Number(state[6]), endTime: BigInt(state[7]), nextChargeAt: BigInt(state[8]), cancelled: state[9] },
      chargeAllowed: allowed[0], mustReturnTrue: allowed[1] };
  }
}
