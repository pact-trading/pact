import { describe, expect, it } from 'vitest';
import { openDb, seedMerchant } from '../src/db.js';
import { AccountWriter } from '../src/account-writer.js';
import { relayerMargin } from '../src/margin.js';

describe('Pact margin', () => {
  it('sets every fee against the relayer gas measured from receipts', () => {
    const db = openDb(), { merchantId } = seedMerchant(db, '0x00000000000000000000000000000000000000aa');
    const at = Date.parse('2026-11-06T12:00:00Z');
    const entry = db.prepare('INSERT INTO accounting_entries(event_id,merchant_id,object_id,kind,amount_minor,fee_minor,tx_hash,occurred_at,block_number) VALUES (?,?,?,?,?,?,?,?,?)');
    entry.run('pay', merchantId, 'p1', 'Payment', '100000000', '800000', '0x01', '2026-11-06T10:00:00.000Z', '1');
    entry.run('renew', merchantId, 's1', 'Subscription', '5000000', '150000', '0x02', '2026-11-06T10:00:00.000Z', '2');
    entry.run('refund-gas', merchantId, 'r1', 'Fee', '0', '20000', '0x03', '2026-11-06T10:00:00.000Z', '3');
    entry.run('old', merchantId, 'p0', 'Payment', '100000000', '800000', '0x04', '2026-09-01T10:00:00.000Z', '4');
    const writer = new AccountWriter('0x00000000000000000000000000000000000000ee');
    writer.bind(db);
    const write = db.prepare("INSERT INTO relayer_operations(operation_id,kind,object_id,links_json,chain_id,relayer,nonce,tx_hash,phase,created_at,updated_at) VALUES (?,?,?,'{}',1874,?,?,?,'submitted',?,?)");
    for (const [i, kind] of (['intent', 'intent', 'cancel'] as const).entries()) write.run(`op${i}`, kind, `o${i}`, writer.relayer.toLowerCase(), i, `0x${(i + 10).toString(16).padStart(64, '0')}`, '2026-11-06T10:00:00.000Z', '2026-11-06T10:00:00.000Z');
    writer.resolve(`0x${(10).toString(16).padStart(64, '0')}`, 5n, 'success', 400_000n * 5_000_000_000n);
    writer.resolve(`0x${(11).toString(16).padStart(64, '0')}`, 5n, 'reverted', 100_000n * 5_000_000_000n);
    writer.resolve(`0x${(12).toString(16).padStart(64, '0')}`, 5n, 'success'); // no cost in the receipt
    db.prepare("UPDATE relayer_operations SET updated_at='2026-11-06T11:00:00.000Z'").run();
    const margin = relayerMargin(db, 30, 79_000_000n, at);
    expect(margin.fees).toEqual({ minor: '970000', byKind: { Payment: { minor: '800000', entries: 1 }, Subscription: { minor: '150000', entries: 1 }, Fee: { minor: '20000', entries: 1 } } });
    expect(margin.gas).toEqual({ wei: '2500000000000000', byKind: { intent: { writes: 2, wei: '2500000000000000', unmeasured: 0 }, cancel: { writes: 1, wei: '0', unmeasured: 1 } } });
    // 0.0025 WBT at 79 USDT per WBT is 0.1975 USDT of gas.
    expect(margin).toMatchObject({ gasMinor: '197500', marginMinor: '772500' });
    expect(relayerMargin(db, 30, undefined, at)).toMatchObject({ gasMinor: null, marginMinor: null });
  });
});
