// End-to-end invoice financing on a local fork, through the running API, with real contracts and wallets:
//   1. a merchant lists an acknowledged invoice from its wallet;
//   2. an unapproved investor is refused; a compliance officer approves two investors in the registry;
//   3. they buy it (delivery versus payment) and one transfers part to the other;
//   4. the customer pays through the usual gasless flow (relayed approval, Router), and the contract pays
//      the holders straight away and returns the reserve to the merchant.
// With --time-travel (an isolated stack only: it moves the fork's clock for good), a second invoice
// defaults after its grace period, the keeper marks it, and the merchant buys it back.
//
//   pnpm live --no-web                                          (or an isolated stack, see docs/live-mode.md)
//   API=http://127.0.0.1:3001 RPC=http://127.0.0.1:8545 tsx scripts/live/financing-flow.ts [--time-travel]
import assert from 'node:assert/strict';
import {
  createPublicClient, createWalletClient, defineChain, erc20Abi, http, maxUint256, parseAbi, parseEther,
  type Address, type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';

const API = process.env.API ?? 'http://127.0.0.1:3001';
const RPC = process.env.RPC ?? 'http://127.0.0.1:8545';
const timeTravel = process.argv.includes('--time-travel');
const USDT = 1_000_000n;
const chain = defineChain({ id: 1874, name: 'Whitechain Sepolia (local fork)', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
const pub = createPublicClient({ chain, transport: http(RPC), pollingInterval: 250 });
const step = (message: string) => console.info(`[financing] ${message}`);

type Body = Record<string, any>;
async function request(path: string, token: string, body?: unknown): Promise<{ status: number; body: Body }> {
  const r = await fetch(`${API}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() as Body };
}
async function call(path: string, token: string, body?: unknown) {
  const r = await request(path, token, body);
  if (r.status >= 300) throw new Error(`${path} ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function signIn(account: PrivateKeyAccount, email?: string) {
  const challenge = await call('/v1/auth/wallet/nonce', '', {});
  const message = createSiweMessage({ ...challenge, address: account.address, version: '1', issuedAt: new Date() } as never);
  return (await call('/v1/auth/wallet/verify', '', { message, signature: await account.signMessage({ message }), email })).token as string;
}
/** Sends prepared transactions from a wallet, each confirmed before the next, like the browser does. */
async function send(account: PrivateKeyAccount, transactions: Array<{ to: Address; data: Hex }>) {
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  const hashes: Hex[] = [];
  for (const tx of transactions) {
    const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data });
    const receipt = await pub.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, 'success', `transaction reverted: ${hash}`);
    hashes.push(hash);
  }
  return hashes;
}
const revive = (typed: Body) => {
  const fields = typed.types[typed.primaryType] as Array<{ name: string; type: string }>;
  const message = Object.fromEntries(fields.map(f => [f.name, /^u?int/.test(f.type) ? BigInt(typed.message[f.name]) : typed.message[f.name]]));
  const types = { ...typed.types };
  delete types.EIP712Domain;
  return { domain: { ...typed.domain, chainId: Number(typed.domain.chainId) }, types, primaryType: typed.primaryType, message } as never;
};
/** Signs every prepared EIP-712 message (an order, then any USDT permit), as the browser wallet does. */
const signAll = (account: PrivateKeyAccount, typedData: Body[]) => Promise.all(typedData.map(t => account.signTypedData(revive(t))));
const usdtOf = (address: Address) => pub.readContract({ address: network.contracts.usdt, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string, seconds = 90): Promise<T> {
  for (let i = 0; i < seconds * 2; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const network = await call('/v1/network', '') as { contracts: Record<string, Address>; localFork: boolean };
assert.ok(network.localFork, 'Run against a local fork: this script uses the test faucet');
assert.ok(network.contracts.receivables && network.contracts.investorRegistry, 'Invoice financing is not deployed on this stack');
const receivables = network.contracts.receivables;

// ------------------------------------------------------------------ people and money
const merchant = privateKeyToAccount(generatePrivateKey()), customer = privateKeyToAccount(generatePrivateKey());
const alice = privateKeyToAccount(generatePrivateKey()), bob = privateKeyToAccount(generatePrivateKey());
const carol = privateKeyToAccount(generatePrivateKey()), officer = privateKeyToAccount(generatePrivateKey());
const email = `client-${Date.now()}@acme.test`;
const [merchantToken, customerToken, aliceToken, bobToken, carolToken, officerToken] = await Promise.all([
  signIn(merchant), signIn(customer, email), signIn(alice), signIn(bob), signIn(carol), signIn(officer),
]);
await call('/v1/auth/merchant', merchantToken, {});
// Investors and the officer get no WBT at all: they only sign, and Pact's relayer pays their gas.
for (const [token, address, usdt, wbt] of [[merchantToken, merchant.address, '50', '1'], [customerToken, customer.address, '60', ''], [aliceToken, alice.address, '100', ''], [bobToken, bob.address, '100', ''], [carolToken, carol.address, '20', '']] as const)
  await call('/v1/dev/faucet', token, { address, usdt: usdt || undefined, wbt: wbt || undefined });
// The merchant's usual live setup: gas tank, daily cap, the Router's USDT fee allowance.
const tankAbi = parseAbi(['function deposit(address) payable', 'function setDailyCap(uint256)']);
const merchantWallet = createWalletClient({ account: merchant, chain, transport: http(RPC) });
for (const hash of [
  await merchantWallet.writeContract({ address: network.contracts.gasTank, abi: tankAbi, functionName: 'deposit', args: [merchant.address], value: parseEther('0.3') }),
  await merchantWallet.writeContract({ address: network.contracts.gasTank, abi: tankAbi, functionName: 'setDailyCap', args: [parseEther('0.3')] }),
  await merchantWallet.writeContract({ address: network.contracts.usdt, abi: erc20Abi, functionName: 'approve', args: [network.contracts.router, maxUint256] }),
]) assert.equal((await pub.waitForTransactionReceipt({ hash })).status, 'success');
step('merchant, customer, investors and officer are set up');

/** An invoice the customer acknowledged ("I owe this invoice"), due in `days` days. */
async function acknowledgedInvoice(amount: string, days: number) {
  const created = await call('/v1/invoices?expand=detail', merchantToken, { customerEmail: email, customerName: 'Acme Ltd', dueAt: new Date(Date.now() + days * 86_400_000).toISOString(), lines: [{ description: 'Platform audit', quantity: 1, unitAmount: amount }] });
  const typed = await call(`/v1/commerce/me/invoices/${created.id}/acknowledgement`, customerToken);
  await call(`/v1/commerce/me/invoices/${created.id}/acknowledge`, customerToken, { signature: await customer.signTypedData(revive(typed)) });
  return created.id as string;
}
async function list(invoiceId: string) {
  const prepared = await call(`/v1/financing/invoices/${invoiceId}/list`, merchantToken, {});
  return call(`/v1/financing/invoices/${invoiceId}/transactions`, merchantToken, { hashes: await send(merchant, prepared.transactions) });
}
async function approve(investor: PrivateKeyAccount, token: string, organization: string) {
  await call('/v1/investor/me/application', token, { name: `${organization} desk`, organization, email: `${organization.split(' ')[0].toLowerCase()}@fund.test`, region: 'GB' });
  const prepared = await call(`/v1/compliance/investors/${investor.address}`, officerToken, { decision: 'approve' });
  return call(`/v1/compliance/investors/${investor.address}/relay`, officerToken, { order: prepared.order, signatures: await signAll(officer, prepared.typedData) });
}
async function buy(investor: PrivateKeyAccount, token: string, invoiceId: string, face: bigint) {
  const prepared = await call(`/v1/investor/listings/${invoiceId}/purchase`, token, { faceMinor: face.toString() });
  return call(`/v1/investor/listings/${invoiceId}/purchase/relay`, token, { order: prepared.order, signatures: await signAll(investor, prepared.typedData) });
}

// ------------------------------------------------------------------ 1. listing
const invoiceId = await acknowledgedInvoice('20', 20);
const eligible = await call(`/v1/financing/invoices/${invoiceId}`, merchantToken);
assert.equal(eligible.status, 'eligible');
const listed = await list(invoiceId);
assert.equal(listed.status, 'requested');
step(`listed ${listed.number}: ${listed.terms.discountBps / 100}% off, price ${Number(listed.terms.priceMinor) / 1e6} USDT for ${Number(listed.terms.faceMinor) / 1e6}`);

// ------------------------------------------------------------------ 2. compliance
await call('/v1/investor/me/application', carolToken, { name: 'Carol', organization: 'Unvetted LLC', email: 'carol@unvetted.test', region: 'US' });
const refused = await request(`/v1/investor/listings/${invoiceId}/purchase`, carolToken, { faceMinor: (5n * USDT).toString() });
assert.equal(refused.status, 422);
assert.equal(refused.body.error.code, 'not_approved');
assert.equal((await request('/v1/compliance/registry', officerToken)).body.error.code, 'not_compliance_officer');
await call('/v1/dev/compliance-officer', officerToken, {});
await approve(alice, aliceToken, 'Lotus Capital');
await approve(bob, bobToken, 'Harbor Fund');
const registry = await call('/v1/compliance/registry', officerToken);
assert.equal(registry.refusals.length >= 1, true);
assert.equal(registry.investors.filter((i: Body) => i.approval.status === 'approved').length, 2);
step('unapproved investor refused and recorded; two investors approved in the registry');

// ------------------------------------------------------------------ 3. purchase and transfer
const merchantBefore = await usdtOf(merchant.address);
const half = await buy(alice, aliceToken, invoiceId, 12n * USDT);
assert.equal(half.holders[0].faceMinor, (12n * USDT).toString());
await buy(bob, bobToken, invoiceId, 8n * USDT);
const funded = await call(`/v1/financing/invoices/${invoiceId}`, merchantToken);
assert.equal(funded.status, 'funded');
const upfront = BigInt(funded.funding.upfrontMinor);
assert.equal(await usdtOf(merchant.address) - merchantBefore, upfront, 'the merchant received the advance at once');
assert.equal(await usdtOf(receivables), BigInt(funded.reserve.heldMinor), 'the contract holds only the reserve');
step(`sold out: merchant received ${Number(upfront) / 1e6} USDT at once, contract holds a ${Number(funded.reserve.heldMinor) / 1e6} USDT reserve`);
const transfer = await call(`/v1/investor/listings/${invoiceId}/transfer`, aliceToken, { to: bob.address, faceMinor: (2n * USDT).toString() });
await call(`/v1/investor/listings/${invoiceId}/transfer/relay`, aliceToken, { order: transfer.order, signatures: await signAll(alice, transfer.typedData) });
const holders = Object.fromEntries((await call(`/v1/financing/invoices/${invoiceId}`, merchantToken)).holders.map((h: Body) => [h.id, h.faceMinor]));
assert.deepEqual(holders, { [alice.address.toLowerCase()]: (10n * USDT).toString(), [bob.address.toLowerCase()]: (10n * USDT).toString() });
step('Lotus Capital transferred 2 USDT of the claim to Harbor Fund');
// A signed order that was never sent can be cancelled, and the contract then refuses it.
const unsent = await call(`/v1/investor/listings/${invoiceId}/transfer`, aliceToken, { to: bob.address, faceMinor: (1n * USDT).toString() });
const unsentSignatures = await signAll(alice, unsent.typedData);
const cancelOrders = await call('/v1/investor/orders/cancel', aliceToken, {});
await call('/v1/investor/orders/cancel/relay', aliceToken, { order: cancelOrders.order, signatures: await signAll(alice, cancelOrders.typedData) });
assert.equal((await request(`/v1/investor/listings/${invoiceId}/transfer/relay`, aliceToken, { order: unsent.order, signatures: unsentSignatures })).body.error.code, 'invalid_signature', 'a cancelled transfer cannot run');
const unsentDecision = await call(`/v1/compliance/investors/${carol.address}`, officerToken, { decision: 'approve' });
const unsentDecisionSignatures = await signAll(officer, unsentDecision.typedData);
const cancelDecisions = await call('/v1/compliance/orders/cancel', officerToken, {});
await call('/v1/compliance/orders/cancel/relay', officerToken, { order: cancelDecisions.order, signatures: await signAll(officer, cancelDecisions.typedData) });
assert.equal((await request(`/v1/compliance/investors/${carol.address}/relay`, officerToken, { order: unsentDecision.order, signatures: unsentDecisionSignatures })).body.error.code, 'invalid_signature', 'a cancelled decision cannot run');
assert.equal((await call('/v1/compliance/registry', officerToken)).investors.find((i: Body) => i.address === carol.address.toLowerCase()).approval.status, 'pending');
step('signed orders that were never sent were cancelled; the contracts refuse them');
for (const who of [alice, bob, officer]) assert.equal(await pub.getBalance({ address: who.address }), 0n, 'investors and the officer never needed gas');
step('investors and the officer hold no WBT: they only signed, Pact paid the gas');

// ------------------------------------------------------------------ 4. the customer pays as usual
const [aliceBefore, bobBefore, merchantMid] = await Promise.all([usdtOf(alice.address), usdtOf(bob.address), usdtOf(merchant.address)]);
const { paymentId } = await call(`/v1/commerce/me/invoices/${invoiceId}/payments`, customerToken, {});
let readiness = await call(`/v1/commerce/me/payments/${paymentId}/readiness`, customerToken);
assert.equal(readiness.spender.toLowerCase(), receivables.toLowerCase(), 'a financed invoice is approved to the receivables contract');
if (readiness.status === 'needs_approval') {
  const signature = await customer.signMessage({ message: { raw: readiness.message } });
  const authorization = readiness.authorizationRequired ? await customer.signAuthorization({ address: readiness.delegate, chainId: 1874, nonce: Number(readiness.authorizationNonce) }) : undefined;
  await call(`/v1/commerce/me/payments/${paymentId}/approval`, customerToken, {
    approvalNonce: readiness.approvalNonce, deadline: readiness.deadline, signature,
    ...(authorization ? { authorization: { address: authorization.address, chainId: authorization.chainId, nonce: authorization.nonce, r: authorization.r, s: authorization.s, yParity: authorization.yParity } } : {}),
  });
  readiness = await until(() => call(`/v1/commerce/me/payments/${paymentId}/readiness`, customerToken), r => r.status === 'ready', 'the relayed approval');
}
assert.equal(readiness.status, 'ready');
const offer = await call(`/v1/commerce/me/payments/${paymentId}/intent`, customerToken);
assert.equal(offer.intent.target.toLowerCase(), receivables.toLowerCase(), 'the payment goes to the receivables contract');
await call(`/v1/commerce/me/payments/${paymentId}/intent`, customerToken, { intent: offer.intent, data: offer.data, signature: await customer.signTypedData(revive(offer.typedData)) });
await until(() => call(`/v1/commerce/me/payments/${paymentId}`, customerToken), p => p.status === 'captured' || p.status === 'failed', 'the payment');
const repaid = await until(() => call(`/v1/financing/invoices/${invoiceId}`, merchantToken), v => v.status === 'repaid', 'the claim to settle');
assert.equal(await usdtOf(alice.address) - aliceBefore, 10n * USDT, 'Lotus Capital was paid its face value');
assert.equal(await usdtOf(bob.address) - bobBefore, 10n * USDT, 'Harbor Fund was paid its face value');
const reserveBack = BigInt(repaid.reserve.releasedMinor);
assert.ok(reserveBack > 0n);
assert.ok(await usdtOf(merchant.address) - merchantMid > reserveBack - 1n * USDT, 'the merchant got its reserve back, less the Router fee');
assert.equal(await usdtOf(receivables), 0n, 'nothing is left in the contract');
const portfolio = await call('/v1/investor/portfolio', aliceToken);
assert.equal(portfolio.totals.receivedMinor, (10n * USDT).toString());
step(`customer paid 20 USDT: each holder received 10 USDT directly; reserve of ${Number(reserveBack) / 1e6} USDT back to the merchant`);

// ------------------------------------------------------------------ 5. default and buy-back (moves the clock)
if (timeTravel) {
  const second = await acknowledgedInvoice('10', 3);
  await list(second);
  await buy(alice, aliceToken, second, 10n * USDT);
  const maturity = Math.floor(new Date((await call(`/v1/financing/invoices/${second}`, merchantToken)).terms.maturityAt).getTime() / 1000);
  const latest = Number((await pub.getBlock({ blockTag: 'latest' })).timestamp);
  await pub.request({ method: 'evm_increaseTime' as never, params: [maturity + 7 * 86_400 + 600 - latest] as never });
  await pub.request({ method: 'evm_mine' as never, params: [] as never });
  step('moved the fork 7 days past maturity; waiting for the keeper');
  const defaulted = await until(() => call(`/v1/financing/invoices/${second}`, merchantToken), v => v.status === 'defaulted', 'the keeper to mark the default', 120);
  assert.equal(defaulted.frozen, true);
  const owed = BigInt(defaulted.buyBackMinor);
  assert.equal(owed, 10n * USDT + 10n * USDT / 100n - 1n * USDT, 'face value plus the 1% late fee, less the 10% reserve paid out');
  const aliceMid = await usdtOf(alice.address);
  const buyBack = await call(`/v1/financing/invoices/${second}/buy-back`, merchantToken, {});
  const bought = await call(`/v1/financing/invoices/${second}/transactions`, merchantToken, { hashes: await send(merchant, buyBack.transactions) });
  assert.equal(bought.status, 'bought_back');
  assert.equal(await usdtOf(alice.address) - aliceMid, owed);
  step(`defaulted: reserve paid to the holder, then the merchant bought the claim back for ${Number(owed) / 1e6} USDT`);
}
step('OK');
