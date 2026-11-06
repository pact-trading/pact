import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, keccak256, type Hex } from 'viem';
import { FakeChain, escrowAbi } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { RelayerWatchdog } from '../src/relayer-watchdog.js';
import { intentTypedData } from '../src/typed-data.js';
import { openDb } from '../src/db.js';
import type { IntentRequest } from '../src/types.js';

const signer = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const addresses = { router: '0x0000000000000000000000000000000000000001', escrow: '0x0000000000000000000000000000000000000002', subscription: '0x0000000000000000000000000000000000000003' } as const;
async function request(nonce: bigint): Promise<IntentRequest> {
  const data = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [`0x${nonce.toString(16).padStart(64, '0')}`, signer.address, 1_000_000n, 86400n] });
  const intent = { signer: signer.address, merchant: signer.address, target: addresses.escrow, dataHash: keccak256(data), amount: 1_000_000n, nonce, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), maxGas: 400_000 };
  return { intent, data, signature: await signer.signTypedData(intentTypedData(intent, addresses.router)) };
}
function fixture() {
  const chain = new FakeChain();
  chain.writer.bind(openDb());
  chain.accepted.set(signer.address.toLowerCase(), 1);
  const relayer = new Relayer(chain, addresses.router, allowedTargets({ escrow: addresses.escrow, subscription: addresses.subscription }), { minAmount: 1_000_000n, maxGas: 1_000_000n, maxGasPrice: 100_000_000_000n, maxSpendPerMinute: 10n ** 18n });
  let clock = Date.now();
  const watchdog = new RelayerWatchdog(chain.writer, chain, { rebroadcastAfterMs: 5_000, stuckAfterMs: 60_000 }, () => clock);
  return { chain, relayer, watchdog, advance: (ms: number) => { clock += ms; } };
}

describe('relayer watchdog', () => {
  it('resends the exact signed bytes of a lost broadcast, so the same transaction lands and later nonces follow', async () => {
    const f = fixture();
    // The node answered with the hash but the transaction never reached the sequencer.
    vi.spyOn(f.chain, 'broadcastTransaction').mockImplementationOnce(async raw => keccak256(raw));
    const lost = await f.relayer.submit(await request(1n));
    const next = await f.relayer.submit(await request(2n));
    expect(f.chain.sent.map(s => s.hash)).toEqual([next]);
    expect(await f.watchdog.run()).toEqual({ resent: 0, stuck: null }); // too soon
    f.advance(6_000);
    const resend = vi.spyOn(f.chain, 'broadcastTransaction');
    expect((await f.watchdog.run()).resent).toBeGreaterThanOrEqual(1);
    expect(resend.mock.calls[0][0]).toBe(f.chain.writer.unsettled()[0].raw_tx);
    expect(f.chain.sent.map(s => s.hash)).toEqual([next, lost]); // the same hash: no second payment
    expect(f.chain.sent.map(s => s.nonce)).toEqual([1, 0]);
  });
  it('marks the account stuck when the lowest nonce cannot be sent, refuses writes, and recovers once it can', async () => {
    const f = fixture();
    const broadcast = f.chain.broadcastTransaction.bind(f.chain);
    const send = vi.spyOn(f.chain, 'broadcastTransaction').mockRejectedValue(new Error('insufficient funds for gas * price + value'));
    await f.relayer.submit(await request(1n)); // ambiguous: kept with its bytes
    f.advance(6_000); await f.watchdog.run();
    expect(f.chain.writer.stuck).toBeNull(); // failing, but not long enough to stop the account
    f.advance(60_000); await f.watchdog.run();
    expect(f.chain.writer.stuck).toMatch(/nonce 0 .* insufficient funds/);
    await expect(f.relayer.submit(await request(2n))).rejects.toMatchObject({ code: 'relayer_stuck' });
    send.mockImplementation(broadcast); // the operator funded the relayer
    f.advance(6_000);
    expect(await f.watchdog.run()).toEqual({ resent: 1, stuck: null });
    await f.relayer.submit(await request(3n));
    expect(f.chain.sent.map(s => s.nonce)).toEqual([0, 1]);
  });
  it('treats an already-known transaction as sent', async () => {
    const f = fixture();
    vi.spyOn(f.chain, 'broadcastTransaction').mockRejectedValueOnce(new Error('timeout')).mockRejectedValueOnce(new Error('already known'));
    await f.relayer.submit(await request(1n));
    expect(f.chain.writer.unsettled()[0].phase).toBe('uncertain');
    f.advance(6_000); await f.watchdog.run();
    expect(f.chain.writer.unsettled()[0].phase).toBe('submitted');
    expect(f.chain.writer.stuck).toBeNull();
  });
});

describe('pipelined writer slot', () => {
  it('signs and sends the next payment while the previous broadcast is still in transit', async () => {
    const f = fixture();
    let finish!: () => void;
    const broadcast = f.chain.broadcastTransaction.bind(f.chain);
    vi.spyOn(f.chain, 'broadcastTransaction').mockImplementationOnce(raw => new Promise(resolve => { finish = () => resolve(broadcast(raw)); }));
    const first = f.relayer.submit(await request(1n));
    await vi.waitFor(() => expect(finish).toBeDefined());
    await f.relayer.submit(await request(2n)); // not held behind the first broadcast
    expect(f.chain.sent.map(s => [s.request.intent.nonce, s.nonce])).toEqual([[2n, 1]]);
    finish(); await first;
    expect(f.chain.sent.map(s => [s.request.intent.nonce, s.nonce])).toEqual([[2n, 1], [1n, 0]]);
  });
  it('keeps the slot to the end without pipelining (RELAYER_PIPELINE=0)', async () => {
    const f = fixture(); f.chain.writer.pipeline = false;
    let finish!: () => void;
    const broadcast = f.chain.broadcastTransaction.bind(f.chain);
    vi.spyOn(f.chain, 'broadcastTransaction').mockImplementationOnce(raw => new Promise(resolve => { finish = () => resolve(broadcast(raw)); }));
    const first = f.relayer.submit(await request(1n));
    await vi.waitFor(() => expect(finish).toBeDefined());
    let secondDone = false;
    const second = f.relayer.submit(await request(2n)).then(() => { secondDone = true; });
    await new Promise(r => setTimeout(r, 20));
    expect(secondDone).toBe(false);
    finish(); await first; await second;
    expect(f.chain.sent.map(s => s.nonce)).toEqual([0, 1]);
  });
});
