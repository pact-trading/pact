// Local-only fork integration. Never reads wallets, runtime env files, or keys.
// Run: CONTRACT_ARTIFACTS_DIR=/path/to/contracts/out pnpm exec tsx scripts/check-subscription-v2.ts
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, erc20Abi, hashTypedData, toFunctionSelector, http, keccak256, toHex, type AbiFunction, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { openDb, seedMerchant } from '../src/db.js';
import { ViemChain, subscriptionV2Abi, gasTankAbi, routerAbi, type Addresses } from '../src/chain.js';
import { ApprovalService, APPROVER, USDT } from '../src/approval.js';
import { Relayer, allowedTargets, transactionGas } from '../src/relayer.js';
import { createApp } from '../src/app.js';
import { Indexer } from '../src/indexer.js';
import { intentTypedData, mandateTypedData, consentTypedData, cancellationTypedData } from '../src/typed-data.js';

const forkBlock = 11927040;
const journal = JSON.parse(readFileSync(new URL('../../../contracts/deployment.json', import.meta.url), 'utf8'));
const addresses: Addresses = { router: journal.contracts.Router, escrow: journal.contracts.PaymentEscrow, subscription: journal.contracts.SubscriptionManager, gasTank: journal.contracts.GasTank };
const holder = journal.deployer as Address;
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
// Public deterministic local-only fixture keys, never live funded identities.
const payer = privateKeyToAccount(`0x${'91'.repeat(32)}`);
const merchant = privateKeyToAccount(`0x${'93'.repeat(32)}`);
const relayerKey = `0x${'92'.repeat(32)}` as Hex;
const relayerAccount = privateKeyToAccount(relayerKey);
const pub = createPublicClient({ chain: network, transport: http(rpc, { retryCount: 0, timeout: 60_000 }), cacheTime: 0 });
const deployer = createWalletClient({ chain: network, account: relayerAccount, transport: http(rpc) });
const merchantClient = createWalletClient({ chain: network, account: merchant, transport: http(rpc) });
const holderClient = createWalletClient({ chain: network, account: holder, transport: http(rpc) });
const db = openDb();
async function receipt(hash: Hex) {
  for (let i = 0; i < 100; i++) {
    const result = await pub.getTransactionReceipt({ hash }).catch(() => null);
    if (result) { assert.equal(result.status, 'success'); return result; }
    await delay(300);
  }
  throw new Error(`Local receipt timeout ${hash}`);
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(startupError);
    try { assert.match(await local('web3_clientVersion'), /anvil/i); ready = true; break; } catch { await delay(300); }
  }
  assert(ready); assert.equal(await pub.getChainId(), 1874);
  for (const [name, address] of Object.entries(journal.contracts)) assert.equal(keccak256((await pub.getCode({ address: address as Address }))!), journal.runtimeCodeHashes[name]);
  await local('anvil_setBalance', [relayerAccount.address, toHex(2n * 10n ** 18n)]);
  await local('anvil_setBalance', [merchant.address, toHex(10n ** 18n)]);
  await local('anvil_impersonateAccount', [holder]);
  const artifact = JSON.parse(readFileSync(new URL('../../../contracts/out/SubscriptionManagerV2.sol/SubscriptionManagerV2.json', import.meta.url), 'utf8'));
  const deployment = await receipt(await deployer.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object, args: [USDT, addresses.router, relayerAccount.address] }));
  addresses.subscription = deployment.contractAddress!;
  await receipt(await holderClient.writeContract({ address: USDT, abi: erc20Abi, functionName: 'transfer', args: [payer.address, 2_000_000n] }));
  await receipt(await holderClient.writeContract({ address: USDT, abi: erc20Abi, functionName: 'transfer', args: [merchant.address, 100_000n] }));
  await receipt(await holderClient.writeContract({ address: addresses.router, abi: routerAbi, functionName: 'setAllowed', args: [addresses.subscription, toFunctionSelector('charge(bytes32,uint256)'), true, true] }));
  await receipt(await merchantClient.writeContract({ address: USDT, abi: erc20Abi, functionName: 'approve', args: [addresses.router, 100_000n] }));
  await receipt(await merchantClient.writeContract({ address: addresses.gasTank, abi: gasTankAbi, functionName: 'deposit', args: [merchant.address], value: 20_000_000_000_000_000n }));
  await receipt(await merchantClient.writeContract({ address: addresses.gasTank, abi: gasTankAbi, functionName: 'setDailyCap', args: [20_000_000_000_000_000n] }));
  // Fixture allowance only: a local zero-fee approval. This is NOT evidence of
  // hosted subscription allowance onboarding, which remains a separate task.
  await local('anvil_impersonateAccount', [payer.address]);
  await local('anvil_setNextBlockBaseFeePerGas', ['0x0']);
  const approvalHash = await local('eth_sendTransaction', [{ from: payer.address, to: USDT, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [addresses.subscription, 2_000_000n] }), gas: '0x186a0', gasPrice: '0x0' }]) as Hex;
  await receipt(approvalHash); await local('anvil_stopImpersonatingAccount', [payer.address]);
  await local('evm_setNextBlockTimestamp', [Math.floor(Date.now() / 1000)]); await local('evm_mine');
  const chain = new ViemChain(rpc, relayerKey, addresses, 2);
  const keys = seedMerchant(db, merchant.address);
  const relayer = new Relayer(chain, addresses.router, allowedTargets(addresses.escrow, addresses.subscription, 2));
  const app = createApp({ db, chain, relayer, ...addresses });
  const indexer = new Indexer(db, chain, deployment.blockNumber);
  async function post(path: string, body: unknown) {
    const response = await app.request(path, { method: 'POST', headers: { authorization: `Bearer ${keys.secretKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body, (_, v) => typeof v === 'bigint' ? v.toString() : v) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  }
  async function settle(hash: Hex) { await receipt(hash); await local('anvil_mine', ['0x3']); await indexer.poll(); }
  const plan = await post('/v1/subscriptions/plans', { name: 'Local V2', amount: '2', periodSeconds: 86400, maxPeriods: 2 });
  const mandate = { payer: payer.address, merchant: merchant.address, planId: keccak256(toHex(plan.id)), amountCap: 2_000_000n, periodSeconds: 86400n, maxPeriods: 2, endTime: BigInt(Math.floor(Date.now() / 1000) + 86400 * 3), nonce: 0n };
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const typed = mandateTypedData(mandate, addresses.subscription, '2');
  const sub = await post('/v1/subscriptions', { planId: plan.id, mandate, signature: await payer.signTypedData(typed), merchantConsent: { deadline, signature: await merchant.signTypedData(consentTypedData(hashTypedData(typed), deadline, addresses.subscription)) } });
  await settle(sub.txHash);
  assert.equal((db.prepare('SELECT status FROM subscriptions WHERE id=?').get(sub.id) as {status:string}).status, 'active');
  const data = encodeFunctionData({ abi: subscriptionV2Abi, functionName: 'charge', args: [sub.chainId, 2_000_000n] });
  const intent = { signer: merchant.address, merchant: merchant.address, target: addresses.subscription, dataHash: keccak256(data), amount: 2_000_000n, feeUSDT: 10_000n, nonce: 1n, deadline, maxGas: 400_000 };
  const renewal = await post('/v1/intents', { intent, data, signature: await merchant.signTypedData(intentTypedData(intent, addresses.router)) });
  await settle(renewal.txHash);
  assert.equal(await pub.readContract({ address: USDT, abi: erc20Abi, functionName: 'balanceOf', args: [payer.address] }), 0n);
  // Atomic replacement uses a payer-signed Router intent plus a fresh mandate
  // and exact merchant sponsorship consent. Only this local fork is allowlisted.
  const replaceSelector = subscriptionV2Abi.find((item): item is AbiFunction => item.type === 'function' && item.name === 'replace');
  assert(replaceSelector);
  await receipt(await holderClient.writeContract({ address: addresses.router, abi: routerAbi, functionName: 'setAllowed', args: [addresses.subscription, toFunctionSelector(replaceSelector), true, false] }));
  const replacementMandate = { ...mandate, nonce: 1n };
  const replacementTyped = mandateTypedData(replacementMandate, addresses.subscription, '2');
  const replacementData = encodeFunctionData({ abi: subscriptionV2Abi, functionName: 'replace', args: [sub.chainId, replacementMandate, await payer.signTypedData(replacementTyped), deadline, await merchant.signTypedData(consentTypedData(hashTypedData(replacementTyped), deadline, addresses.subscription))] });
  const replacementIntent = { ...intent, signer: payer.address, dataHash: keccak256(replacementData), nonce: 2n, maxGas: 500_000 };
  const replacement = await post(`/v1/subscriptions/${sub.id}/replace`, { planId: plan.id, intent: replacementIntent, data: replacementData, signature: await payer.signTypedData(intentTypedData(replacementIntent, addresses.router)) });
  await settle(replacement.txHash);
  assert.equal((db.prepare('SELECT status FROM subscriptions WHERE id=?').get(sub.id) as {status:string}).status, 'cancelled');
  assert.equal((db.prepare('SELECT status FROM subscriptions WHERE id=?').get(replacement.id) as {status:string}).status, 'active');
  const oldSnapshot = await pub.readContract({ address: addresses.subscription, abi: subscriptionV2Abi, functionName: 'subscriptions', args: [sub.chainId] }) as unknown[];
  assert.equal(oldSnapshot.at(-1), true);
  const remainingTank = await pub.readContract({ address: addresses.gasTank, abi: gasTankAbi, functionName: 'balanceOf', args: [merchant.address] }) as bigint;
  assert(remainingTank < 20_000_000_000_000_000n);
  await receipt(await merchantClient.writeContract({ address: addresses.gasTank, abi: gasTankAbi, functionName: 'withdraw', args: [remainingTank] }));
  const cancellation = await post(`/v1/subscriptions/${replacement.id}/cancel`, { deadline, signature: await payer.signTypedData(cancellationTypedData(replacement.chainId, deadline, addresses.subscription)) });
  await settle(cancellation.txHash);
  assert.equal((db.prepare('SELECT status FROM subscriptions WHERE id=?').get(replacement.id) as {status:string}).status, 'cancelled');
  assert.equal(await pub.getBalance({ address: payer.address }), 0n);
  assert.equal(await pub.readContract({ address: addresses.gasTank, abi: gasTankAbi, functionName: 'balanceOf', args: [merchant.address] }), 0n);
  const snapshot = await pub.readContract({ address: addresses.subscription, abi: subscriptionV2Abi, functionName: 'subscriptions', args: [replacement.chainId] }) as unknown[];
  assert.equal(snapshot.at(-1), true);
  const costRows = db.prepare('SELECT cost_wei FROM relayer_spend_reservations').all(); assert.equal(costRows.length, 4);
  const evidence = { localOnly: true, forkBlock, subscription: addresses.subscription, registration: sub.txHash, renewal: renewal.txHash, replacement: replacement.txHash, cancellation: cancellation.txHash, payerWbt: '0', merchantTankAfterCancellation: '0', renewalAmount: '2.000000', state: 'cancelled', durableGasReservations: costRows.length, allowanceBootstrap: 'local-zero-fee-fixture-not-hosted-onboarding' };
  writeFileSync('/tmp/gol-subscription-v2-fork.json', JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
} finally { db.close(); child.kill('SIGTERM'); }
