// Live Whitechain Sepolia: a payer with ZERO WBT approves USDT-style token spending and pays, relayer pays all gas.
// Uses EIP-7702: the payer's address delegates to SponsoredApprover, the payer signs only messages.
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, keccak256, toHex, encodeAbiParameters, hashMessage, defineChain, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { readFileSync, appendFileSync } from 'node:fs';

const envFile = new URL('../../../.env.wallets', import.meta.url);
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
let key = env.GASLESS_PAYER_PRIVATE_KEY as Hex | undefined;
if (!key) { key = generatePrivateKey(); appendFileSync(envFile, `GASLESS_PAYER_PRIVATE_KEY=${key}\n`); }
const PRIZE = process.env.USE_PRIZE_USDT === '1';
const A: Record<string, Hex> = (PRIZE
  ? { token: '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7', router: '0x014BC0e127D4660a3ef369a9d71a57e727a7D34f', escrow: '0x3D2dA701266ece5098aE7B907DB1A56ca6a434C1', delegate: '0x3CEc4a4Eff3c1ef0F8F8e1a4f20F98c2c2baBC3f' }
  : { token: '0x92A7AE8BD75312594f31165bd87DfbfBaC58997D', router: '0x60691AA1CE5c1e1232E1D4C5E1af1fed4f522204', escrow: '0x4f87200B42f7531A16A74593AC72C0b225791A03', delegate: '0x3CEc4a4Eff3c1ef0F8F8e1a4f20F98c2c2baBC3f' });
const chain = defineChain({ id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [env.WHITECHAIN_RPC!] } } });
const pub = createPublicClient({ chain, transport: http() });
const merchant = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex);
const relayer = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as Hex);
const payer = privateKeyToAccount(key);
const wr = createWalletClient({ account: relayer, chain, transport: http() });
const wm = createWalletClient({ account: merchant, chain, transport: http() });
const link = (h: string) => `https://explorer.testnet.whitechain.io/tx/${h}`;
const out: Record<string, string> = { payer: payer.address, payerWbtBefore: String(await pub.getBalance({ address: payer.address })) };
const erc = parseAbi(['function transfer(address,uint256) returns (bool)', 'function mint(address,uint256)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)']);
const approver = parseAbi(['function approveFor(address token,address spender,uint256 amount,uint256 deadline,bytes signature)', 'function approvalNonce() view returns (uint256)']);
const escrowAbi = parseAbi(['function charge(bytes32 id,address merchant,uint256 amount,uint64 refundWindow)']);
const routerAbi = parseAbi(['function execute((address signer,address merchant,address target,bytes32 dataHash,uint256 amount,uint256 feeUSDT,uint256 nonce,uint64 deadline,uint32 maxGas) i, bytes data, bytes signature) returns (bool, bytes)', 'event Executed(address indexed signer,address indexed merchant,uint256 nonce,address target,uint256 reimbursement,uint256 feeUSDT)']);

// 1. fund the payer with tokens only (no WBT)
let h: Hex = '0x';
if (PRIZE) { h = await wm.writeContract({ address: A.token, abi: erc, functionName: 'transfer', args: [payer.address, 2_000_000n] }); await pub.waitForTransactionReceipt({ hash: h }); out.fundPayerUsdt = link(h); }
if (!PRIZE) { h = await wm.writeContract({ address: A.token, abi: erc, functionName: 'mint', args: [payer.address, 200_000_000n] }); await pub.waitForTransactionReceipt({ hash: h }); out.mintTokens = link(h); }

// 2. payer signs the delegation and the approval message; relayer sends the type 4 transaction
const authorization = await createWalletClient({ account: payer, chain, transport: http() }).signAuthorization({ contractAddress: A.delegate });
const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
const amount = 2n ** 255n;
const approvalNonce = await pub.readContract({ address: payer.address, abi: approver, functionName: 'approvalNonce' }).catch(() => 0n);
const inner = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1874n, payer.address, A.token, A.escrow, amount, approvalNonce, deadline]));
const signature = await payer.signMessage({ message: { raw: inner } });
h = await wr.sendTransaction({ to: payer.address, data: encodeFunctionData({ abi: approver, functionName: 'approveFor', args: [A.token, A.escrow, amount, deadline, signature] }), authorizationList: [authorization], gas: 300_000n });
const rc = await pub.waitForTransactionReceipt({ hash: h }); out.sponsoredApprove = link(h); out.approveStatus = rc.status;
out.allowanceAfter = String(await pub.readContract({ address: A.token, abi: erc, functionName: 'allowance', args: [payer.address, A.escrow] }));
out.payerWbtAfterApprove = String(await pub.getBalance({ address: payer.address }));

// 3. gasless payment through the Router
const nonce = BigInt(Date.now());
const id = keccak256(toHex(`gasless-${nonce}`));
const data = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [id, merchant.address, (PRIZE ? 1_000_000n : 49_000_000n), 2_592_000n] });
const intent = { signer: payer.address, merchant: merchant.address, target: A.escrow, dataHash: keccak256(data), amount: (PRIZE ? 1_000_000n : 49_000_000n), feeUSDT: (PRIZE ? 10_000n : 250_000n), nonce, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), maxGas: 400_000 };
const sig = await payer.signTypedData({ domain: { name: 'Settle Router', version: '1', chainId: 1874, verifyingContract: A.router }, types: { Intent: [{ name: 'signer', type: 'address' }, { name: 'merchant', type: 'address' }, { name: 'target', type: 'address' }, { name: 'dataHash', type: 'bytes32' }, { name: 'amount', type: 'uint256' }, { name: 'feeUSDT', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' }, { name: 'maxGas', type: 'uint32' }] }, primaryType: 'Intent', message: intent });
h = await wr.writeContract({ address: A.router, abi: routerAbi, functionName: 'execute', args: [intent, data, sig], gas: 900_000n });
const r2 = await pub.waitForTransactionReceipt({ hash: h });
out.charge = link(h); out.chargeExecuted = String(r2.logs.some(l => l.topics[0] === keccak256(toHex('Executed(address,address,uint256,address,uint256,uint256)'))));
out.payerTokensAfter = String(await pub.readContract({ address: A.token, abi: erc, functionName: 'balanceOf', args: [payer.address] }));
out.payerWbtFinal = String(await pub.getBalance({ address: payer.address }));
console.log(JSON.stringify(out, null, 2));
