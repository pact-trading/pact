// Local integration capability, NOT production authority. This module can only
// mint a capability by spawning its own pinned loopback Anvil and constructing
// a ViemChain with the fixed public synthetic relayer key below.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, http, keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ViemChain, subscriptionV2Abi, type Addresses } from '../chain.js';
import type { ChainAdapter } from '../types.js';
import type { RenewalGrant } from '../funded-renewal-store.js';
import { ViemRenewalStateReader, type RenewalRuntimeHashes } from '../renewal-state-reader.js';

export const RENEWAL_FORK_BLOCK = 11930519;
const remote = 'https://rpc.testnet.whitechain.io'; // Anvil fork SOURCE: reads only.
export const localRenewalAccounts = Object.freeze({
  payer: privateKeyToAccount(`0x${'91'.repeat(32)}`),
  merchant: privateKeyToAccount(`0x${'93'.repeat(32)}`),
  admin: privateKeyToAccount(`0x${'94'.repeat(32)}`),
});
const relayerKey = `0x${'92'.repeat(32)}` as Hex;
export const localRenewalRelayer = privateKeyToAccount(relayerKey).address;
const token = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7' as Address;
const pinned = {
  router: { address: '0x93666c5fc737d717e87ad73e654633ea7b031f97', hash: '0xf5f5f7c2c73a5d8914401ed264cb818535c129ce7762a5fe22ac34481ff98314' },
  gasTank: { address: '0xfa90521c729d56ca548f24ec77fc403a06ab7624', hash: '0xae093e397c30588ae7dcc906ca83144e229f5c65353be45e3444f2a770cebc65' },
  escrow: { address: '0x47bc86c116929e50fd0822192dd66256b636a7be', hash: '0x4258a88a153f3d9312f6cd673158803fb92ea5762749b700b8144158cca4aa38' },
  token: { address: token, hash: '0x4d9be648c5bf39973670d9f8b481d5d0b971e6a2db2deccc6b98cde21c5dd83e' },
} as const;
// Reviewed SubscriptionManagerV2.sol artifact on 0cb1b73. Compare executable
// bytecode and metadata with ONLY these compiler-declared immutable slots zeroed.
export const V2_NORMALIZED_RUNTIME_HASH = '0xe0cc2c7b2c629388be33bb45f0b8d229a6def9212fc3f6a0987adfbff72407c0';
const immutableSlots = [292, 7501, 7685, 3954, 5248];
export function assertReviewedV2Runtime(code: Hex) {
  let normalized: string = code;
  for (const group of [[292, 7501, 7685], [3954, 5248]]) {
    if (new Set(group.map(offset => code.slice(2 + offset * 2, 2 + offset * 2 + 64))).size !== 1) throw new Error('Inconsistent V2 immutables');
  }
  for (const offset of immutableSlots) {
    const start = 2 + offset * 2, value = code.slice(start, start + 64);
    if (![token, pinned.router.address].some(address => value.toLowerCase() === address.slice(2).toLowerCase().padStart(64, '0'))) throw new Error('Unreviewed V2 immutable');
    normalized = normalized.slice(0, start) + '0'.repeat(64) + normalized.slice(start + 64);
  }
  if (keccak256(normalized as Hex) !== V2_NORMALIZED_RUNTIME_HASH) throw new Error('Unreviewed V2 runtime');
}
export function assertRenewalLoopback(url: string) {
  const u = new URL(url);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || ['3000', '3001', '3002'].includes(u.port) || u.pathname !== '/' || u.username || u.password || u.search || u.hash) throw new Error('Isolated loopback Anvil required');
}
declare const brand: unique symbol;
export interface LocalRenewalCapability { readonly [brand]: true }
interface Attestation { chain: ViemChain; reader: ViemRenewalStateReader; addresses: Addresses; alive(): boolean }
const capabilities = new WeakMap<LocalRenewalCapability, Attestation>();
export function assertLocalRenewalCapability(capability: LocalRenewalCapability | undefined, chain: ChainAdapter, reader: unknown, grant?: RenewalGrant) {
  const entry = capability && capabilities.get(capability);
  if (!entry || entry.chain !== chain || entry.reader !== reader || !entry.alive()) throw new Error('Live renewal unavailable: invalid local-fork capability');
  if (grant && (grant.merchant.toLowerCase() !== localRenewalAccounts.merchant.address.toLowerCase() || grant.mandate.payer.toLowerCase() !== localRenewalAccounts.payer.address.toLowerCase() || grant.router.toLowerCase() !== entry.addresses.router.toLowerCase() || grant.manager.toLowerCase() !== entry.addresses.subscription.toLowerCase() || grant.token.toLowerCase() !== token.toLowerCase())) throw new Error('Local renewal synthetic scope mismatch');
}

export async function spawnRenewalFork() {
  const lease = createServer();
  await new Promise<void>(resolve => lease.listen(0, '127.0.0.1', resolve));
  const port = (lease.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => lease.close(e => e ? reject(e) : resolve()));
  const url = `http://127.0.0.1:${port}`; assertRenewalLoopback(url);
  const child = spawn('anvil', ['--quiet', '--host', '127.0.0.1', '--port', String(port), '--accounts', '0', '--chain-id', '1874', '--hardfork', 'prague', '--fork-url', remote, '--fork-block-number', String(RENEWAL_FORK_BLOCK)], { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  let error = ''; child.stderr.on('data', chunk => { error = (error + String(chunk)).slice(-1000); }); child.on('error', e => { error = e.message; });
  const alive = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null && !child.killed;
  let rpcId = 0;
  async function rpc(method: string, params: unknown[] = []): Promise<any> {
    assertRenewalLoopback(url);
    if (!alive()) throw new Error('Owned Anvil is no longer running');
    const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000), body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    const result = await response.json() as { error?: { message: string }; result: unknown };
    if (result.error) throw new Error(`${method}: ${result.error.message}`);
    return result.result;
  }
  async function close() {
    if (!alive()) return;
    await new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGTERM'); });
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (!alive()) throw new Error(`Anvil startup: ${error}`);
      try { if (/anvil/i.test(await rpc('web3_clientVersion'))) { ready = true; break; } } catch { /* Startup only; no alternate URL. */ }
      await delay(200);
    }
    if (!ready || await rpc('eth_chainId') !== '0x752') throw new Error('Pinned Anvil chain 1874 unavailable');
    const client = createPublicClient({ transport: http(url, { retryCount: 0 }), cacheTime: 0 });
    const forkBlock = await client.getBlock({ blockNumber: BigInt(RENEWAL_FORK_BLOCK) });
    return {
      url, rpc, close, forkBlockHash: forkBlock.hash,
      async createChain(addresses: Addresses) {
        if (!alive()) throw new Error('Owned Anvil is no longer running');
        const block = await client.getBlock({ blockTag: 'latest' });
        const hashes = {} as RenewalRuntimeHashes;
        for (const [key, expected] of Object.entries(pinned)) {
          const address = key === 'token' ? token : addresses[key as Exclude<keyof Addresses, 'receivables'>];
          if (address.toLowerCase() !== expected.address.toLowerCase()) throw new Error('Unreviewed renewal suite address');
          const code = await client.getCode({ address, blockNumber: block.number });
          if (!code || keccak256(code) !== expected.hash) throw new Error(`Unreviewed renewal runtime: ${key}`);
          hashes[key as keyof RenewalRuntimeHashes] = expected.hash;
        }
        const code = await client.getCode({ address: addresses.subscription, blockNumber: block.number });
        if (!code) throw new Error('V2 not deployed on local fork');
        assertReviewedV2Runtime(code); hashes.subscription = keccak256(code);
        const [managerRouter, managerToken] = await Promise.all(['router', 'usdt'].map(functionName => client.readContract({ address: addresses.subscription, abi: subscriptionV2Abi, functionName, blockNumber: block.number })));
        if (String(managerRouter).toLowerCase() !== addresses.router.toLowerCase() || String(managerToken).toLowerCase() !== token.toLowerCase()) throw new Error('V2 immutable binding mismatch');
        const immutableAddresses = Object.freeze({ ...addresses });
        const chain = new ViemChain(url, relayerKey, immutableAddresses, 2);
        const reader = ViemRenewalStateReader.fromRpc(url, immutableAddresses, hashes);
        const capability = Object.freeze({}) as LocalRenewalCapability;
        capabilities.set(capability, { chain, reader, addresses: immutableAddresses, alive });
        return { chain, reader, capability, runtimeHashes: hashes };
      },
    };
  } catch (e) { await close(); throw e; }
}
