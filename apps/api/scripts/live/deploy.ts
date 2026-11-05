// Deploys a fresh Pact suite onto a LOCAL Anvil fork of Whitechain Sepolia and writes its runtime config.
// Uses Anvil's well-known development keys. Refuses any RPC that is not a local Anvil node.
//   tsx scripts/live/deploy.ts <rpcUrl> <outFile>
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, getFunctionSelector, http, keccak256, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { APPROVER, USDT } from '../../src/approval.js';

const [rpcUrl, outFile] = process.argv.slice(2);
if (!rpcUrl || !outFile) throw new Error('usage: deploy.ts <rpcUrl> <outFile>');
const host = new URL(rpcUrl).hostname;
if (!['127.0.0.1', 'localhost'].includes(host)) throw new Error('Local deploy only targets a local Anvil node');

/** Anvil's public development accounts 0, 1 and 2. Never use these on a real network. */
export const LOCAL_KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  relayer: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  feeVault: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9ad75e9df0b77',
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
const feeVault = privateKeyToAccount(LOCAL_KEYS.feeVault);
for (const account of [deployer, relayer, feeVault]) await rpc('anvil_setBalance', [account.address, '0x3635C9ADC5DEA00000']); // 1000 WBT

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

const tank = await deploy('GasTank');
const router = await deploy('Router', [USDT, tank.address, feeVault.address]);
await write(tank.address, tank.abi, 'setRouter', [router.address]);
const escrow = await deploy('PaymentEscrow', [USDT, router.address]);
const subscription = await deploy('SubscriptionManager', [USDT, router.address, relayer.address]);
for (const name of ['authorize', 'capture', 'charge', 'void', 'reclaim', 'refund'])
  await write(router.address, router.abi, 'setAllowed', [escrow.address, selector(escrow.abi, name), true, false]);
for (const name of ['subscribe', 'charge', 'cancel', 'replace'])
  await write(router.address, router.abi, 'setAllowed', [subscription.address, selector(subscription.abi, name), true, name === 'charge']);
// Same limits as the deployed suite, except a higher per-payer daily count so one tester can try every flow.
await write(router.address, router.abi, 'setLimits', [1_000_000n, 1_000_000n, 40, 1_000_000, 100_000_000_000n]);

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

const approverCode = await pub.getCode({ address: APPROVER });
if (!approverCode || approverCode === '0x') throw new Error('SponsoredApprover is missing on the fork');

const deployment = {
  chainId: 1874,
  rpcUrl,
  deployedAt: new Date().toISOString(),
  deploymentBlock: tank.block.toString(),
  keys: LOCAL_KEYS,
  accounts: { deployer: deployer.address, relayer: relayer.address, feeVault: feeVault.address },
  contracts: { gasTank: tank.address, router: router.address, escrow: escrow.address, subscription: subscription.address, usdt: USDT, sponsoredApprover: APPROVER },
  sponsoredApproverRuntimeHash: keccak256(approverCode),
  x402: { factory: factory.address, runtimeHashes },
};
writeFileSync(outFile, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o600 });
console.info(`wrote ${outFile}`);
