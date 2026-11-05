import { describe, expect, it } from 'vitest';
import { openDb, seedMerchant, id } from '../src/db.js';
import { FakeChain } from '../src/chain.js';
import { createApp } from '../src/app.js';
import { Relayer, allowedTargets } from '../src/relayer.js';

function fixture() {
  const db = openDb(), chain = new FakeChain(false);
  const a = seedMerchant(db, '0x00000000000000000000000000000000000000aa');
  const b = seedMerchant(db, '0x00000000000000000000000000000000000000bb');
  chain.tank.set('0x00000000000000000000000000000000000000aa', { balanceWei: 10n ** 17n, dailyCapWei: 5n * 10n ** 16n, spentTodayWei: 10n ** 15n });
  const app = createApp({ db, chain, relayer: new Relayer(chain, '0x0000000000000000000000000000000000000001', allowedTargets('0x0000000000000000000000000000000000000002', '0x0000000000000000000000000000000000000003')) });
  const call = (key: string, path: string, body?: unknown) => app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const ledger = (merchantId: string, wei: bigint, daysAgo: number, action = 'payment') =>
    db.prepare('INSERT INTO gas_ledger(id,merchant_id,tx_hash,cost_wei,created_at,fee_usdt,action,object_id) VALUES (?,?,?,?,?,?,?,?)').run(id('gas'), merchantId, `0x${'1'.repeat(64)}`, wei.toString(), new Date(Date.now() - daysAgo * 86_400_000).toISOString(), '10000', action, 'pay_1');
  return { db, a, b, call, ledger };
}
describe('gas tank', () => {
  it('reports balance, cap, 14-day history and runway from this merchant only', async () => {
    const f = fixture();
    f.ledger(f.a.merchantId, 10n ** 16n, 0);
    f.ledger(f.a.merchantId, 10n ** 16n, 1, 'refund');
    f.ledger(f.b.merchantId, 10n ** 17n, 0);
    const tank = await (await f.call(f.a.secretKey, '/v1/gas-tank')).json();
    expect(tank).toMatchObject({ balanceWei: (10n ** 17n).toString(), dailyCapWei: (5n * 10n ** 16n).toString(), runwayDays: 10, pausedSeconds: 0 });
    expect(tank.history).toHaveLength(14);
    expect(tank.history.at(-1)).toMatchObject({ spentWei: (10n ** 16n).toString(), actions: 1 });
    expect(tank.policy).toMatchObject({ mode: 'absorb', perPayerDailyActions: 10, minimumAmountMinor: '1000000' });
    const ledger = (await (await f.call(f.a.secretKey, '/v1/gas-tank/ledger')).json()).data;
    expect(ledger.map((e: { label: string }) => e.label)).toEqual(['Payment', 'Refund']);
    expect(ledger[0].gasUsdMinor).toBe('790000');
  });
  it('stores the merchant preferences and refuses contract settings', async () => {
    const f = fixture();
    const updated = await (await f.call(f.a.secretKey, '/v1/gas-tank/policy', { mode: 'surcharge', surchargeMinor: '20000', lowRunwayAlertDays: 3 })).json();
    expect(updated.policy).toMatchObject({ mode: 'surcharge', surchargeMinor: '20000', lowRunwayAlertDays: 3 });
    expect((await (await f.call(f.b.secretKey, '/v1/gas-tank')).json()).policy.mode).toBe('absorb');
    const refused = await (await f.call(f.a.secretKey, '/v1/gas-tank/policy', { perPayerDailyActions: 99 })).json();
    expect(refused.error.code).toBe('contract_setting');
  });
});
