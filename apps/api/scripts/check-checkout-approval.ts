// Local-only fork integration. Never reads wallets, runtime env files, or keys.
// Run: CONTRACT_ARTIFACTS_DIR=/path/to/contracts/out pnpm exec tsx scripts/check-checkout-approval.ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, erc20Abi, http, keccak256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { amountString, openDb, seedMerchant } from '../src/db.js';
import { ViemChain, escrowAbi, gasTankAbi, routerAbi, type Addresses } from '../src/chain.js';
import { ApprovalService, APPROVER, USDT } from '../src/approval.js';
import { Relayer, allowedTargets, transactionGas } from '../src/relayer.js';
import { createApp } from '../src/app.js';
import { Indexer } from '../src/indexer.js';
import { intentTypedData } from '../src/typed-data.js';

const forkBlock = 11927040;
const journal = JSON.parse(readFileSync(new URL('../../../contracts/deployment.json', import.meta.url), 'utf8'));
const addresses: Addresses = { router: journal.contracts.Router, escrow: journal.contracts.PaymentEscrow, subscription: journal.contracts.SubscriptionManager, gasTank: journal.contracts.GasTank };
const merchant = journal.deployer as Address;
const lease = createServer();
await new Promise<void>(resolve => lease.listen(0, '127.0.0.1', resolve));
const port = (lease.address() as { port: number }).port;
await new Promise<void>((resolve, reject) => lease.close(e => e ? reject(e) : resolve()));
const rpc = `http://127.0.0.1:${port}`;
function assertLocal(url: string) {
  const u = new URL(url);
  assert.equal(u.protocol, 'http:'); assert.equal(u.hostname, '127.0.0.1');
  assert(u.port && !['3000', '3001', '3002'].includes(u.port), 'Refusing application ports');
  assert(!u.username && !u.password && u.pathname === '/', 'Refusing proxy/credential URLs');
}
assertLocal(rpc);
// The remote endpoint is ONLY an Anvil fork source (state reads). Every wallet
// and raw JSON-RPC client below is fixed to this newly spawned loopback node.
const child = spawn('anvil', ['--quiet', '--host', '127.0.0.1', '--port', String(port), '--accounts', '0', '--chain-id', '1874', '--hardfork', 'prague', '--fork-url', 'https://rpc.testnet.whitechain.io', '--fork-block-number', String(forkBlock)], { stdio: ['ignore', 'ignore', 'pipe'] });
let startupError = ''; child.stderr.on('data', chunk => { startupError = (startupError + String(chunk)).slice(-1500); });
child.on('error', error => { startupError = error.message; });
let requestId = 0;
async function local(method: string, params: unknown[] = []): Promise<any> {
  assertLocal(rpc);
  const response = await fetch(rpc, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method, params }), signal: AbortSignal.timeout(30_000) });
  const result = await response.json() as { result?: unknown; error?: { message: string } };
  if (result.error) throw new Error(`${method}: ${result.error.message}`);
  return result.result;
}
const network = defineChain({ id: 1874, name: 'LOCAL Whitechain fork', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
// Public, deterministic TEST keys, unrelated to any funded live wallet.
const payer = privateKeyToAccount(`0x${'91'.repeat(32)}`);
const relayerKey = `0x${'92'.repeat(32)}` as Hex;
const relayerAccount = privateKeyToAccount(relayerKey);
const publicClient = createPublicClient({ chain: network, transport: http(rpc, { retryCount: 0, timeout: 120_000 }), cacheTime: 0 });
const merchantClient = createWalletClient({ account: merchant, chain: network, transport: http(rpc, { retryCount: 0 }) });
const db = openDb();
try {
  let started = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Anvil startup failed: ${startupError}`);
    try { assert.match(await local('web3_clientVersion'), /anvil/i); started = true; break; } catch { await delay(300); }
  }
  assert(started, `Anvil fork unavailable: ${startupError}`);
  assert.equal(await publicClient.getChainId(), 1874);
  assert.equal(await publicClient.getBlockNumber(), BigInt(forkBlock));
  const delegateCode = await publicClient.getCode({ address: APPROVER }); assert(delegateCode);
  const artifactPath = process.env.CONTRACT_ARTIFACTS_DIR ? join(process.env.CONTRACT_ARTIFACTS_DIR, 'SponsoredApprover.sol/SponsoredApprover.json') : new URL('../../../contracts/out/SponsoredApprover.sol/SponsoredApprover.json', import.meta.url);
  const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
  assert.equal(keccak256(delegateCode), keccak256(artifact.deployedBytecode.object), 'Delegate runtime differs from local compiled artifact');
  for (const [name, address] of Object.entries(journal.contracts)) assert.equal(keccak256((await publicClient.getCode({ address: address as Address }))!), journal.runtimeCodeHashes[name]);
  assert.equal(await publicClient.getCode({ address: payer.address }), undefined);
  assert.equal(await publicClient.getBalance({ address: payer.address }), 0n);
  await local('anvil_setBalance', [relayerAccount.address, toHex(10n ** 18n)]);
  await local('anvil_impersonateAccount', [merchant]);
  // Move two real-token units ONLY in the local fork. No native payer funding.
  const funding = await merchantClient.writeContract({ address: USDT, abi: erc20Abi, functionName: 'transfer', args: [payer.address, 2_000_000n] });
  assert.equal((await publicClient.waitForTransactionReceipt({ hash: funding })).status, 'success');
  await local('evm_setNextBlockTimestamp', [Math.floor(Date.now() / 1000)]);
  const chain = new ViemChain(rpc, relayerKey, addresses);
  const keys = seedMerchant(db, merchant);
  const relayer = new Relayer(chain, addresses.router, allowedTargets(addresses.escrow, addresses.subscription));
  const approval = new ApprovalService(db, chain, { enabled: true, delegate: APPROVER, runtimeHash: keccak256(delegateCode), escrow: addresses.escrow, minimumAmount: 1_000_000n });
  const app = createApp({ db, chain, relayer, approval, ...addresses });
  async function api(path: string, body?: unknown) {
    const response = await app.request(path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${keys.secretKey}`, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body, (_, v) => typeof v === 'bigint' ? v.toString() : v) } : {}) });
    const result = await response.json(); assert.equal(response.status, 200, result.error?.code ?? 'API request failed'); return result;
  }
  await api('/v1/settings', { brandName: 'Local fork merchant', refundWindowSeconds: 604800 });
  const payment = await api('/v1/payments', { amount: '2' });
  // Later changes must not alter this payment's signed seven-day promise.
  await api('/v1/settings', { refundWindowSeconds: 2592000 });
  const feePreview = await api('/v1/fees/preview?maxGas=400000');
  const rate = await publicClient.readContract({ address: addresses.router, abi: routerAbi, functionName: 'usdtPerWBT', blockNumber: BigInt(feePreview.blockNumber) }) as bigint;
  assert.equal(feePreview.usdtPerWbtMinor, String(rate));
  assert.equal(feePreview.minimumFeeMinor, String((440_000n * BigInt(feePreview.gasPriceWei) * rate + 10n ** 18n - 1n) / 10n ** 18n));
  const approvalPath = `/v1/payments/${payment.id}/approval`;
  const readPath = `${approvalPath}?payer=${payer.address}`;
  const readiness = await api(readPath);
  assert.equal(readiness.status, 'needs_approval'); assert.equal(readiness.authorizationRequired, true);
  assert.equal(readiness.approvalNonce, '0'); assert.equal(readiness.authorizationNonce, '0');
  const signature = await payer.signMessage({ message: { raw: readiness.message } });
  const { address, chainId, nonce, r, s, yParity } = await payer.signAuthorization({ address: readiness.delegate, chainId: 1874, nonce: Number(readiness.authorizationNonce) });
  const tankBeforeApproval = await publicClient.readContract({ address: addresses.gasTank, abi: gasTankAbi, functionName: 'balanceOf', args: [merchant] });
  const pending = await api(approvalPath, { payer: payer.address, approvalNonce: readiness.approvalNonce, deadline: readiness.deadline, signature, authorization: { address, chainId, nonce, r, s, yParity } });
  assert.equal(pending.status, 'pending'); assert(pending.txHash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: pending.txHash }); assert.equal(receipt.status, 'success');
  assert.equal((await publicClient.getTransaction({ hash: pending.txHash })).type, 'eip7702');
  assert.equal((await chain.approval.receipt(pending.txHash, payer.address))?.approvals.length, 1);
  await local('anvil_mine', ['0x2']);
  let ready = pending;
  for (let i = 0; i < 12 && ready.status !== 'ready'; i++) { ready = await api(readPath); if (ready.status !== 'ready') await delay(500); }
  assert.equal(ready.status, 'ready', JSON.stringify(ready));
  assert.equal(ready.allowance, '2000000');
  assert.equal((await publicClient.getCode({ address: payer.address }))?.toLowerCase(), `0xef0100${APPROVER.slice(2).toLowerCase()}`);
  assert.equal(await publicClient.getBalance({ address: payer.address }), 0n);
  assert.equal(await publicClient.readContract({ address: addresses.gasTank, abi: gasTankAbi, functionName: 'balanceOf', args: [merchant] }), tankBeforeApproval, 'Approval must not spend GasTank');
  const approvalEvidence = { localOnly: true, forkBlock, chainId: 1874, payer: payer.address, relayer: relayerAccount.address, delegate: APPROVER, runtimeHash: keccak256(delegateCode), approvalHash: pending.txHash, approvalType: 'eip7702', approvalStatus: receipt.status, approvalGasUsed: receipt.gasUsed.toString(), approvalAmount: readiness.amount, approvalReadiness: ready.status, allowanceAfterApproval: ready.allowance, payerNativeBalanceWei: '0', gasTankUnchangedByApproval: true };
  writeFileSync('/tmp/gol-checkout-approval-fork.json', JSON.stringify(approvalEvidence, null, 2) + '\n');
  console.log('Local fork approval verified; warming Router state for charge.');
  const merchantApproval = await merchantClient.writeContract({ address: USDT, abi: erc20Abi, functionName: 'approve', args: [addresses.router, 10_000n] });
  assert.equal((await publicClient.waitForTransactionReceipt({ hash: merchantApproval })).status, 'success');
  const data = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [payment.id, merchant, 2_000_000n, BigInt(payment.refundWindowSeconds)] });
  const intent = { signer: payer.address, merchant, target: addresses.escrow, dataHash: keccak256(data), amount: 2_000_000n, feeUSDT: 10_000n, nonce: 1n, deadline: BigInt(Math.floor(Date.now() / 1000) + 300), maxGas: 400_000 };
  const request = { intent, data, signature: await payer.signTypedData(intentTypedData(intent, addresses.router)) };
  // A cold Anvil fork can fetch many storage slots from the upstream node.
  // Warm only an eth_call with a longer LOCAL timeout; no broadcast/retry here.
  await publicClient.call({ account: relayerAccount, to: addresses.router, data: encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: [intent, data, request.signature] }), gas: transactionGas(request), gasPrice: await publicClient.getGasPrice() });
  const charge = await api('/v1/intents', request);
  const chargeReceipt = await publicClient.waitForTransactionReceipt({ hash: charge.txHash }); assert.equal(chargeReceipt.status, 'success');
  const events = (await chain.receipt(charge.txHash))!.events;
  assert(events.some(e => e.name === 'Executed')); assert(events.some(e => e.name === 'Charged' && e.args.id === payment.id));
  await local('anvil_mine', ['0x2']); await delay(4100);
  await new Indexer(db, chain, receipt.blockNumber).poll();
  const paid = await api(`/v1/payments/${payment.id}`);
  assert.equal(paid.financialStatus, 'captured'); assert.equal(paid.captured, '2.000000');
  const onchainPayment = await publicClient.readContract({ address: addresses.escrow, abi: escrowAbi, functionName: 'payments', args: [payment.id], blockNumber: chargeReceipt.blockNumber }) as readonly unknown[];
  assert.equal(paid.refundWindowSeconds, 604800);
  assert.equal(paid.onchainRefundWindowSeconds, String(onchainPayment[7]));
  assert.equal(paid.refundDeadlineUnix, String(onchainPayment[6]));
  assert.equal(paid.refundDeadline, new Date(Number(onchainPayment[6]) * 1000).toISOString());
  // Warm the fork's upstream reads once; the dashboard itself retains a strict
  // 2.5-second independent-read deadline for user-facing requests.
  await Promise.all([chain.merchantBalance(merchant), chain.gasTank(merchant)]);
  const dashboard = await api('/v1/dashboard');
  assert.equal(dashboard.balance.available, true);
  const merchantBalance = await publicClient.readContract({ address: USDT, abi: erc20Abi, functionName: 'balanceOf', args: [merchant], blockNumber: BigInt(dashboard.balance.blockNumber) });
  assert.equal(dashboard.balance.amountUsdt, amountString(merchantBalance));
  assert.equal(dashboard.today.capturedUsdt, '2.000000');
  assert.equal(dashboard.today.payments, 1);
  assert.equal(await publicClient.getBalance({ address: payer.address }), 0n);
  assert.equal(await publicClient.readContract({ address: USDT, abi: erc20Abi, functionName: 'allowance', args: [payer.address, addresses.escrow] }), 0n);
  const evidence = { localOnly: true, forkBlock, chainId: 1874, payer: payer.address, relayer: relayerAccount.address, delegate: APPROVER, runtimeHash: keccak256(delegateCode), approvalHash: pending.txHash, approvalType: 'eip7702', approvalStatus: receipt.status, approvalGasUsed: receipt.gasUsed.toString(), approvalAmount: readiness.amount, approvalReadiness: ready.status, allowanceAfterApproval: ready.allowance, chargeHash: charge.txHash, chargeStatus: chargeReceipt.status, financialStatus: paid.financialStatus, captured: paid.captured, feePreview, walletBalanceUsdt: dashboard.balance.amountUsdt, confirmedToday: dashboard.today, refundWindowSeconds: paid.refundWindowSeconds, refundDeadlineUnix: paid.refundDeadlineUnix, onchainRefundWindowSeconds: paid.onchainRefundWindowSeconds, payerNativeBalanceWei: '0', allowanceAfterCharge: '0', gasTankUnchangedByApproval: true };
  writeFileSync('/tmp/gol-checkout-approval-fork.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  db.close(); child.kill('SIGTERM');
}
