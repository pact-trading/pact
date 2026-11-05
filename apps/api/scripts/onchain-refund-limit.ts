// Live Whitechain Sepolia with the prize USDT: charge 1.00, then try to refund 2.00. The contract must refuse the refund.
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, keccak256, toHex, defineChain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
const env = Object.fromEntries(readFileSync(new URL('../../../.env.wallets', import.meta.url), 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const A = { router: '0x014BC0e127D4660a3ef369a9d71a57e727a7D34f', escrow: '0x3D2dA701266ece5098aE7B907DB1A56ca6a434C1' } as const;
const chain = defineChain({ id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [env.WHITECHAIN_RPC!] } } });
const pub = createPublicClient({ chain, transport: http() });
const merchant = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex);
const relayer = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as Hex);
const payer = privateKeyToAccount(env.GASLESS_PAYER_PRIVATE_KEY as Hex);
const wr = createWalletClient({ account: relayer, chain, transport: http() });
const escrowAbi = parseAbi(['function charge(bytes32 id,address merchant,uint256 amount,uint64 refundWindow)', 'function refund(bytes32 id,uint256 amount,bytes32 reason)']);
const routerAbi = parseAbi(['function execute((address signer,address merchant,address target,bytes32 dataHash,uint256 amount,uint256 feeUSDT,uint256 nonce,uint64 deadline,uint32 maxGas) i, bytes data, bytes signature) returns (bool, bytes)', 'event Executed(address indexed signer,address indexed merchant,uint256 nonce,address target,uint256 reimbursement,uint256 feeUSDT)', 'event Refused(address indexed signer,address indexed merchant,uint256 nonce,uint8 reason)']);
const link = (h: string) => `https://explorer.testnet.whitechain.io/tx/${h}`;
async function run(signer: typeof merchant, data: Hex, amount: bigint, nonce: bigint) {
  const intent = { signer: signer.address, merchant: merchant.address, target: A.escrow, dataHash: keccak256(data), amount, feeUSDT: 10_000n, nonce, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), maxGas: 400_000 };
  const signature = await signer.signTypedData({ domain: { name: 'Settle Router', version: '1', chainId: 1874, verifyingContract: A.router }, types: { Intent: [{ name: 'signer', type: 'address' }, { name: 'merchant', type: 'address' }, { name: 'target', type: 'address' }, { name: 'dataHash', type: 'bytes32' }, { name: 'amount', type: 'uint256' }, { name: 'feeUSDT', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' }, { name: 'maxGas', type: 'uint32' }] }, primaryType: 'Intent', message: intent });
  const hash = await wr.writeContract({ address: A.router, abi: routerAbi, functionName: 'execute', args: [intent, data, signature], gas: 900_000n });
  const r = await pub.waitForTransactionReceipt({ hash });
  const executed = r.logs.some(l => l.topics[0] === keccak256(toHex('Executed(address,address,uint256,address,uint256,uint256)')));
  const refused = r.logs.find(l => l.topics[0] === keccak256(toHex('Refused(address,address,uint256,uint8)')));
  return { hash, executed, refused: refused ? parseInt(refused.data.slice(-2), 16) : null };
}
const n = BigInt(Date.now());
const id = keccak256(toHex(`limit-${n}`));
const c = await run(payer, encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [id, merchant.address, 1_000_000n, 2_592_000n] }), 1_000_000n, n);
const over = await run(merchant, encodeFunctionData({ abi: escrowAbi, functionName: 'refund', args: [id, 2_000_000n, keccak256(toHex('too_much'))] }), 2_000_000n, n + 1n);
const ok = await run(merchant, encodeFunctionData({ abi: escrowAbi, functionName: 'refund', args: [id, 1_000_000n, keccak256(toHex('full'))] }), 1_000_000n, n + 2n);
console.log(JSON.stringify({ charge1: { executed: c.executed, tx: link(c.hash) }, refund2OnCapture1: { executed: over.executed, refusalCode: over.refused, tx: link(over.hash) }, refund1: { executed: ok.executed, tx: link(ok.hash) } }, null, 2));
