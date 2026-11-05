// Bounded activation of the verified new suite. Read-only unless ACTIVATE_EXECUTE=1.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createPublicClient, createWalletClient, defineChain, encodeAbiParameters, formatEther, hashMessage, http, keccak256, parseAbi, type Abi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gasTankAbi, routerAbi, escrowAbi, subscriptionAbi } from '../src/chain.js';

const deployment = JSON.parse(readFileSync(new URL('../../../contracts/deployment.json', import.meta.url), 'utf8'));
assert.equal(deployment.status, 'verified_deployed_not_activated');
const env = parseEnv(readFileSync(new URL('../../../.env.wallets', import.meta.url), 'utf8'));
const merchant = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex);
const payer = privateKeyToAccount(env.GASLESS_PAYER_PRIVATE_KEY as Hex);
const relayer = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as Hex);
assert.equal(merchant.address.toLowerCase(), deployment.deployer.toLowerCase());
const A = deployment.contracts as Record<string, Address>;
const token = deployment.token as Address;
const chain = defineChain({ id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.whitechain.io'] } }, testnet: true });
const pub = createPublicClient({ chain, transport: http() });
const erc = parseAbi(['function decimals() view returns(uint8)', 'function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)', 'function approve(address,uint256)']);
const approver = parseAbi(['function approvalNonce() view returns(uint256)', 'function approvalHash(address,address,uint256,uint256,uint256) view returns(bytes32)', 'function approveFor(address,address,uint256,uint256,bytes)']);
const delegate = '0x3CEc4a4Eff3c1ef0F8F8e1a4f20F98c2c2baBC3f';
assert.equal((await pub.getCode({ address: payer.address }))?.toLowerCase(), `0xef0100${delegate.slice(2).toLowerCase()}`, 'Existing gasless payer delegation differs');
assert.equal(await pub.getBalance({ address: payer.address }), 0n);
assert.equal(relayer.address.toLowerCase(), deployment.keeper.toLowerCase());
const read = (address: Address, abi: Abi, functionName: string, args: unknown[] = []) => pub.readContract({ address, abi, functionName, args });
const eqAddress = (actual: unknown, expected: Address) => assert.equal(String(actual).toLowerCase(), expected.toLowerCase());
assert.equal(await pub.getChainId(), 1874);
assert.equal(await read(token, erc, 'decimals'), 6);
for (const [name, abi] of [['Router', routerAbi], ['PaymentEscrow', escrowAbi], ['SubscriptionManager', subscriptionAbi]] as const) {
  eqAddress(await read(A[name], abi, 'usdt'), token);
  if (name !== 'Router') eqAddress(await read(A[name], abi, 'router'), A.Router);
}
eqAddress(await read(A.Router, routerAbi, 'owner'), merchant.address);
eqAddress(await read(A.Router, routerAbi, 'gasTank'), A.GasTank);
eqAddress(await read(A.GasTank, gasTankAbi, 'router'), A.Router);
assert.equal(await read(A.Router, routerAbi, 'minAmount'), 1_000_000n);
const tokenBalance = async (owner: Address) => await read(token, erc, 'balanceOf', [owner]) as bigint;
assert(await tokenBalance(payer.address) >= 2_000_000n, 'Existing payer needs 2 USDT for the smoke charge');
assert(await tokenBalance(merchant.address) >= 1_020_000n, 'Merchant needs refund and fee liquidity');

type Operation = { label: string; account: typeof merchant; address: Address; abi: Abi; functionName: string; args: unknown[]; value: bigint; gas: bigint };
const operations: Operation[] = [];
const tankTarget = 20_000_000_000_000_000n;
const dailyCap = 50_000_000_000_000_000n;
const balance = await read(A.GasTank, gasTankAbi, 'balanceOf', [merchant.address]) as bigint;
const currentCap = await read(A.GasTank, gasTankAbi, 'dailyCap', [merchant.address]) as bigint;
assert(currentCap === 0n || currentCap === dailyCap, 'Unexpected merchant cap; do not overwrite external settings');
if (balance < tankTarget) operations.push({ label: 'fund-new-tank', account: merchant, address: A.GasTank, abi: gasTankAbi, functionName: 'deposit', args: [merchant.address], value: tankTarget - balance, gas: 150_000n });
if (currentCap === 0n) operations.push({ label: 'set-merchant-daily-cap', account: merchant, address: A.GasTank, abi: gasTankAbi, functionName: 'setDailyCap', args: [dailyCap], value: 0n, gas: 150_000n });
const allowances = [
  { account: merchant, spender: A.Router, amount: 1_000_000n, label: 'merchant-router-fees' },
  { account: merchant, spender: A.PaymentEscrow, amount: 2_000_000n, label: 'merchant-refunds' },
  { account: payer, spender: A.PaymentEscrow, amount: 2_000_000n, label: 'payer-charge' },
];
for (const item of allowances) {
  const current = await read(token, erc, 'allowance', [item.account.address, item.spender]) as bigint;
  if (current >= item.amount) continue;
  if (item.account.address === payer.address) {
    assert.equal(current, 0n, 'Unexpected partial payer allowance; review rather than reset');
    operations.push({ label: 'approve-payer-charge', account: relayer, address: payer.address, abi: approver, functionName: 'approveFor', args: [token, item.spender, item.amount, 0n, '0x'], value: 0n, gas: 200_000n });
    continue;
  }
  if (current !== 0n) operations.push({ label: `reset-${item.label}`, account: item.account, address: token, abi: erc, functionName: 'approve', args: [item.spender, 0n], value: 0n, gas: 100_000n });
  operations.push({ label: `approve-${item.label}`, account: item.account, address: token, abi: erc, functionName: 'approve', args: [item.spender, item.amount], value: 0n, gas: 100_000n });
}
const price = await pub.getGasPrice();
assert(price <= 10_000_000_000n, 'Gas price increased; re-evaluate bootstrap costs');
const feeBudget = 10_000_000_000_000_000n;
const l1Reserve = 1_000_000_000_000_000n;
assert(operations.reduce((sum, op) => sum + op.gas * price, l1Reserve) <= feeBudget);
for (const account of [merchant, relayer]) {
  const needed = operations.filter(op => op.account.address === account.address).reduce((sum, op) => sum + op.value + op.gas * price, l1Reserve);
  assert(await pub.getBalance({ address: account.address }) >= needed, 'Insufficient native gas balance');
}
const json = (value: unknown) => JSON.stringify(value, (_, v: unknown) => typeof v === 'bigint' ? String(v) : v, 2);
const publicPlan = operations.map(({ account, abi: _abi, ...op }) => ({ ...op, sender: account.address }));
console.log(json({ phase: 'preflight', block: await pub.getBlockNumber(), tankTargetWbt: formatEther(tankTarget), dailyCapWbt: formatEther(dailyCap), operations: publicPlan }));
if (process.env.ACTIVATE_EXECUTE !== '1') process.exit(0);
const reportPath = new URL('../../../contracts/activation-bootstrap.json', import.meta.url);
assert(!existsSync(reportPath), 'A bootstrap journal already exists; reconcile rather than repeat');
const report: Record<string, any> = { status: 'in_progress', chainId: 1874, contracts: A, merchant: merchant.address, payer: payer.address, startedAt: new Date().toISOString(), operations: publicPlan, transactions: [], feeBudgetWei: feeBudget, fundedWei: 0n };
const save = () => writeFileSync(reportPath, json(report) + '\n');
save();
let fees = 0n;
for (const op of operations) {
  if (op.label === 'approve-payer-charge') {
    // No nonce fallback and no new delegation: reuse the payer's existing implementation.
    const nonce = await read(payer.address, approver, 'approvalNonce') as bigint;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const amount = 2_000_000n;
    const digest = keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [1874n, payer.address, token, A.PaymentEscrow, amount, nonce, deadline]));
    assert.equal(await read(payer.address, approver, 'approvalHash', [token, A.PaymentEscrow, amount, nonce, deadline]), hashMessage({ raw: digest }));
    const signature = await payer.signMessage({ message: { raw: digest } });
    op.args = [token, A.PaymentEscrow, amount, deadline, signature];
    report.approvalNonceBefore = nonce;
  }
  const wallet = createWalletClient({ account: op.account, chain, transport: http() });
  const { request } = await pub.simulateContract({ account: op.account, address: op.address, abi: op.abi, functionName: op.functionName, args: op.args, value: op.value, gas: op.gas, gasPrice: price });
  const hash = await wallet.writeContract(request);
  const entry: Record<string, any> = { label: op.label, sender: op.account.address, hash, status: 'submitted' };
  report.transactions.push(entry); save();
  const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 180_000 });
  const l1 = BigInt((receipt as typeof receipt & { l1Fee?: Hex }).l1Fee ?? 0);
  const fee = receipt.gasUsed * receipt.effectiveGasPrice + l1;
  Object.assign(entry, { status: receipt.status, block: receipt.blockNumber, gasUsed: receipt.gasUsed, gasPrice: receipt.effectiveGasPrice, l1FeeWei: l1, totalFeeWei: fee });
  fees += fee; report.totalFeeWei = fees; report.fundedWei += op.value; save();
  assert.equal(receipt.status, 'success', `Bootstrap operation failed: ${op.label}`);
  assert(fees <= feeBudget);
  console.log(`${op.label}: confirmed ${hash}`);
}
assert(await read(A.GasTank, gasTankAbi, 'balanceOf', [merchant.address]) as bigint >= tankTarget);
assert.equal(await read(A.GasTank, gasTankAbi, 'dailyCap', [merchant.address]), dailyCap);
for (const item of allowances) assert(await read(token, erc, 'allowance', [item.account.address, item.spender]) as bigint >= item.amount);
assert.equal(await pub.getBalance({ address: payer.address }), 0n);
report.status = 'bootstrap_verified'; report.completedAt = new Date().toISOString(); save();
console.log(json({ status: report.status, totalFeeWbt: formatEther(fees), fundedWbt: formatEther(report.fundedWei) }));
