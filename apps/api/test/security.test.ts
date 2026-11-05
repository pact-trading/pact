import { describe, expect, it } from 'vitest';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain } from '../src/chain.js';
import { createApp } from '../src/app.js';
import { Relayer, allowedTargets } from '../src/relayer.js';

const router = '0x0000000000000000000000000000000000000001', escrow = '0x0000000000000000000000000000000000000002', subscription = '0x0000000000000000000000000000000000000003';
describe('drain run', () => {
  it('refuses every attack before broadcast, leaves the tank unchanged and counts refusals per layer', async () => {
    const db = openDb(), chain = new FakeChain(false);
    const address = '0x00000000000000000000000000000000000000aa';
    const keys = seedMerchant(db, address);
    chain.tank.set(address, { balanceWei: 10n ** 17n, dailyCapWei: 10n ** 17n, spentTodayWei: 0n });
    const app = createApp({ db, chain, relayer: new Relayer(chain, router, allowedTargets(escrow, subscription)), router, escrow, subscription });
    const call = async (path: string, body?: unknown) => (await app.request(path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${keys.secretKey}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json();
    const run = await call('/v1/security/drain-runs', {});
    expect(run.attempts.length).toBeGreaterThanOrEqual(55);
    expect(run.attempts.filter((a: { result: string }) => a.result !== 'refused')).toEqual([]);
    expect(new Set(run.attempts.map((a: { reason: string }) => a.reason))).toEqual(new Set(['dust', 'wrong_selector', 'data_hash', 'deadline', 'gas_limit', 'fee_too_low']));
    expect(run.tankBeforeWei).toBe(run.tankAfterWei);
    expect(chain.sent).toHaveLength(0);
    const layers = (await call('/v1/security/layers')).data as Array<{ id: number; blocked: number }>;
    expect(layers.find(l => l.id === 4)!.blocked).toBe(51);
    expect(layers.find(l => l.id === 1)!.blocked).toBe(2);
    expect((await call('/v1/refusals?expand=detail')).data[0]).toMatchObject({ source: 'relayer', layer: expect.any(Number) });
    expect((await call('/v1/security/drain-runs')).data).toHaveLength(1);
  });
});
