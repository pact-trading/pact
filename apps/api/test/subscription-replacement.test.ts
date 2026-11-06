import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeAbiParameters, encodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain, subscriptionAbi } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { createApp } from '../src/app.js';
import { mandateTypedData, intentTypedData } from '../src/typed-data.js';
import { Indexer } from '../src/indexer.js';
import { readSubscriptionMandate } from '../src/subscription-mandates.js';
const payer = privateKeyToAccount(`0x${'1'.repeat(64)}`), merchant = privateKeyToAccount(`0x${'3'.repeat(64)}`);
const addresses = { router: '0x0000000000000000000000000000000000000001', escrow: '0x0000000000000000000000000000000000000002', subscription: '0x0000000000000000000000000000000000000003' } as const;
async function fixture() {
  const db = openDb(), chain = new FakeChain(false), keys = seedMerchant(db, merchant.address);
  chain.accepted.set(String(merchant.address.toLowerCase()).toLowerCase(), 1);
  const app = createApp({ db, chain, relayer: new Relayer(chain, addresses.router, allowedTargets({ escrow: addresses.escrow, subscription: addresses.subscription })), ...addresses });
  const post = (path: string, body: unknown, key = keys.secretKey) => app.request(path, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body, (_, v) => typeof v === 'bigint' ? v.toString() : v) });
  const oldId = keccak256(toHex('old'));
  db.prepare('INSERT INTO plans(id,merchant_id,name,amount_minor,period_seconds,max_periods,created_at) VALUES (?,?,?,?,?,?,?)').run('old-plan', keys.merchantId, 'Old', '2000000', 86400, 12, new Date().toISOString());
  db.prepare('INSERT INTO subscriptions(id,merchant_id,plan_id,chain_id,payer,status,next_charge_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run('old', keys.merchantId, 'old-plan', oldId, payer.address.toLowerCase(), 'active', new Date().toISOString(), new Date().toISOString());
  const plan = await (await post('/v1/subscriptions/plans', { name: 'New', amount: '3', periodSeconds: 86400, maxPeriods: 12 })).json();
  const mandate = { payer: payer.address, merchant: merchant.address, planId: keccak256(toHex(plan.id)), amountCap: 3_000_000n, periodSeconds: 86400n, maxPeriods: 12, endTime: BigInt(Math.floor(Date.now() / 1000) + 86400), nonce: 1n };
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);
  const signature = await payer.signTypedData(mandateTypedData(mandate, addresses.subscription));
  const data = encodeFunctionData({ abi: subscriptionAbi, functionName: 'replace', args: [oldId, mandate, signature] });
  const intent = { signer: payer.address, merchant: merchant.address, target: addresses.subscription, dataHash: keccak256(data), amount: mandate.amountCap, nonce: 10n, deadline, maxGas: 500_000 };
  const body = { planId: plan.id, data, intent, signature: await payer.signTypedData(intentTypedData(intent, addresses.router)) };
  const newChainId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'address' }], [payer.address, 1n, addresses.subscription]));
  const row = (id: string) => db.prepare('SELECT * FROM subscriptions WHERE id=?').get(id) as Record<string, string>;
  async function settle(hash: Hex, omit = '', targetChain = chain, targetDb = db) {
    for (const [name, args] of [
      ['Subscribed', { id: newChainId, payer: payer.address, merchant: merchant.address, planId: mandate.planId }],
      ['Cancelled', { id: oldId }], ['Replaced', { oldId, newId: newChainId }],
      ['Executed', { signer: payer.address, merchant: merchant.address, nonce: intent.nonce, target: addresses.subscription, gasFee: 0n}],
    ] as const) if (name !== omit) targetChain.emit({ id: `${hash}:${name}`, txHash: hash, contract: name === 'Executed' ? 'router' : 'subscription', name, args });
    targetChain.block += 2n;
    await new Indexer(targetDb, targetChain).poll();
  }
  return { db, chain, keys, post, body, row, settle, newChainId, mandate, signature };
}
describe('atomic subscription replacement API', () => {
  it('keeps the old mandate active until a fully matched Router replacement receipt and handles replay', async () => {
    const f = await fixture();
    const response = await f.post('/v1/subscriptions/old/replace', f.body, f.keys.publishableKey);
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(readSubscriptionMandate(f.db, result.id)).toMatchObject({ mandate: f.mandate, payerSignature: f.signature, manager: addresses.subscription });
    expect(readSubscriptionMandate(f.db, 'old')).toBeUndefined();
    expect(f.row('old')).toMatchObject({ status: 'active', pending_tx_hash: result.txHash });
    expect(f.row(result.id)).toMatchObject({ status: 'pending', pending_tx_hash: result.txHash });
    await f.settle(result.txHash);
    expect(f.row('old')).toMatchObject({ status: 'cancelled', pending_tx_hash: null });
    expect(f.row(result.id)).toMatchObject({ status: 'active', pending_tx_hash: null });
    const duplicate = await f.post('/v1/subscriptions/old/replace', f.body, f.keys.publishableKey);
    expect(duplicate.status).toBe(200); expect((await duplicate.json()).id).toBe(result.id);
    expect(f.chain.sent).toHaveLength(1);
  });
  it.each(['Executed', 'Subscribed', 'Cancelled', 'Replaced'])('holds both rows when %s evidence is absent', async omit => {
    const f = await fixture(); const response = await f.post('/v1/subscriptions/old/replace', f.body);
    expect(response.status).toBe(200); const result = await response.json();
    await f.settle(result.txHash, omit);
    expect(f.row('old')).toMatchObject({ status: 'reconciliation_required', pending_tx_hash: result.txHash });
    expect(f.row(result.id)).toMatchObject({ status: 'reconciliation_required', pending_tx_hash: result.txHash });
  });
  it('leaves the old mandate active and fails the new one on a reverted replacement', async () => {
    const f = await fixture(); const response = await f.post('/v1/subscriptions/old/replace', f.body);
    expect(response.status).toBe(200); const result = await response.json();
    f.chain.receipts.set(result.txHash.toLowerCase(), { txHash: result.txHash, block: 0n, status: 'reverted', events: [] }); f.chain.block = 2n;
    await new Indexer(f.db, f.chain).poll();
    expect(f.row('old')).toMatchObject({ status: 'active', pending_tx_hash: null });
    expect(f.row(result.id)).toMatchObject({ status: 'failed', pending_tx_hash: null });
  });
  it('recovers accepted-timeout replacement after database reopen without another send', async () => {
    const f = await fixture(), original = f.chain.broadcastTransaction.bind(f.chain);
    vi.spyOn(f.chain, 'broadcastTransaction').mockImplementationOnce(async raw => { await original(raw); throw new Error('accepted then timeout'); });
    const response = await f.post('/v1/subscriptions/old/replace', f.body);
    expect(response.status).toBe(200); const result = await response.json();
    const db = new Database(f.db.serialize()), chain = new FakeChain(false); chain.writer.bind(db);
    expect(db.prepare('SELECT * FROM relayer_legacy_holds').all()).toHaveLength(0);
    const broadcast = vi.spyOn(chain, 'broadcastTransaction');
    await f.settle(result.txHash, '', chain, db);
    expect(db.prepare('SELECT status,pending_tx_hash FROM subscriptions WHERE id=?').get('old')).toEqual({ status: 'cancelled', pending_tx_hash: null });
    expect(db.prepare('SELECT status,pending_tx_hash FROM subscriptions WHERE id=?').get(result.id)).toEqual({ status: 'active', pending_tx_hash: null });
    expect(broadcast).not.toHaveBeenCalled(); db.close();
  });
  it('cleans a provably unsent replacement without changing the old mandate', async () => {
    const f = await fixture(); vi.spyOn(f.chain, 'prepareIntent').mockRejectedValueOnce(new Error('RPC unavailable'));
    const response = await f.post('/v1/subscriptions/old/replace', f.body);
    expect(response.status).toBe(400);
    expect((await response.json()).error.message).toBe('RPC unavailable');
    expect(f.row('old')).toMatchObject({ status: 'active', pending_tx_hash: null });
    expect(f.db.prepare("SELECT status,pending_tx_hash FROM subscriptions WHERE id!='old'").get()).toEqual({ status: 'failed', pending_tx_hash: null });
    expect(f.chain.writer.rows()[0].phase).toBe('not_sent');
  });
  it('keeps the old mandate active when Router refuses replacement', async () => {
    const f = await fixture(), response = await f.post('/v1/subscriptions/old/replace', f.body);
    expect(response.status).toBe(200); const result = await response.json();
    f.chain.emit({ id: `${result.txHash}:Refused`, txHash: result.txHash, contract: 'router', name: 'Refused', args: { signer: payer.address, merchant: merchant.address, nonce: f.body.intent.nonce, reason: 12 } });
    f.chain.block += 2n; await new Indexer(f.db, f.chain).poll();
    expect(f.row('old')).toMatchObject({ status: 'active', pending_tx_hash: null });
    expect(f.row(result.id)).toMatchObject({ status: 'failed', pending_tx_hash: null });
  });
  it('reserves both mandates before awaits and rejects a simultaneous replacement', async () => {
    const f = await fixture(); let release!: () => void;
    const original = f.chain.prepareIntent.bind(f.chain);
    vi.spyOn(f.chain, 'prepareIntent').mockImplementation(async (...args) => { await new Promise<void>(resolve => { release = resolve; }); return original(...args); });
    const first = f.post('/v1/subscriptions/old/replace', f.body);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const second = await f.post('/v1/subscriptions/old/replace', { ...f.body, intent: { ...f.body.intent, nonce: 11n } });
    expect(second.status).toBe(422); release(); expect((await first).status).toBe(200);
    expect(f.chain.sent).toHaveLength(1);
  });
  it('rejects another merchant and a mismatched plan without writing', async () => {
    const f = await fixture(), other = seedMerchant(f.db, '0x0000000000000000000000000000000000000010');
    expect((await f.post('/v1/subscriptions/old/replace', f.body, other.secretKey)).status).toBe(422);
    expect((await f.post('/v1/subscriptions/old/replace', { ...f.body, planId: 'old-plan' })).status).toBe(422);
    expect(f.chain.writer.rows()).toHaveLength(0);
  });
});
