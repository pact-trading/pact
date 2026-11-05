// Official-USDT live checkout verification. Read-only unless LIVE_EXECUTE=1.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { openDb, seedMerchant } from '../src/db.js';
import { createApp } from '../src/app.js';
import { Indexer } from '../src/indexer.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { intentTypedData } from '../src/typed-data.js';
import { parseEnv } from 'node:util';
import { encodeFunctionData, keccak256, toHex, createPublicClient, createWalletClient, decodeEventLog, defineChain, http, parseAbi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ViemChain, routerAbi, escrowAbi, gasTankAbi } from '../src/chain.js';

const env = process.env.WALLET_ENV_PATH ? parseEnv(readFileSync(process.env.WALLET_ENV_PATH, 'utf8')) : process.env;
const merchant = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex);
const payer = privateKeyToAccount(env.PAYER_PRIVATE_KEY as Hex);
const relayer = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as Hex);
// Existing official-USDT deployment: p2-checkout/README.md and api/example.env.
const addresses = {
  router: '0x014BC0e127D4660a3ef369a9d71a57e727a7D34f',
  escrow: '0x3D2dA701266ece5098aE7B907DB1A56ca6a434C1',
  subscription: '0xAAB13cEfEb4291842439Bb958F54C11459e09573',
  gasTank: '0xd9e61f3Ed690A1c17E7b0AA85743c73FB4fD2A1C',
} as const;
const token = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7';
const chain = defineChain({ id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.whitechain.io'] } }, testnet: true });
const pub = createPublicClient({ chain, transport: http() });
const erc = parseAbi(['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256)']);
const json = (value: unknown) => JSON.stringify(value, (_, x: unknown) => typeof x === 'bigint' ? x.toString() : x, 2);
assert.equal(await pub.getChainId(), 1874);
assert.equal(await pub.readContract({ address: token, abi: erc, functionName: 'decimals' }), 6);
for (const address of Object.values(addresses)) assert.ok((await pub.getCode({ address }))?.length! > 2, `No contract at ${address}`);
for (const address of [addresses.router, addresses.escrow]) assert.equal(String(await pub.readContract({ address, abi: address === addresses.router ? routerAbi : escrowAbi, functionName: 'usdt' })).toLowerCase(), token.toLowerCase());
const readRouter = (functionName: string) => pub.readContract({ address: addresses.router, abi: routerAbi, functionName });
const settings = Object.fromEntries(await Promise.all(['owner', 'minAmount', 'usdtPerWBT', 'maxPayerCallsPerDay', 'maxGasPerCall', 'maxGasPrice'].map(async name => [name, await readRouter(name)])));
async function balances() {
  return Object.fromEntries(await Promise.all(Object.entries({ merchant, payer, relayer }).map(async ([role, account]) => [role, { address: account.address, wbtWei: await pub.getBalance({ address: account.address }), usdtMinor: await pub.readContract({ address: token, abi: erc, functionName: 'balanceOf', args: [account.address] }) }])));
}
const before = await balances();
const allowances = await Promise.all([[payer.address, addresses.escrow], [merchant.address, addresses.escrow], [merchant.address, addresses.router]].map(async ([owner, spender]) => ({ owner, spender, amount: await pub.readContract({ address: token, abi: erc, functionName: 'allowance', args: [owner as Hex, spender as Hex] }) })));
const tank = await Promise.all(['balanceOf', 'dailyCap', 'dailySpend'].map(functionName => pub.readContract({ address: addresses.gasTank, abi: gasTankAbi, functionName, args: [merchant.address] })));
console.log(json({ phase: 'preflight', block: await pub.getBlockNumber(), chainId: 1874, before, settings, allowances, tank, gasPrice: await pub.getGasPrice() }));
const originalHash = '0xd5c1eaa394dd07259ee57214fef93e6d922df09198bf73496c83be60f51c6c3b';
const original = await pub.getTransaction({ hash: originalHash });
const receipt = await pub.getTransactionReceipt({ hash: originalHash });
console.log(json({ phase: 'original-refusal', hash: originalHash, gas: original.gas, gasUsed: receipt.gasUsed, status: receipt.status, events: receipt.logs.filter(l => l.address.toLowerCase() === addresses.router.toLowerCase()).map(l => decodeEventLog({ abi: routerAbi, data: l.data, topics: l.topics })) }));
if (process.env.LIVE_EXECUTE !== '1') process.exit(0);
// This is the main-checkout draft's API lifecycle, strengthened with fail-fast
// HTTP checks, exact receipt/event assertions, isolated state and cleanup.
assert.equal(String(settings.owner).toLowerCase(), merchant.address.toLowerCase());
assert.ok(before.payer.usdtMinor >= 1_000_000n);
assert.ok(before.merchant.usdtMinor >= 520_000n);
const port = Number(process.env.LIVE_API_PORT ?? '3002');
assert.ok(port !== 3000 && port !== 3001, 'Keep UI and main API ports available');
const directory = mkdtempSync(join(tmpdir(), 'settle-live-api-'));
const db = openDb(join(directory, 'settle.sqlite'));
const keys = seedMerchant(db, merchant.address);
const adapter = new ViemChain(chain.rpcUrls.default.http[0], env.RELAYER_PRIVATE_KEY as Hex, addresses);
const limits = { minAmount: 500_000n, maxGas: 1_000_000n, maxGasPrice: 100_000_000_000n, maxSpendPerMinute: 10_000_000_000_000_000n };
const sponsored = new Relayer(adapter, addresses.router, allowedTargets(addresses.escrow, addresses.subscription), limits);
const app = createApp({ db, chain: adapter, relayer: sponsored, ...addresses });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port });
await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
const indexer = new Indexer(db, adapter, await pub.getBlockNumber(), 2n);
const transactions: Record<string, Hex> = {};
const report: Record<string, unknown> = { directory, port, chainId: 1874, token, addresses, before, transactions };
const checkpoint = () => writeFileSync(join(directory, 'result.json'), json(report));
checkpoint();
console.log(json({ phase: 'isolated-api', directory, port }));
const wallet = createWalletClient({ account: merchant, chain, transport: http() });
async function confirmed(label: string, hash: Hex) {
  transactions[label] = hash; checkpoint();
  console.log(json({ phase: label, hash }));
  const result = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  assert.equal(result.status, 'success', `${label} reverted: ${hash}`);
  return result;
}
async function setMinimum(value: bigint, label: string) {
  const hash = await wallet.writeContract({ address: addresses.router, abi: routerAbi, functionName: 'setLimits', args: [value, settings.usdtPerWBT, settings.maxPayerCallsPerDay, settings.maxGasPerCall, settings.maxGasPrice] });
  await confirmed(label, hash);
  assert.equal(await readRouter('minAmount'), value);
}
async function call(path: string, key: string, body?: unknown): Promise<Record<string, any>> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : json(body) });
  const data = await response.json() as Record<string, any>;
  assert.equal(response.status, 200, `${path}: ${json(data)}`);
  return data;
}
let nonce = BigInt(Date.now());
async function signed(account: typeof merchant, data: Hex, amount: bigint) {
  const intent = { signer: account.address, merchant: merchant.address, target: addresses.escrow, dataHash: keccak256(data), amount, feeUSDT: 10_000n, nonce: nonce++, deadline: BigInt(Math.floor(Date.now()/1000) + 3600), maxGas: 400_000 };
  return { intent, data, signature: await account.signTypedData(intentTypedData(intent, addresses.router)) };
}
async function paymentStatus(id: string, financialStatus: string) {
  for (let attempt = 0; attempt < 60; attempt++) {
    await indexer.poll();
    const payment = await call(`/v1/payments/${id}`, keys.secretKey);
    if (payment.financialStatus === financialStatus) return payment;
    assert.notEqual(payment.financialStatus, 'failed', json(payment));
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${financialStatus}`);
}
async function verifyExecution(label: string, hash: Hex, eventName: string, paymentId: Hex, amount: bigint) {
  const receipt = await confirmed(label, hash);
  const events = receipt.logs.flatMap(log => {
    const abi = log.address.toLowerCase() === addresses.router.toLowerCase() ? routerAbi : log.address.toLowerCase() === addresses.escrow.toLowerCase() ? escrowAbi : null;
    if (!abi) return [];
    try { return [decodeEventLog({ abi, data: log.data, topics: log.topics })]; } catch { return []; }
  });
  assert.ok(events.some(event => event.eventName === 'Executed'), 'Missing Router Executed');
  assert.ok(!events.some(event => event.eventName === 'Refused'), 'Router Refused');
  const event = events.find(event => event.eventName === eventName);
  assert.ok(event, `Missing ${eventName}`);
  const args = event.args as unknown as { id: Hex; amount: bigint };
  assert.equal(args.id, paymentId); assert.equal(args.amount, amount);
  const tx = await pub.getTransaction({ hash });
  report[label] = { hash, block: receipt.blockNumber, gas: tx.gas, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, events };
  checkpoint();
}
let minimumChanged = false;
try {
  // Existing allowances are sufficient in the funded deployment. Only approve
  // a missing amount; never mint, fund other wallets or deploy contracts.
  for (const [owner, spender, required] of [[payer, addresses.escrow, 1_000_000n], [merchant, addresses.escrow, 500_000n], [merchant, addresses.router, 20_000n]] as const) {
    const allowance = await pub.readContract({ address: token, abi: erc, functionName: 'allowance', args: [owner.address, spender] });
    if (allowance < required) {
      const client = createWalletClient({ account: owner, chain, transport: http() });
      if (allowance !== 0n) await confirmed(`approval-reset-${owner.address}-${spender}`, await client.writeContract({ address: token, abi: erc, functionName: 'approve', args: [spender, 0n] }));
      await confirmed(`approval-${owner.address}-${spender}`, await client.writeContract({ address: token, abi: erc, functionName: 'approve', args: [spender, required] }));
    }
  }
  if (BigInt(String(settings.minAmount)) > 500_000n) {
    // Mark before broadcasting so cleanup also runs after an uncertain RPC result.
    minimumChanged = true;
    await setMinimum(500_000n, 'configure-minimum');
  }
  const config = await call('/v1/config', keys.publishableKey);
  assert.equal(config.router, addresses.router); assert.equal(config.escrow, addresses.escrow);
  const payment = await call('/v1/payments', keys.secretKey, { amount: '1.000000', email: 'buyer@example.com', description: 'Official USDT backend verification' });
  const paymentId = payment.id as Hex;
  report.paymentId = paymentId; checkpoint();
  const chargeData = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [paymentId, merchant.address, 1_000_000n, 2_592_000n] });
  const charge = await call('/v1/intents', keys.publishableKey, await signed(payer, chargeData, 1_000_000n));
  await verifyExecution('charge', charge.txHash, 'Charged', paymentId, 1_000_000n);
  report.captured = await paymentStatus(paymentId, 'captured'); checkpoint();
  const refundData = encodeFunctionData({ abi: escrowAbi, functionName: 'refund', args: [paymentId, 500_000n, keccak256(toHex('Customer request'))] });
  const refund = await call(`/v1/payments/${paymentId}/refund`, keys.secretKey, { amount: '0.500000', reason: 'Customer request', ...await signed(merchant, refundData, 500_000n) });
  await verifyExecution('refund', refund.txHash, 'Refunded', paymentId, 500_000n);
  const final = await paymentStatus(paymentId, 'partially_refunded');
  assert.equal(final.status, 'succeeded'); assert.equal(final.captured, '1.000000'); assert.equal(final.refunded, '0.500000');
  const refunds = await call('/v1/refunds', keys.secretKey);
  assert.equal(refunds.data.find((item: { id: string }) => item.id === refund.id).status, 'succeeded');
  const exported = await call('/v1/export', keys.secretKey);
  assert.equal(exported.totals.netUSDT, '0.480000');
  const paymentOnchain = await pub.readContract({ address: addresses.escrow, abi: escrowAbi, functionName: 'payments', args: [paymentId] }) as readonly unknown[];
  assert.equal(paymentOnchain[3], 1_000_000n); assert.equal(paymentOnchain[4], 500_000n);
  report.final = final; report.refunds = refunds; report.export = exported; report.paymentOnchain = paymentOnchain;
  report.intents = db.prepare('SELECT id,status,reason,tx_hash FROM intents').all();
  assert.ok((report.intents as {status:string}[]).every(intent => intent.status === 'confirmed'));
  report.after = await balances();
  assert.equal((report.after as typeof before).payer.usdtMinor, before.payer.usdtMinor - 500_000n);
  assert.equal((report.after as typeof before).payer.wbtWei, before.payer.wbtWei);
  report.success = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  try {
    if (minimumChanged) await setMinimum(BigInt(String(settings.minAmount)), 'restore-minimum');
    report.restoredMinimum = await readRouter('minAmount');
  } finally {
    checkpoint(); console.log(json(report));
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  }
}
