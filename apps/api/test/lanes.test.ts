import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, keccak256, toHex, type Hex } from 'viem';
import { FakeChain, escrowAbi } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { Indexer } from '../src/indexer.js';
import { intentTypedData } from '../src/typed-data.js';
import { openDb } from '../src/db.js';

const addresses = { router: '0x0000000000000000000000000000000000000001', escrow: '0x0000000000000000000000000000000000000002', subscription: '0x0000000000000000000000000000000000000003' } as const;
const merchant = '0x00000000000000000000000000000000000000aa' as Hex;
async function request(key: Hex, nonce: bigint) {
  const signer = privateKeyToAccount(key);
  const data = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [keccak256(toHex(`${key}:${nonce}`)), merchant, 1_000_000n, 86400n] });
  const intent = { signer: signer.address, merchant, target: addresses.escrow, dataHash: keccak256(data), amount: 1_000_000n, nonce, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), maxGas: 400_000 };
  return { intent, data, signature: await signer.signTypedData(intentTypedData(intent, addresses.router)) };
}
function fixture() {
  const chain = new FakeChain(true);
  const db = openDb(); chain.writer.bind(db);
  chain.accepted.set(merchant, 1);
  const relayer = new Relayer(chain, addresses.router, allowedTargets({ escrow: addresses.escrow, subscription: addresses.subscription }), { minAmount: 1_000_000n, maxGas: 1_000_000n, maxGasPrice: 100_000_000_000n, maxSpendPerMinute: 10n ** 18n });
  relayer.lanes = [chain.lane('0x00000000000000000000000000000000000000c1'), chain.lane('0x00000000000000000000000000000000000000c2')];
  for (const lane of relayer.lanes) lane.writer.bind(db);
  return { chain, db, relayer };
}
/** Two payer keys that the relayer assigns to different lanes. */
async function payersOnDifferentLanes(relayer: Relayer): Promise<[Hex, Hex]> {
  const first = `0x${'1'.repeat(64)}` as Hex;
  const lane = relayer.laneFor(await request(first, 1n));
  for (let i = 2; i < 50; i++) {
    const key = `0x${i.toString(16).padStart(2, '0').repeat(32)}` as Hex;
    if (relayer.laneFor(await request(key, 1n)) !== lane) return [first, key];
  }
  throw new Error('no second lane');
}

describe('relayer lanes', () => {
  it('sends each payer through one lane, with independent nonces per relayer account', async () => {
    const f = fixture();
    const [a, b] = await payersOnDifferentLanes(f.relayer);
    await f.relayer.submit(await request(a, 1n));
    await f.relayer.submit(await request(b, 1n));
    await f.relayer.submit(await request(a, 2n));
    const rows = f.db.prepare('SELECT relayer,nonce FROM relayer_operations ORDER BY rowid').all() as Array<{ relayer: string; nonce: number }>;
    expect(new Set(rows.map(r => r.relayer)).size).toBe(2);
    const byLane = (relayer: string) => rows.filter(r => r.relayer === relayer).map(r => r.nonce);
    expect(byLane(rows[0].relayer)).toEqual([0, 1]);
    expect(byLane(rows[1].relayer)).toEqual([0]);
    expect(f.chain.writer.rows()).toHaveLength(0); // the primary account keeps its nonces for keeper, permits and treasury
  });
  it('holds only the stuck lane', async () => {
    const f = fixture();
    const [a, b] = await payersOnDifferentLanes(f.relayer);
    f.relayer.laneFor(await request(a, 1n)).writer.stuck = 'nonce 0 cannot be broadcast';
    await expect(f.relayer.submit(await request(a, 1n))).rejects.toMatchObject({ code: 'relayer_stuck' });
    await expect(f.relayer.submit(await request(b, 1n))).resolves.toMatch(/^0x/);
  });
  it('resolves every lane journal from the indexer', async () => {
    const f = fixture();
    const [a, b] = await payersOnDifferentLanes(f.relayer);
    await f.relayer.submit(await request(a, 1n)); await f.relayer.submit(await request(b, 1n));
    const indexer = new Indexer(f.db, f.chain, 0n, 1n);
    indexer.writers.push(...f.relayer.lanes.map(lane => lane.writer));
    f.chain.block += 2n;
    await indexer.poll();
    expect(f.db.prepare("SELECT DISTINCT phase FROM relayer_operations").all()).toEqual([{ phase: 'confirmed' }]);
  });
});

describe('batched keeper renewals', () => {
  it('renews due subscriptions in one keeper transaction, each settling on its own event', async () => {
    const { runKeeper } = await import('../src/keeper.js');
    const { KeeperRenewals } = await import('../src/subscriptions-live.js');
    const { seedMerchant } = await import('../src/db.js');
    const chain = new FakeChain(true);
    const db = openDb(); chain.writer.bind(db);
    const { merchantId } = seedMerchant(db, merchant);
    db.prepare('INSERT INTO plans(id,merchant_id,name,amount_minor,period_seconds,max_periods,created_at) VALUES (?,?,?,?,?,?,?)').run('plan', merchantId, 'Plan', '2000000', 86400, 12, '2026-01-01');
    for (let i = 0; i < 3; i++) db.prepare('INSERT INTO subscriptions(id,merchant_id,plan_id,chain_id,payer,status,next_charge_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run(`sub_${i}`, merchantId, 'plan', keccak256(toHex(`sub_${i}`)), merchant, 'active', new Date(0).toISOString(), '2026-01-01');
    chain.renewalRefusals = [];
    await runKeeper(db, chain, new Date(), new KeeperRenewals(db, chain));
    // One keeper transaction for all three: one journal row, one nonce.
    expect(chain.writer.rows().map(r => [r.kind, r.object_id, JSON.parse(r.links_json).subscriptionIds?.length])).toEqual([['renew', 'batch', 3]]);
    expect(new Set((db.prepare('SELECT pending_tx_hash FROM subscriptions').all() as Array<{ pending_tx_hash: string }>).map(r => r.pending_tx_hash)).size).toBe(1);
    chain.block += 2n; await new Indexer(db, chain, 0n, 1n).poll();
    expect(db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE status='active' AND pending_tx_hash IS NULL").get()).toEqual({ n: 3 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM accounting_entries WHERE kind='Subscription'").get()).toEqual({ n: 3 });
    // Nothing is due again until the next period.
    await runKeeper(db, chain, new Date(), new KeeperRenewals(db, chain));
    expect(chain.writer.rows()).toHaveLength(1);
  });
});
