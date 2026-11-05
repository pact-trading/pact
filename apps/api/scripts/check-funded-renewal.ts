// Executable LOCAL proof. All writes target an Anvil spawned by renewal-fork.
// No dotenv, runtime files, user wallet keys, external signing or live writes.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPublicClient, createWalletClient, defineChain, encodeFunctionData, erc20Abi, hashTypedData, http, keccak256, toHex, toFunctionSelector, type Address, type Hex } from 'viem';
import { spawnRenewalFork, localRenewalAccounts, localRenewalRelayer, RENEWAL_FORK_BLOCK, V2_NORMALIZED_RUNTIME_HASH } from '../src/local/renewal-fork.js';
import { gasTankAbi, routerAbi, type Addresses } from '../src/chain.js';
import { openDb, seedMerchant } from '../src/db.js';
import { createApp } from '../src/app.js';
import { Relayer, allowedTargets, transactionGas } from '../src/relayer.js';
import { Indexer } from '../src/indexer.js';
import { FundedRenewals, RENEWAL_USDT, type MerchantRenewalSigner } from '../src/funded-renewals.js';
import { type RenewalGrant, json } from '../src/funded-renewal-store.js';
import { mandateTypedData, consentTypedData, cancellationTypedData } from '../src/typed-data.js';
import { runKeeper } from '../src/keeper.js';
import type { IntentRequest } from '../src/types.js';

const journal = JSON.parse(readFileSync(new URL('../../../contracts/deployment.json', import.meta.url), 'utf8'));
console.log('Starting owned loopback Anvil at pinned block');
const fork = await spawnRenewalFork();
console.log('Owned Anvil ready; creating local-only V2 fixture');
const network = defineChain({ id: 1874, name: 'Owned local renewal fork', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [fork.url] } } });
const pub = createPublicClient({ chain: network, transport: http(fork.url, { retryCount: 0, timeout: 30_000 }), cacheTime: 0 });
const { merchant, payer, admin } = localRenewalAccounts;
const wallet = (account: typeof merchant | Address) => createWalletClient({ chain: network, account, transport: http(fork.url, { retryCount: 0 }) });
const administrator = wallet(admin), merchantWallet = wallet(merchant);
let db = openDb();
const actualNow = Date.now;
let clock = actualNow(), clockOffset = 0;
Date.now = () => actualNow() + clockOffset; // Isolated test clock; never a runtime configuration.
const checks: string[] = [];
const check = (text: string) => { checks.push(text); console.log(text); };
const proof: Record<string, unknown> = { localOnly: true, forkBlock: RENEWAL_FORK_BLOCK, forkBlockHash: fork.forkBlockHash };
async function receipt(hash: Hex) {
  for (let i = 0; i < 100; i++) {
    try { const r = await pub.getTransactionReceipt({ hash }); assert.equal(r.status, 'success'); return r; }
    catch (e) { if ((e as Error).name !== 'TransactionReceiptNotFoundError') throw e; }
    await delay(100);
  }
  throw new Error('Local receipt timeout');
}
async function mine() { await fork.rpc('anvil_mine', ['0x3']); await delay(4100); } // Existing ViemChain head-cache expiry, no mocked reads.
async function syncClock(target?: bigint) {
  const head = await pub.getBlock({ blockTag: 'latest' });
  clock = Number(target ?? (head.timestamp > BigInt(Math.floor(actualNow() / 1000)) ? head.timestamp + 1n : BigInt(Math.floor(actualNow() / 1000)))) * 1000;
  clockOffset = clock - actualNow();
  await fork.rpc('evm_setNextBlockTimestamp', [Math.floor(clock / 1000)]); await fork.rpc('evm_mine');
}
try {
  assert.equal(await pub.getChainId(), 1874);
  for (const account of [admin.address, merchant.address, localRenewalRelayer]) await fork.rpc('anvil_setBalance', [account, toHex(2n * 10n ** 18n)]);
  assert.equal(await pub.getBalance({ address: payer.address }), 0n);
  const artifactRoot = process.env.CONTRACT_ARTIFACTS_DIR ?? new URL('../../../contracts/out/', import.meta.url).pathname;
  const v2 = JSON.parse(readFileSync(join(artifactRoot, 'SubscriptionManagerV2.sol/SubscriptionManagerV2.json'), 'utf8'));
  assert.equal(keccak256(v2.deployedBytecode.object), V2_NORMALIZED_RUNTIME_HASH, 'Use reviewed V2 artifact');
  const deployed = await receipt(await administrator.deployContract({ abi: v2.abi, bytecode: v2.bytecode.object, args: [RENEWAL_USDT, journal.contracts.Router, localRenewalRelayer], gas: 4_000_000n }));
  const addresses: Addresses = { router: journal.contracts.Router, gasTank: journal.contracts.GasTank, escrow: journal.contracts.PaymentEscrow, subscription: deployed.contractAddress! };
  const holder = journal.deployer as Address;
  await fork.rpc('anvil_impersonateAccount', [holder]);
  await fork.rpc('anvil_setBalance', [holder, toHex(10n ** 18n)]);
  const holderWallet = wallet(holder);
  await receipt(await holderWallet.writeContract({ address: RENEWAL_USDT, abi: erc20Abi, functionName: 'transfer', args: [payer.address, 2_000_000n], gas: 100_000n }));
  await receipt(await holderWallet.writeContract({ address: RENEWAL_USDT, abi: erc20Abi, functionName: 'transfer', args: [merchant.address, 100_000n], gas: 100_000n }));
  await receipt(await holderWallet.writeContract({ address: addresses.router, abi: routerAbi, functionName: 'setAllowed', args: [addresses.subscription, toFunctionSelector('charge(bytes32,uint256)'), true, true], gas: 100_000n }));
  await receipt(await holderWallet.writeContract({ address: addresses.router, abi: routerAbi, functionName: 'setLimits', args: [1_000_000n, 2_000_000n, 10, 1_000_000, 100_000_000_000n], gas: 100_000n })); // Local non-default ratio validates root M1 shared quote.
  await fork.rpc('anvil_stopImpersonatingAccount', [holder]);
  await receipt(await merchantWallet.writeContract({ address: RENEWAL_USDT, abi: erc20Abi, functionName: 'approve', args: [addresses.router, 30_000n], gas: 100_000n }));
  await receipt(await merchantWallet.writeContract({ address: addresses.gasTank, abi: gasTankAbi, functionName: 'deposit', args: [merchant.address], value: 10n ** 17n, gas: 100_000n }));
  await receipt(await merchantWallet.writeContract({ address: addresses.gasTank, abi: gasTankAbi, functionName: 'setDailyCap', args: [10n ** 17n], gas: 100_000n }));
  // Fixture allowance only, no claim of hosted gasless subscription onboarding.
  await fork.rpc('anvil_impersonateAccount', [payer.address]);
  await fork.rpc('anvil_setNextBlockBaseFeePerGas', ['0x0']);
  await receipt(await fork.rpc('eth_sendTransaction', [{ from: payer.address, to: RENEWAL_USDT, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [addresses.subscription, 2_000_000n] }), gas: '0x186a0', gasPrice: '0x0' }]));
  await fork.rpc('anvil_stopImpersonatingAccount', [payer.address]);
  await syncClock();
  console.log('Fixture funded locally; attesting runtimes and registering mandate');
  let bundle = await fork.createChain(addresses);
  let chain = bundle.chain; chain.writer.bind(db);
  proof.runtimeHashes = bundle.runtimeHashes; proof.localV2 = addresses.subscription;
  const keys = seedMerchant(db, merchant.address);
  const makeApp = () => createApp({ db, chain, relayer: new Relayer(chain, addresses.router, allowedTargets(addresses.escrow, addresses.subscription, 2)), ...addresses });
  let app = makeApp(), indexer = new Indexer(db, chain, deployed.blockNumber);
  const post = async (path: string, body: unknown) => {
    const response = await app.request(path, { method: 'POST', headers: { authorization: `Bearer ${keys.secretKey}`, 'content-type': 'application/json' }, body: json(body) });
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result;
  };
  const plan = await post('/v1/subscriptions/plans', { name: 'Funded local renewal', amount: '1', periodSeconds: 86400, maxPeriods: 3 });
  const start = BigInt(Math.floor(clock / 1000));
  const mandate = { payer: payer.address, merchant: merchant.address, planId: keccak256(toHex(plan.id)), amountCap: 1_000_000n, periodSeconds: 86400n, maxPeriods: 3, endTime: start + 4n * 86400n, nonce: 0n };
  const typed = mandateTypedData(mandate, addresses.subscription, '2'), consentDeadline = start + 300n;
  const sub = await post('/v1/subscriptions', { planId: plan.id, mandate, signature: await payer.signTypedData(typed), merchantConsent: { deadline: consentDeadline, signature: await merchant.signTypedData(consentTypedData(hashTypedData(typed), consentDeadline, addresses.subscription)) } });
  await receipt(sub.txHash); await mine(); await indexer.poll(); await syncClock();
  assert.equal((db.prepare('SELECT status FROM subscriptions WHERE id=?').get(sub.id) as any).status, 'active');
  let signed = 0;
  const signer: MerchantRenewalSigner = { async signExactIntent(input) { signed++; return { signature: await merchant.signTypedData(input.typedData), providerRequestId: `synthetic-local-signature-${signed}` }; } };
  const serviceFor = () => new FundedRenewals(db, chain, { mode: 'local-fork', localFork: bundle.capability, reader: bundle.reader, signer, localGasBudgetWei: 10n ** 17n });
  let service = serviceFor();
  const grant: RenewalGrant = { version: 1, merchantId: keys.merchantId, merchant: merchant.address, subscriptionId: sub.id,
    binding: { appId: 'synthetic-local', userId: 'synthetic-local', walletId: 'synthetic-merchant', signerId: 'fixture-only', policyId: 'local-exact-charge', policyHash: keccak256(toHex('local-fork-no-privy-authority')) },
    chainId: 1874, router: addresses.router, manager: addresses.subscription, token: RENEWAL_USDT, chainSubscriptionId: sub.chainId, mandate, mandateHash: hashTypedData(typed),
    dataHash: keccak256(encodeFunctionData({ abi: v2.abi, functionName: 'charge', args: [sub.chainId, 1_000_000n] })), amount: 1_000_000n,
    validFrom: start, validUntil: mandate.endTime, maxFeeUSDT: 10000n, maxGas: 400000, maxGasPriceWei: 10_000_000_000n, maxTransactionCostWei: 10n ** 16n, maxTotalGasWei: 10n ** 17n,
    maxCalls: 3, maxCallsPerDay: 1, maxFeesPerDay: 10000n, maxFeesTotal: 30000n, maxSigningRevisions: 3, acceptance: { kind: 'synthetic-local', reference: 'owned Anvil capability; not Privy delegation' } };
  service.installSyntheticGrant(grant);
  const quote = await new Relayer(chain, addresses.router, allowedTargets(addresses.escrow, addresses.subscription, 2)).quote(grant.maxGas);
  assert.equal(quote.usdtPerWbtMinor, '2000000'); proof.routerQuote = quote;
  assert.equal(service.chain.writer, chain.writer);
  assert.throws(() => new FundedRenewals(db, chain, { mode: 'local-fork', localFork: { ...bundle.capability }, reader: bundle.reader, localGasBudgetWei: 1n }), /invalid local-fork capability/);
  assert.throws(() => new FundedRenewals(db, chain, { mode: 'local-fork', localFork: bundle.capability, reader: { read: bundle.reader.read.bind(bundle.reader) }, localGasBudgetWei: 1n }), /invalid local-fork capability/);
  const feeVault = await pub.readContract({ address: addresses.router, abi: routerAbi, functionName: 'feeVault' }) as Address;
  async function balances() {
    const [payerUsdt, merchantUsdt, feeUsdt, tank, relayerWbt, payerWbt] = await Promise.all([
      ...[payer.address, merchant.address, feeVault].map(address => pub.readContract({ address: RENEWAL_USDT, abi: erc20Abi, functionName: 'balanceOf', args: [address] })),
      pub.readContract({ address: addresses.gasTank, abi: gasTankAbi, functionName: 'balanceOf', args: [merchant.address] }) as Promise<bigint>,
      pub.getBalance({ address: localRenewalRelayer }), pub.getBalance({ address: payer.address }),
    ]);
    return { payerUsdt, merchantUsdt, feeUsdt, tank, relayerWbt, payerWbt };
  }
  const before = await balances();
  await runKeeper(db, chain, new Date(clock), service);
  const first = service.store.status(sub.id); assert.equal(first.state, 'pending'); assert(first.txHash);
  const firstReceipt = await receipt(first.txHash);
  await indexer.poll(); assert.equal(service.store.status(sub.id).state, 'pending', 'Requires successor blocks');
  await mine(); await indexer.poll();
  assert.equal(service.store.status(sub.id).state, 'confirmed');
  const after = await balances(), decoded = await chain.receipt(first.txHash); assert(decoded);
  const executed = decoded.events.find(e => e.contract === 'router' && e.name === 'Executed')!;
  const reimbursed = decoded.events.find(e => e.contract === 'gasTank' && e.name === 'Reimbursed')!;
  assert(decoded.events.some(e => e.name === 'Charged' && Number(e.args.period) === 1)); assert(executed && reimbursed);
  const reimbursement = BigInt(executed.args.reimbursement);
  assert.equal(reimbursement, BigInt(reimbursed.args.amount)); assert(reimbursement > 0n);
  assert.equal(before.payerUsdt - after.payerUsdt, 1_000_000n);
  assert.equal(after.merchantUsdt - before.merchantUsdt, 990_000n);
  assert.equal(after.feeUsdt - before.feeUsdt, 10_000n);
  assert.equal(before.tank - after.tank, reimbursement);
  assert.equal(after.relayerWbt - before.relayerWbt, reimbursement - firstReceipt.gasUsed * firstReceipt.effectiveGasPrice);
  assert.equal(after.payerWbt, 0n);
  proof.first = { rawReceipt: firstReceipt, transaction: await pub.getTransaction({ hash: first.txHash }), hash: first.txHash, block: firstReceipt.blockNumber, events: decoded.events, before, after, gasUsed: firstReceipt.gasUsed, gasPrice: firstReceipt.effectiveGasPrice };
  check('real funded success: Charged/Executed/Reimbursed + payer, merchant, feeVault, GasTank and relayer balance deltas; payer 0 WBT');
  const oldRequestRaw = (db.prepare('SELECT request_json FROM intents WHERE id=?').get(first.operationId) as any).request_json;
  const oldRequest = JSON.parse(oldRequestRaw) as IntentRequest;
  for (const key of ['amount', 'feeUSDT', 'nonce', 'deadline'] as const) oldRequest.intent[key] = BigInt(oldRequest.intent[key]);
  assert.equal(await pub.readContract({ address: addresses.router, abi: routerAbi, functionName: 'usedNonces', args: [merchant.address, oldRequest.intent.nonce] }), true);
  assert.equal((await chain.simulate(oldRequest, { gas: transactionGas(oldRequest), gasPrice: await chain.gasPrice() })).accepted, false);
  await assert.rejects(service.renew(sub.id), /renewal_not_due/);
  assert.equal(signed, 1); check('real Router replay simulation refused; due guard requests no second signature/send');

  const state = await bundle.reader.read(grant);
  await syncClock(state.subscription.nextChargeAt + 1n);
  const originalBroadcast = chain.broadcastTransaction.bind(chain);
  let crash: Buffer | undefined, sends = 0;
  chain.broadcastTransaction = async raw => {
    sends++;
    crash = db.serialize(); // broadcasting identity persisted BEFORE transport.
    await originalBroadcast(raw);
    throw new Error('synthetic accepted-but-timeout');
  };
  const secondBefore = await balances();
  const second = await service.renew(sub.id); assert.equal(second.state, 'pending'); assert(second.txHash); assert(crash);
  const secondReceipt = await receipt(second.txHash);
  assert.equal(chain.writer.record(second.operationId!)!.phase, 'uncertain');
  const oldDb = db; db = new Database(crash); oldDb.close();
  bundle = await fork.createChain(addresses); chain = bundle.chain; chain.writer.bind(db);
  let restartedSends = 0;
  const restartedBroadcast = chain.broadcastTransaction.bind(chain);
  chain.broadcastTransaction = async raw => { restartedSends++; return restartedBroadcast(raw); };
  service = serviceFor(); app = makeApp(); indexer = new Indexer(db, chain, deployed.blockNumber);
  db.prepare("UPDATE renewal_service_status SET operation_id=NULL,state='disabled' WHERE subscription_id=?").run(sub.id);
  const held = chain.writer.record(second.operationId!)!;
  const disabled = await new FundedRenewals(db, chain).renew(sub.id);
  assert.equal(disabled.state, 'pending'); assert.equal(disabled.txHash, second.txHash); assert.equal(disabled.automatic, 'disabled');
  assert.deepEqual(chain.writer.record(second.operationId!), held);
  await indexer.poll();
  assert.equal(service.store.status(sub.id).state, 'pending');
  await assert.rejects(service.renew(sub.id), /subscription_pending/);
  await mine(); await indexer.poll(); await indexer.poll();
  assert.equal(service.store.status(sub.id).state, 'confirmed');
  assert.equal(sends, 1); assert.equal(restartedSends, 0); assert.equal(signed, 2);
  const secondAfter = await balances(); assert.equal(secondBefore.payerUsdt - secondAfter.payerUsdt, 1_000_000n);
  const secondDecoded = await chain.receipt(second.txHash); assert(secondDecoded); assert(secondDecoded.events.some(e => e.name === 'Charged' && Number(e.args.period) === 2));
  proof.second = { rawReceipt: secondReceipt, transaction: await pub.getTransaction({ hash: second.txHash }), hash: second.txHash, crashPhase: 'broadcasting', sends, restartedSends, before: secondBefore, after: secondAfter, events: secondDecoded.events };
  check('real accepted-but-timeout/crash/restart: journal preserved local hash, waited depth, settled period 2 exactly once, no resend');
  await syncClock();
  const cancelDeadline = BigInt(Math.floor(clock / 1000)) + 120n;
  const cancellation = await post(`/v1/subscriptions/${sub.id}/cancel`, { deadline: cancelDeadline, signature: await payer.signTypedData(cancellationTypedData(sub.chainId, cancelDeadline, addresses.subscription)) });
  const cancellationReceipt = await receipt(cancellation.txHash); await mine(); await indexer.poll();
  assert.equal((await bundle.reader.read(grant)).subscription.cancelled, true);
  assert.equal((db.prepare('SELECT status FROM subscriptions WHERE id=?').get(sub.id) as any).status, 'cancelled');
  await assert.rejects(service.renew(sub.id), /subscription_unavailable/);
  const calls = restartedSends;
  await runKeeper(db, chain, new Date(clock + 86400_000), service); assert.equal(restartedSends, calls);
  assert.equal(signed, 2); assert.equal(await pub.getBalance({ address: payer.address }), 0n);
  proof.cancellation = { rawReceipt: cancellationReceipt, hash: cancellation.txHash, writer: chain.writer.rows(), status: 'cancelled' };
  check('real signed payer cancellation uses same writer after recovery; cancelled keeper never signs or sends again');
  const savedCapability = bundle.capability;
  await fork.close();
  assert.throws(() => new FundedRenewals(db, chain, { mode: 'local-fork', localFork: savedCapability, reader: bundle.reader, signer, localGasBudgetWei: 1n }), /invalid local-fork capability/);
  check('capability invalid after owned Anvil exits; no attachment to an existing or live RPC');
  proof.checks = checks;
  writeFileSync('/tmp/gol-funded-renewal-fork-evidence.json', JSON.stringify(proof, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  console.log('Evidence: /tmp/gol-funded-renewal-fork-evidence.json');
} finally { Date.now = actualNow; db.close(); await fork.close(); }
