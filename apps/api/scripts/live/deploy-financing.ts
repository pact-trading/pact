// Adds invoice financing (InvestorRegistry and InvoiceReceivables) to an existing suite on a LOCAL Anvil
// fork, and records it in the suite's deployment file. Nothing else is redeployed: the Router gains one
// allowlist entry, InvoiceReceivables.pay, so customers pay financed invoices through it as usual.
//   tsx scripts/live/deploy-financing.ts <rpcUrl> <deploymentFile>
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, defineChain, getFunctionSelector, http, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FINANCING_TERMS, receivablesConfig } from '../../src/financing/terms.js';

const [rpcUrl, deploymentFile] = process.argv.slice(2);
if (!rpcUrl || !deploymentFile) throw new Error('usage: deploy-financing.ts <rpcUrl> <deploymentFile>');
if (!['127.0.0.1', 'localhost'].includes(new URL(rpcUrl).hostname)) throw new Error('Local deploy only targets a local Anvil node');

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const artifact = (name: string) => {
  const json = JSON.parse(readFileSync(`${root}/contracts/out/${name}.sol/${name}.json`, 'utf8'));
  return { abi: json.abi as Abi, bytecode: json.bytecode.object as Hex };
};
const deployment = JSON.parse(readFileSync(deploymentFile, 'utf8'));
if (deployment.financing) {
  console.info('financing already deployed');
  process.exit(0);
}
const chain = defineChain({ id: 1874, name: 'Whitechain Sepolia (local fork)', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const pub = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval: 250 });
if (!String(await pub.request({ method: 'web3_clientVersion' as never })).toLowerCase().includes('anvil')) throw new Error('Not an Anvil node');
if (await pub.getChainId() !== 1874) throw new Error('The fork must keep chain id 1874');

const deployer = privateKeyToAccount(deployment.keys.deployer as Hex);
const wallet = createWalletClient({ chain, account: deployer, transport: http(rpcUrl) });
const wait = async (hash: Hex) => {
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
  if (receipt.status !== 'success') throw new Error(`Transaction failed: ${hash}`);
  return receipt;
};
const router = artifact('Router');
const routerAddress = deployment.contracts.router as Address;
const owner = await pub.readContract({ address: routerAddress, abi: router.abi, functionName: 'owner' }) as Address;
if (owner.toLowerCase() !== deployer.address.toLowerCase()) throw new Error('The deployment key does not own the Router');
const feeVault = await pub.readContract({ address: routerAddress, abi: router.abi, functionName: 'feeVault' }) as Address;

const registry = artifact('InvestorRegistry');
const registryReceipt = await wait(await wallet.deployContract({ abi: registry.abi, bytecode: registry.bytecode, args: [deployer.address], gas: 3_000_000n }));
const receivables = artifact('InvoiceReceivables');
const config = receivablesConfig({ usdt: deployment.contracts.usdt, router: routerAddress, registry: registryReceipt.contractAddress!, feeVault });
const receivablesReceipt = await wait(await wallet.deployContract({ abi: receivables.abi, bytecode: receivables.bytecode, args: [config], gas: 8_000_000n }));
const pay = getFunctionSelector(receivables.abi.find(item => item.type === 'function' && item.name === 'pay') as never);
await wait(await wallet.writeContract({ address: routerAddress, abi: router.abi, functionName: 'setAllowed', args: [receivablesReceipt.contractAddress!, pay, true, false], gas: 200_000n }));
console.info(`deployed InvestorRegistry at ${registryReceipt.contractAddress}, InvoiceReceivables at ${receivablesReceipt.contractAddress}`);

deployment.financing = {
  registry: registryReceipt.contractAddress,
  receivables: receivablesReceipt.contractAddress,
  deploymentBlock: registryReceipt.blockNumber.toString(),
  registryOwner: deployer.address,
  feeVault,
  terms: { ...FINANCING_TERMS, minShareMinor: FINANCING_TERMS.minShareMinor.toString() },
};
writeFileSync(deploymentFile, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o600 });
console.info(`updated ${deploymentFile}`);
