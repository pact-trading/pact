import assert from 'node:assert/strict';
import { encodeFunctionData, keccak256, parseUnits, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { escrowAbi } from '../src/chain.js';
import { cancellationTypedData, intentTypedData, mandateTypedData } from '../src/typed-data.js';
const merchant = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const payer = privateKeyToAccount(`0x${'2'.repeat(64)}`);
const base = process.env.E2E_URL!;
const secret = process.env.E2E_SECRET!;
const publishable = process.env.E2E_PUBLISHABLE!;
const json = (value: unknown) => JSON.stringify(value, (_, x: unknown) => typeof x === 'bigint' ? x.toString() : x);
async function call(path: string, key: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? json(body) : undefined });
  return { status: response.status, data: await response.json() as Record<string, any> };
}
const config = (await call('/v1/config', publishable)).data as { merchant: Address; router: Address; escrow: Address; subscription: Address };
const create = await call('/v1/payments', secret, { amount: '4.000000', email: 'buyer@example.com', description: 'E2E purchase' });
assert.equal(create.status, 200);
const paymentId = create.data.id as Hex;
let nonce = 1n;
async function signed(account: typeof merchant, data: Hex, amount: bigint) {
  const intent = { signer: account.address, merchant: config.merchant, target: config.escrow, dataHash: keccak256(data), amount, nonce: nonce++, deadline: BigInt(Math.floor(Date.now()/1000)+3600), maxGas: 300000 };
  const signature = await account.signTypedData(intentTypedData(intent, config.router));
  return { intent, signature, data };
}
const charge = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [paymentId, config.merchant, parseUnits('4',6), 2_592_000n] });
assert.equal((await call('/v1/intents', publishable, await signed(payer, charge, parseUnits('4',6)))).status, 200);
const captured = await call(`/v1/payments/${paymentId}`, publishable);
assert.equal(captured.data.financialStatus, 'captured');
assert.match(captured.data.txHash, /^0x[0-9a-f]{64}$/i);
// Pact's fee came out of the payment: 0.8% of 4 USDT is under the 0.15 USDT minimum.
const ledger = (await call('/v1/fees/ledger', secret)).data.data as Array<{ objectId: string; feeUsdt: string; netUsdt: string }>;
assert.deepEqual(ledger.filter(entry => entry.objectId === paymentId).map(entry => [entry.feeUsdt, entry.netUsdt]), [['0.150000', '3.850000']]);
async function refund(amount: string) {
  const data = encodeFunctionData({ abi: escrowAbi, functionName: 'refund', args: [paymentId, parseUnits(amount,6), keccak256(toHex('Customer request'))] });
  return call(`/v1/payments/${paymentId}/refund`, secret, { amount, reason: 'Customer request', ...await signed(merchant, data, parseUnits(amount,6)) });
}
const firstRefund = await refund('1.000000'); assert.equal(firstRefund.status, 200, JSON.stringify(firstRefund.data));
assert.equal((await call(`/v1/payments/${paymentId}`, secret)).data.financialStatus, 'partially_refunded');
assert.equal((await refund('3.000000')).status, 200);
const full = await call(`/v1/payments/${paymentId}`, secret);
assert.equal(full.data.financialStatus, 'refunded');
assert.equal(full.data.refunded, '4.000000');
const third = await refund('1.000000');
assert.equal(third.status, 422);
assert.equal(third.data.error.code, 'refund_limit');
const refunds = await call('/v1/refunds', secret);
assert.equal(refunds.data.data.length, 2);
assert.ok(refunds.data.data.every((item: {status:string}) => item.status === 'succeeded'));
const plan = await call('/v1/subscriptions/plans', secret, { name: 'Studio care', amount: '2.000000', periodSeconds: 86400, maxPeriods: 3 });
assert.equal(plan.status, 200);
const planId = plan.data.id as string;
const publishedPlan = await call(`/v1/subscriptions/plans/${planId}`, publishable);
assert.equal(publishedPlan.status, 200);
assert.equal(publishedPlan.data.name, 'Studio care');
assert.equal(publishedPlan.data.maxPeriods, 3);
const { nonce: mandateNonce } = (await call(`/v1/subscriptions/nonce/${payer.address}`, publishable)).data;
const mandate = { payer: payer.address, merchant: config.merchant, planId: keccak256(toHex(planId)), amountCap: parseUnits('2', 6), periodSeconds: 86400n, maxPeriods: 3, endTime: BigInt(Math.floor(Date.now() / 1000) + 86400 * 4), nonce: BigInt(mandateNonce) };
const mandateSignature = await payer.signTypedData(mandateTypedData(mandate, config.subscription));
const subscription = await call('/v1/subscriptions', publishable, { planId, mandate, signature: mandateSignature });
assert.equal(subscription.status, 200);
const subscriptionId = subscription.data.id as string;
assert.equal((await call('/v1/subscriptions', secret)).data.data.find((item: {id:string}) => item.id === subscriptionId).status, 'active');
const renewal = await call(`/v1/subscriptions/${subscriptionId}/renew`, secret, {});
assert.equal(renewal.status, 200);
assert.equal(renewal.data.status, 'charged');
// The payer cancels by signature; Pact's relayer submits it, so neither side pays.
const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
const cancelSignature = await payer.signTypedData(cancellationTypedData(subscription.data.chainId as Hex, deadline, config.subscription));
const cancelled = await call(`/v1/subscriptions/${subscriptionId}/cancel`, publishable, { deadline: deadline.toString(), signature: cancelSignature });
assert.equal(cancelled.status, 200);
assert.equal((await call('/v1/subscriptions', secret)).data.data.find((item: {id:string}) => item.id === subscriptionId).status, 'cancelled');
// A renewal after cancelling goes to the contract, which refuses it and says why.
const afterCancel = await call(`/v1/subscriptions/${subscriptionId}/renew`, secret, {});
assert.equal(afterCancel.status, 200);
assert.equal(afterCancel.data.status, 'refused');
assert.equal(afterCancel.data.refusal, 'cancelled');
const reasons = (await call('/v1/refusals', secret)).data.data.filter((item: {objectId:string}) => item.objectId === subscriptionId).map((item: {reason:string}) => item.reason);
assert.deepEqual(new Set(reasons), new Set(['cancelled']));
console.log(json({ paymentId, status: full.data.financialStatus, refunded: full.data.refunded, refundCount: 2, thirdRefund: third.data.error.code, planId, subscriptionId, renewal: renewal.data.status, refusalReasons: reasons, subscriptionStatus: 'cancelled' }));
