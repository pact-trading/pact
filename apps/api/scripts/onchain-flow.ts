// Live Whitechain Sepolia run. Default: test deployment with a self-issued token. USE_PRIZE_USDT=1: original contracts and the prize USDT (wallets must already hold USDT).
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, keccak256, toHex, parseEther, defineChain, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { readFileSync, appendFileSync } from 'node:fs';

const envFile = new URL('../../../.env.wallets', import.meta.url);
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
let payerKey = env.PAYER_PRIVATE_KEY as Hex | undefined;
if (!payerKey) { payerKey = generatePrivateKey(); appendFileSync(envFile, `PAYER_PRIVATE_KEY=${payerKey}\n`); }
const PRIZE = process.env.USE_PRIZE_USDT === '1';
const A: Record<string, Hex> = (PRIZE
  ? { token: '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7', tank: '0xd9e61f3Ed690A1c17E7b0AA85743c73FB4fD2A1C', router: '0x014BC0e127D4660a3ef369a9d71a57e727a7D34f', escrow: '0x3D2dA701266ece5098aE7B907DB1A56ca6a434C1' }
  : { token: '0x92A7AE8BD75312594f31165bd87DfbfBaC58997D', tank: '0x5a2BeF3bef1F082ed575a558929781c395Bd75e7', router: '0x60691AA1CE5c1e1232E1D4C5E1af1fed4f522204', escrow: '0x4f87200B42f7531A16A74593AC72C0b225791A03' });
const chain = defineChain({ id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [env.WHITECHAIN_RPC!] } } });
const pub = createPublicClient({ chain, transport: http() });
const merchant = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex);
const relayer = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as Hex);
const payer = privateKeyToAccount(payerKey);
const w = (account: typeof merchant) => createWalletClient({ account, chain, transport: http() });
const erc = parseAbi(['function transfer(address,uint256) returns (bool)', 'function mint(address,uint256)', 'function approve(address,uint256)', 'function balanceOf(address) view returns (uint256)']);
const tankAbi = parseAbi(['function deposit(address) payable', 'function setDailyCap(uint256)']);
const escrowAbi = parseAbi(['function charge(bytes32 id,address merchant,uint256 amount,uint64 refundWindow)', 'function refund(bytes32 id,uint256 amount,bytes32 reason)']);
const routerAbi = parseAbi(['function execute((address signer,address merchant,address target,bytes32 dataHash,uint256 amount,uint256 feeUSDT,uint256 nonce,uint64 deadline,uint32 maxGas) i, bytes data, bytes signature) returns (bool, bytes)', 'event Executed(address indexed signer,address indexed merchant,uint256 nonce,address target,uint256 reimbursement,uint256 feeUSDT)', 'event Refused(address indexed signer,address indexed merchant,uint256 nonce,uint8 reason)']);
const send = async (account: typeof merchant, to: Hex, data?: Hex, value = 0n) => { const hash = await w(account).sendTransaction({ to, data, value }); const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error(`tx failed ${hash}`); return hash; };
const link = (h: string) => `https://explorer.testnet.whitechain.io/tx/${h}`;
const out: Record<string, string> = {};

async function intentTx(signer: typeof merchant, target: Hex, data: Hex, amount: bigint, fee: bigint, nonce: bigint) {
  const intent = { signer: signer.address, merchant: merchant.address, target, dataHash: keccak256(data), amount, feeUSDT: fee, nonce, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), maxGas: 400_000 };
  const signature = await signer.signTypedData({ domain: { name: 'Settle Router', version: '1', chainId: 1874, verifyingContract: A.router }, types: { Intent: [{ name: 'signer', type: 'address' }, { name: 'merchant', type: 'address' }, { name: 'target', type: 'address' }, { name: 'dataHash', type: 'bytes32' }, { name: 'amount', type: 'uint256' }, { name: 'feeUSDT', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' }, { name: 'maxGas', type: 'uint32' }] }, primaryType: 'Intent', message: intent });
  const hash = await w(relayer).writeContract({ address: A.router, abi: routerAbi, functionName: 'execute', args: [intent, data, signature], gas: 900_000n });
  const r = await pub.waitForTransactionReceipt({ hash });
  const executed = r.logs.some(l => l.address.toLowerCase() === A.router.toLowerCase() && l.topics[0] === keccak256(toHex('Executed(address,address,uint256,address,uint256,uint256)')));
  return { hash, executed };
}

const nonce = BigInt(Date.now());
if ((await pub.getBalance({ address: payer.address })) < parseEther('0.004')) out.fundPayer = link(await send(relayer, payer.address, undefined, parseEther('0.01')));
if (PRIZE) out.fundPayerUsdt = link(await send(merchant, A.token, encodeFunctionData({ abi: erc, functionName: 'transfer', args: [payer.address, 4_000_000n] })));
if (!PRIZE) out.mintPayer = link(await send(merchant, A.token, encodeFunctionData({ abi: erc, functionName: 'mint', args: [payer.address, 500_000_000n] })));
if (!PRIZE) out.mintMerchant = link(await send(merchant, A.token, encodeFunctionData({ abi: erc, functionName: 'mint', args: [merchant.address, 500_000_000n] })));
out.payerApproveEscrow = link(await send(payer, A.token, encodeFunctionData({ abi: erc, functionName: 'approve', args: [A.escrow, 2n ** 255n] })));
out.merchantApproveEscrow = link(await send(merchant, A.token, encodeFunctionData({ abi: erc, functionName: 'approve', args: [A.escrow, 2n ** 255n] })));
out.merchantApproveRouter = link(await send(merchant, A.token, encodeFunctionData({ abi: erc, functionName: 'approve', args: [A.router, 2n ** 255n] })));
out.tankDeposit = link(await send(merchant, A.tank, encodeFunctionData({ abi: tankAbi, functionName: 'deposit', args: [merchant.address] }), parseEther('0.05')));
out.tankCap = link(await send(merchant, A.tank, encodeFunctionData({ abi: tankAbi, functionName: 'setDailyCap', args: [parseEther('0.05')] })));

const paymentId = keccak256(toHex(`pay-${nonce}`));
const charge = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [paymentId, merchant.address, (PRIZE ? 3_000_000n : 125_000_000n), 2_592_000n] });
const c = await intentTx(payer, A.escrow, charge, (PRIZE ? 3_000_000n : 125_000_000n), (PRIZE ? 10_000n : 500_000n), nonce);
out.chargeExecuted = String(c.executed); out.charge = link(c.hash);
const refund = encodeFunctionData({ abi: escrowAbi, functionName: 'refund', args: [paymentId, (PRIZE ? 1_000_000n : 25_000_000n), keccak256(toHex('customer_request'))] });
const r1 = await intentTx(merchant, A.escrow, refund, (PRIZE ? 1_000_000n : 25_000_000n), (PRIZE ? 10_000n : 500_000n), nonce + 1n);
out.partialRefundExecuted = String(r1.executed); out.partialRefund = link(r1.hash);
const bal = await pub.readContract({ address: A.token, abi: erc, functionName: 'balanceOf', args: [payer.address] });
out.payerBalanceAfter = String(bal);
console.log(JSON.stringify(out, null, 2));
