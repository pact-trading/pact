// Deploys a fresh Pact suite onto a LOCAL Anvil fork of Whitechain Sepolia and writes its runtime config.
// Uses Anvil's well-known development keys. Refuses any RPC that is not a local Anvil node.
//   tsx scripts/live/deploy.ts <rpcUrl> <outFile>
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, getFunctionSelector, http, keccak256, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { USDT } from '../../src/token.js';
import { ALLOWLIST, INITIAL_TERMS, ROUTER_LIMITS, allowFlags, termsTuple } from '../../src/suite.js';
import { readPoolPrice } from '../../src/treasury.js';

const [rpcUrl, outFile] = process.argv.slice(2);
if (!rpcUrl || !outFile) throw new Error('usage: deploy.ts <rpcUrl> <outFile>');
const host = new URL(rpcUrl).hostname;
if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('Local deploy only targets a local Anvil node');

/** Anvil's public development accounts 0 and 1. Never use these on a real network. */
export const LOCAL_KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  relayer: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
} as const satisfies Record<string, Hex>;

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const artifact = (name: string) => {
  const json = JSON.parse(readFileSync(`${root}/contracts/out/${name}.sol/${name}.json`, 'utf8'));
  return { abi: json.abi as Abi, bytecode: json.bytecode.object as Hex };
};
const chain = defineChain({ id: 1874, name: 'Whitechain Sepolia (local fork)', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const pub = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 250 });
const rpc = (method: string, params: unknown[]) => pub.request({ method: method as never, params: params as never });

const clientVersion = String(await rpc('web3_clientVersion', []));
if (!clientVersion.toLowerCase().includes('anvil')) throw new Error(`Not an Anvil node: ${clientVersion}`);
if (await pub.getChainId() !== 1874) throw new Error('The fork must keep chain id 1874');

const deployer = privateKeyToAccount(LOCAL_KEYS.deployer);
const relayer = privateKeyToAccount(LOCAL_KEYS.relayer);
// Only Pact's own accounts hold WBT: merchants, customers and investors only sign.
for (const account of [deployer, relayer]) await rpc('anvil_setBalance', [account.address, '0x3635C9ADC5DEA00000']); // 1000 WBT

const wallet = createWalletClient({ chain, account: deployer, transport: http(rpcUrl) });
const wait = async (hash: Hex) => {
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== 'success') throw new Error(`Transaction failed: ${hash}`);
  return receipt;
};
const deploy = async (name: string, args: unknown[] = []) => {
  const { abi, bytecode } = artifact(name);
  const receipt = await wait(await wallet.deployContract({ abi, bytecode, args, gas: 10_000_000n }));
  console.info(`deployed ${name} at ${receipt.contractAddress}`);
  return { address: receipt.contractAddress as Address, abi, block: receipt.blockNumber };
};
const write = async (address: Address, abi: Abi, functionName: string, args: unknown[]) =>
  wait(await wallet.writeContract({ address, abi, functionName, args, gas: 1_000_000n }));
const selector = (abi: Abi, name: string) => getFunctionSelector(abi.find(item => item.type === 'function' && item.name === name) as never);

// The FeeSchedule starts at the pool's WBT price; the relayer's treasury job keeps it current.
const usdtPerWbt = await readPoolPrice(pub);
// The relayer receives every fee until a fee vault exists, and keeps the WBT price.
const fees = await deploy('FeeSchedule', [relayer.address, relayer.address, usdtPerWbt, termsTuple(INITIAL_TERMS)]);
const router = await deploy('Router', [USDT, fees.address]);
const escrow = await deploy('PaymentEscrow', [USDT, router.address, fees.address]);
const subscription = await deploy('SubscriptionManagerV2', [USDT, router.address, relayer.address, fees.address]);
const targets = { escrow, subscription } as const;
for (const entry of ALLOWLIST) {
  if (entry.contract === 'receivables') continue; // Added with the receivables contract.
  const target = targets[entry.contract];
  await write(router.address, router.abi, 'setAllowed', [target.address, selector(target.abi, entry.fn), ...allowFlags(entry)]);
}
await write(router.address, router.abi, 'setLimits', [ROUTER_LIMITS.minAmount, ROUTER_LIMITS.maxPayerCallsPerDay, ROUTER_LIMITS.maxGasPerCall, ROUTER_LIMITS.maxGasPrice]);

// x402: the canonical upto proxy (official CREATE2 initcode, when the fork lacks it) and the agent account factory.
const reference = JSON.parse(readFileSync(`${root}/docs/x402/whitechain-readonly.json`, 'utf8'));
const UPTO = reference.uptoDeployment.expectedAddress as Address;
if (!(await pub.getCode({ address: UPTO }))) {
  await wait(await wallet.sendTransaction({ to: reference.uptoDeployment.to as Address, data: reference.uptoDeployment.data as Hex, gas: 3_000_000n }));
  console.info(`deployed canonical upto at ${UPTO}`);
}
const factory = await deploy('X402AccountFactory');
// Trusted runtime hashes come from the pinned reference, never from the RPC being checked.
const runtimeHashes: Record<string, Hex> = Object.fromEntries(Object.entries(reference.runtimes as Record<string, { hash: Hex }>).filter(([, v]) => v?.hash).map(([k, v]) => [k, v.hash]));
runtimeHashes[UPTO] = reference.uptoDeployment.expectedRuntimeHash;
for (const [address, hash] of Object.entries(runtimeHashes)) {
  const code = await pub.getCode({ address: address as Address });
  if (!code || keccak256(code) !== hash) throw new Error(`x402 runtime mismatch at ${address}`);
}

const deployment = {
  chainId: 1874,
  rpcUrl,
  deployedAt: new Date().toISOString(),
  deploymentBlock: fees.block.toString(),
  keys: LOCAL_KEYS,
  accounts: { deployer: deployer.address, relayer: relayer.address, feeRecipient: relayer.address },
  contracts: { fees: fees.address, router: router.address, escrow: escrow.address, subscription: subscription.address, usdt: USDT },
  feeTerms: { version: 1, ...termsTuple(INITIAL_TERMS) },
  usdtPerWbt: usdtPerWbt.toString(),
  x402: { factory: factory.address, runtimeHashes },
};
writeFileSync(outFile, `${JSON.stringify(deployment, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2)}\n`, { mode: 0o600 });
console.info(`wrote ${outFile}`);
