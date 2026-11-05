// Exercise the configured API with the existing gasless payer. No policy changes or funding.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { createPublicClient, decodeEventLog, encodeFunctionData, http, keccak256, parseAbi, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { escrowAbi, gasTankAbi, routerAbi } from '../src/chain.js';
import { intentTypedData } from '../src/typed-data.js';

const deployment = JSON.parse(readFileSync(new URL('../../../contracts/deployment.json', import.meta.url), 'utf8'));
const runtime = JSON.parse(readFileSync(new URL('../.runtime/whitechain-v2/runtime.json', import.meta.url), 'utf8'));
const secrets = parseEnv(readFileSync(new URL('../../../.env.wallets', import.meta.url), 'utf8'));
const payer = privateKeyToAccount(secrets.GASLESS_PAYER_PRIVATE_KEY as Hex);
const merchant = privateKeyToAccount(secrets.DEPLOYER_PRIVATE_KEY as Hex);
const pub = createPublicClient({ transport: http('https://rpc.testnet.whitechain.io') });
const token = deployment.token as Address;
const A = deployment.contracts as Record<string, Address>;
const base = process.env.ACTIVATION_API_URL ?? 'http://127.0.0.1:3002';
assert(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base), 'Smoke credentials may only be sent to the local API');
const erc = parseAbi(['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)']);
const json = (value: unknown) => JSON.stringify(value, (_, v: unknown) => typeof v === 'bigint' ? String(v) : v, 2);
async function api(path: string, body?: unknown, publishable = false): Promise<any> {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${publishable ? runtime.credentials.publishableKey : runtime.credentials.secretKey}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : json(body) });
  const result = await response.json();
  assert.equal(response.status, 200, `${path}: ${json(result)}`); return result;
}
const config = await api('/v1/config', undefined, true);
for (const [field, contract] of [['router', 'Router'], ['escrow', 'PaymentEscrow'], ['subscription', 'SubscriptionManager']]) assert.equal(config[field].toLowerCase(), A[contract].toLowerCase());
assert.equal(config.merchant.toLowerCase(), merchant.address.toLowerCase());
assert.equal(await pub.getChainId(), 1874);
assert.equal(await pub.readContract({ address: A.Router, abi: routerAbi, functionName: 'minAmount' }), 1_000_000n);
const balance = (owner: Address) => pub.readContract({ address: token, abi: erc, functionName: 'balanceOf', args: [owner] });
const before = { payer: await balance(payer.address), merchant: await balance(merchant.address), payerWbt: await pub.getBalance({ address: payer.address }), tank: await pub.readContract({ address: A.GasTank, abi: gasTankAbi, functionName: 'balanceOf', args: [merchant.address] }) as bigint };
assert.equal(before.payerWbt, 0n); assert(before.payer >= 2_000_000n);
assert(await pub.readContract({ address: token, abi: erc, functionName: 'allowance', args: [payer.address, A.PaymentEscrow] }) >= 2_000_000n);
console.log(json({ phase: 'preflight', api: base, router: config.router, payer: payer.address, before }));
if (process.env.ACTIVATION_SMOKE_EXECUTE !== '1') process.exit(0);
const reportPath = new URL('../../../contracts/activation-smoke.json', import.meta.url);
assert(!existsSync(reportPath), 'Smoke journal exists. Reconcile existing transactions instead of charging twice.');
const report: Record<string, any> = { status: 'in_progress', startedAt: new Date().toISOString(), chainId: 1874, contracts: A, payer: payer.address, merchant: merchant.address, before, transactions: [] };
const save = () => writeFileSync(reportPath, json(report) + '\n'); save();
let nonce = BigInt(Date.now());
async function signed(account: typeof payer, data: Hex, amount: bigint) {
  const intent = { signer: account.address, merchant: merchant.address, target: A.PaymentEscrow, dataHash: keccak256(data), amount, feeUSDT: 10_000n, nonce: nonce++, deadline: BigInt(Math.floor(Date.now() / 1000) + 1800), maxGas: 400_000 };
  return { intent, data, signature: await account.signTypedData(intentTypedData(intent, A.Router)) };
}
async function confirmed(label: string, hash: Hex, eventName: string, paymentId: Hex, amount: bigint, signer: Address, intentNonce: bigint) {
  const entry: Record<string, any> = { label, hash, status: 'submitted' }; report.transactions.push(entry); save();
  const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 180_000 });
  assert.equal(receipt.status, 'success');
  const logs = receipt.logs.flatMap(log => {
    const abi = log.address.toLowerCase() === A.Router.toLowerCase() ? routerAbi : log.address.toLowerCase() === A.PaymentEscrow.toLowerCase() ? escrowAbi : null;
    if (!abi) return [];
    try { return [decodeEventLog({ abi, data: log.data, topics: log.topics }) as any]; } catch { return []; }
  });
  const executed = logs.find(log => log.eventName === 'Executed');
  assert(executed); assert(!logs.some(log => log.eventName === 'Refused'));
  assert.equal(executed.args.signer.toLowerCase(), signer.toLowerCase());
  assert.equal(executed.args.merchant.toLowerCase(), merchant.address.toLowerCase());
  assert.equal(executed.args.nonce, intentNonce); assert.equal(executed.args.feeUSDT, 10_000n);
  const settlement = logs.find(log => log.eventName === eventName);
  assert(settlement); assert.equal(settlement.args.id, paymentId); assert.equal(settlement.args.amount, amount);
  Object.assign(entry, { status: 'success', block: receipt.blockNumber, gasUsed: receipt.gasUsed, gasPrice: receipt.effectiveGasPrice, networkFeeWei: receipt.gasUsed * receipt.effectiveGasPrice + BigInt((receipt as typeof receipt & { l1Fee?: Hex }).l1Fee ?? 0), reimbursementWei: executed.args.reimbursement, feeUsdtMinor: executed.args.feeUSDT }); save();
  console.log(`${label}: confirmed ${hash}`);
}
async function indexed(id: Hex, wanted: string) {
  for (let attempt = 0; attempt < 90; attempt++) {
    const payment = await api(`/v1/payments/${id}`);
    if (payment.financialStatus === wanted) return payment;
    assert.notEqual(payment.financialStatus, 'failed', 'Payment attempt failed');
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`API did not index ${wanted}`);
}
const payment = await api('/v1/payments', { amount: '2.000000', description: 'New suite activation · gasless payment', email: 'activation@example.test' });
const paymentId = payment.id as Hex; report.paymentId = paymentId; save();
const charge = await signed(payer, encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [paymentId, merchant.address, 2_000_000n, 2_592_000n] }), 2_000_000n);
const submitted = await api('/v1/intents', charge, true);
await confirmed('charge', submitted.txHash, 'Charged', paymentId, 2_000_000n, payer.address, charge.intent.nonce);
report.captured = await indexed(paymentId, 'captured'); save();
const reason = 'Activation verification';
const refund = await signed(merchant, encodeFunctionData({ abi: escrowAbi, functionName: 'refund', args: [paymentId, 1_000_000n, keccak256(toHex(reason))] }), 1_000_000n);
const submittedRefund = await api(`/v1/payments/${paymentId}/refund`, { amount: '1.000000', reason, ...refund });
await confirmed('refund', submittedRefund.txHash, 'Refunded', paymentId, 1_000_000n, merchant.address, refund.intent.nonce);
report.payment = await indexed(paymentId, 'partially_refunded');
assert.equal(report.payment.status, 'succeeded'); assert.equal(report.payment.captured, '2.000000'); assert.equal(report.payment.refunded, '1.000000');
report.export = await api('/v1/export'); assert.equal(report.export.totals.netUSDT, '0.980000');
report.after = { payer: await balance(payer.address), merchant: await balance(merchant.address), payerWbt: await pub.getBalance({ address: payer.address }), tank: await pub.readContract({ address: A.GasTank, abi: gasTankAbi, functionName: 'balanceOf', args: [merchant.address] }) as bigint };
assert.equal(report.after.payer, before.payer - 1_000_000n);
// Fee vault is the merchant itself: fees are self-transfers, unlike the fee-adjusted export.
assert.equal(report.after.merchant, before.merchant + 1_000_000n);
assert.equal(report.after.payerWbt, 0n);
assert.equal(before.tank - report.after.tank, report.transactions.reduce((sum: bigint, tx: any) => sum + tx.reimbursementWei, 0n));
report.status = 'verified'; report.completedAt = new Date().toISOString(); save();
console.log(json({ status: report.status, paymentId, captured: '2.000000', refunded: '1.000000', payerWbt: '0', exportNetUsdt: '0.980000' }));
