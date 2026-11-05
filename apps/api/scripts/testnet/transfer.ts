// Sends testnet WBT or USDT from the deployer, for example to top up the relayer.
//   tsx scripts/testnet/transfer.ts --keys ../../.env.testnet --to relayer --wbt 0.3
//   tsx scripts/testnet/transfer.ts --keys ../../.env.testnet --to 0x… --usdt 2
import { parseArgs } from 'node:util';
import { createPublicClient, createWalletClient, defineChain, formatEther, formatUnits, http, isAddress, parseAbi, parseEther, parseUnits, type Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { USDT } from '../../src/token.js';
import { privateKey, readEnvFile } from './keys.js';

const { values: args } = parseArgs({ options: { keys: { type: 'string' }, to: { type: 'string' }, wbt: { type: 'string' }, usdt: { type: 'string' }, rpc: { type: 'string', default: 'https://rpc.testnet.whitechain.io' } } });
if (!args.keys || !args.to || (!args.wbt === !args.usdt)) throw new Error('usage: --keys <file> --to <relayer|address> (--wbt <n> | --usdt <n>)');
const env = readEnvFile(args.keys);
const deployer = privateKeyToAccount(privateKey(env, 'DEPLOYER_PRIVATE_KEY'));
const to = (args.to === 'relayer' ? privateKeyToAccount(privateKey(env, 'RELAYER_PRIVATE_KEY')).address : args.to) as Address;
if (!isAddress(to)) throw new Error('--to must be "relayer" or an address');
const chain = defineChain({ id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [args.rpc!] } } });
const pub = createPublicClient({ chain, transport: http() });
if (await pub.getChainId() !== 1874) throw new Error('Not chain 1874');
const wallet = createWalletClient({ chain, account: deployer, transport: http() });
const erc20 = parseAbi(['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const gasPrice = await pub.getGasPrice();
const hash = args.wbt
  ? await wallet.sendTransaction({ to, value: parseEther(args.wbt), type: 'legacy', gasPrice })
  : await wallet.writeContract({ address: USDT, abi: erc20, functionName: 'transfer', args: [to, parseUnits(args.usdt!, 6)], type: 'legacy', gasPrice });
const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 2 });
console.info(`${receipt.status}: ${args.wbt ? `${args.wbt} WBT` : `${args.usdt} USDT`} → ${to} (${hash})`);
for (const [name, address] of [['deployer', deployer.address], ['recipient', to]] as const) {
  const [wbt, usdt] = await Promise.all([pub.getBalance({ address }), pub.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [address] })]);
  console.info(`${name.padEnd(9)} ${address}  ${formatEther(wbt)} WBT  ${formatUnits(usdt, 6)} USDT`);
}
