import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AccountWriter } from '../src/account-writer.js';
import { openDb, type Db } from '../src/db.js';
import { intentTypedData } from '../src/typed-data.js';
import { EXACT, NETWORK, UPTO, USDT } from '../src/x402/constants.js';
import { exactSettlementAbi, uptoSettlementAbi } from '../src/x402/call-binding.js';
import { X402WriteCoordinator } from '../src/x402/write-coordinator.js';
import { SqliteX402Journal } from '../src/x402/sqlite-journal.js';
import { SqliteFundedX402Journal } from '../src/x402/sqlite-funded-journal.js';
import { canonicalJson, fingerprint } from '../src/x402/sqlite-store.js';
import { fundedGatewayAbi } from '../src/x402/funded-gateway.js';
import type { FundedConfiguration } from '../src/x402/funded-operations.js';
import { inactiveM7SponsorshipPolicy } from '../src/x402/viem-write-ports.js';
import type { X402Receipt, X402Transaction, X402WritePorts } from '../src/x402/write-ports.js';
import type { SettlementOperation } from '../src/x402/journal.js';

const merchant = privateKeyToAccount(toHex(0x402cafen, { size: 32 }));
const relayer = privateKeyToAccount(toHex(0x402a11cen, { size: 32 }));
const payer = '0x0000000000000000000000000000000000000022' as Address;
const gateway = '0x0000000000000000000000000000000000000033' as Address;
const router = '0x0000000000000000000000000000000000000044' as Address;
const gasTank = '0x0000000000000000000000000000000000000055' as Address;
const feeVault = '0x0000000000000000000000000000000000000066' as Address;
const factory = '0x0000000000000000000000000000000000000077' as Address;
const signature = `0x${'12'.repeat(65)}` as Hex;
const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
const dirs: string[] = [], dbs: Db[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.open) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(snapshot?: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'x402-funded-production-')); dirs.push(dir);
  const path = join(dir, 'journal.sqlite'); if (snapshot) writeFileSync(path, snapshot);
  const db = openDb(path); dbs.push(db); const writer = new AccountWriter(relayer.address);
  let head = 12n, accepted = true;
  const receipts = new Map<Hex, X402Receipt>();
  const terms = { reserve: vi.fn(async (_id: string, p: { nonce: bigint }) => ({ nonce: p.nonce, deadline, feeUSDT: 1_000n, maxGas: 500_000 })) };
  const authorizer = { signExactIntent: vi.fn(async (address: Address, intent: Parameters<typeof intentTypedData>[0]) => merchant.signTypedData(intentTypedData(intent, address))) };
  const funded: FundedConfiguration = { route: { router, gateway, gasTank, feeVault, factory, runtimeHashes: Object.fromEntries([router, gateway, gasTank, factory, USDT].map(a => [a.toLowerCase(), keccak256('0x00')])) }, outerGas: 900_000n, maxTargetGas: 500_000, maxFeeUSDT: 2_000n, terms, authorizer };
  const ports: X402WritePorts = {
    writer, chainId: vi.fn(async () => 1874), transactionCount: vi.fn(async () => 0), latestBlock: vi.fn(async () => head),
    prepare: vi.fn(async (r, nonce) => { const raw = await relayer.signTransaction({ type: 'legacy', chainId: 1874, to: r.to, data: r.data, value: r.value, nonce, gas: r.gas, gasPrice: r.maxFeePerGas }); return { raw, hash: keccak256(raw) }; }),
    broadcast: vi.fn(async raw => { const hash = keccak256(raw); if (accepted) receipts.set(hash, await proof(hash)); return hash; }),
    receipt: vi.fn(async hash => receipts.get(hash) ?? null), reservationValid: vi.fn(async () => true), simulateFunded: vi.fn(async () => undefined),
  };
  const sponsorship = { authorize: vi.fn(async () => ({ policyId: 'mock-transport-genuine-synthetic-merchant-key', maxFeePerGas: 2n, merchantDailyLimitWei: 1_000_000_000n, merchantDailyCalls: 20 })) };
  const config = { db, writer, ports, funded, sponsorship, maxSpendPerMinuteWei: 1_000_000_000n, confirmations: 2n };
  const coordinator = new X402WriteCoordinator(config), journal = new SqliteFundedX402Journal(coordinator);
  async function proof(hash: Hex, op = operation()): Promise<X402Receipt> {
    const b = await coordinator.funded.binding(op.id), p = b.payment, i = b.request.intent;
    const logs: X402Receipt['logs'][number][] = [];
    logs.push({ address: gateway, topics: encodeEventTopics({ abi: fundedGatewayAbi, eventName: 'PaymentSettled', args: { permitDigest: p.permitDigest, payer, merchant: merchant.address } }) as Hex[], data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [p.proxy, p.nonce, p.ceiling, p.amount]) });
    logs.push({ address: p.proxy, topics: encodeEventTopics({ abi: events, eventName: 'Settled' }) as Hex[], data: '0x' });
    logs.push({ address: router, topics: encodeEventTopics({ abi: events, eventName: 'Executed', args: { signer: merchant.address, merchant: merchant.address, nonce: i.nonce } }) as Hex[], data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [gateway, 1_000_000n, i.feeUSDT]) });
    logs.push({ address: gasTank, topics: encodeEventTopics({ abi: events, eventName: 'Reimbursed', args: { merchant: merchant.address, relayer: relayer.address } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [1_000_000n]) });
    for (const [from, to, amount] of [[payer, merchant.address, p.amount], [merchant.address, feeVault, i.feeUSDT]] as const) logs.push({ address: USDT, topics: encodeEventTopics({ abi: events, eventName: 'Transfer', args: { from, to } }) as Hex[], data: encodeAbiParameters([{ type: 'uint256' }], [amount]) });
    return { txHash: hash, block: 10n, status: 'success', gasUsed: 600_000n, effectiveGasPrice: 2n, logs };
  }
  return { db, writer, ports, coordinator, journal, config, terms, authorizer, sponsorship, receipts, proof, setHead: (h: bigint) => head = h, setAccepted: (v: boolean) => accepted = v };
}
const events = parseAbi(['event Settled()', 'event Executed(address indexed signer,address indexed merchant,uint256 indexed nonce,address target,uint256 reimbursement,uint256 feeUSDT)', 'event Reimbursed(address indexed merchant,address indexed relayer,uint256 amount)', 'event Transfer(address indexed from,address indexed to,uint256 value)', 'event Refused(address indexed signer,address indexed merchant,uint256 indexed nonce,uint8 reason)']);
function operation(nonce = 1n, amount = 10_000n): SettlementOperation { return { id: `${NETWORK}:permit2:${payer}:${nonce}`, fingerprint: fingerprint({ nonce, amount }), payer, merchant: merchant.address, amount }; }
function proxyCall(op = operation(), upto = false): X402Transaction {
  const p = { permitted: { token: USDT, amount: 10_000n }, nonce: BigInt(op.id.split(':').at(-1)!), deadline };
  return { chainId: 1874, to: upto ? UPTO : EXACT, value: 0n, gas: 500_000n, data: upto
    ? encodeFunctionData({ abi: uptoSettlementAbi, functionName: 'settle', args: [p, op.amount, payer, { to: merchant.address, facilitator: gateway, validAfter: 0n }, signature] })
    : encodeFunctionData({ abi: exactSettlementAbi, functionName: 'settle', args: [p, payer, { to: merchant.address, validAfter: 0n }, signature] }) };
}
async function settle(f: ReturnType<typeof fixture>, op = operation(), upto = false) { return f.journal.runOnce(op, async () => ({ success: true, network: NETWORK, transaction: await f.journal.submit(op, proxyCall(op, upto)) })); }
const domain = (f: ReturnType<typeof fixture>) => f.db.prepare('SELECT * FROM x402_operations').get() as any;
const auth = (f: ReturnType<typeof fixture>) => f.db.prepare('SELECT * FROM x402_funded_operations').get() as any;

describe('funded production SQLite journal - mock transport, real signatures', () => {
  it.each([false, true])('serializes identical settlements and persists full funded evidence (upto=%s)', async upto => {
    const f = fixture(), op = operation(1n, upto ? 4_000n : 10_000n);
    const result = await Promise.all([settle(f, op, upto), settle(f, op, upto)]);
    expect(result[0].success).toBe(true); expect(result[1]).toEqual(result[0]);
    expect(f.authorizer.signExactIntent).toHaveBeenCalledTimes(1); expect(f.terms.reserve).toHaveBeenCalledTimes(1); expect(f.ports.broadcast).toHaveBeenCalledTimes(1);
    expect(domain(f).variant).toBe('funded'); expect(JSON.parse(auth(f).proof_json)).toMatchObject({ amount: op.amount.toString(), actualGasCostWei: '1200000', relayerNetGasCostWei: '200000' });
    expect(JSON.parse(domain(f).request_json).to).toBe(router);
    const r = fixture(f.db.serialize()); expect(await settle(r, op, upto)).toEqual(result[0]); expect(r.authorizer.signExactIntent).not.toHaveBeenCalled(); expect(r.ports.prepare).not.toHaveBeenCalled();
  });
  it.each([false, true])('shares Permit2 nonce identity with direct variant, both claim orders (fundedFirst=%s)', async fundedFirst => {
    const f = fixture(), direct = new SqliteX402Journal(f.coordinator), op = operation();
    const claimDirect = () => direct.runOnce(op, async () => ({ success: false, transaction: '', network: NETWORK, errorReason: 'test' }));
    if (fundedFirst) { await settle(f); await expect(claimDirect()).rejects.toThrow('idempotency_conflict'); }
    else { await claimDirect(); await expect(settle(f)).rejects.toThrow('idempotency_conflict'); }
    expect((f.db.prepare('SELECT COUNT(*) n FROM x402_operations').get() as any).n).toBe(1);
  });
  it('recovers accepted-but-timeout broadcasting crash without authorizer, policy, prepare or resend', async () => {
    const f = fixture(); let snapshot!: Buffer, hash!: Hex;
    vi.mocked(f.ports.broadcast).mockImplementation(async raw => { hash = keccak256(raw); expect(f.writer.rows()[0].phase).toBe('broadcasting'); snapshot = f.db.serialize(); throw new Error('accepted but response lost'); });
    const result = await f.journal.runOnce(operation(), async () => { await f.journal.submit(operation(), proxyCall()); throw new Error('HTTP timeout'); });
    expect(result.success).toBe(false); expect(f.writer.rows()[0].phase).toBe('uncertain');
    const r = fixture(snapshot); r.setHead(10n);
    expect((await settle(r)).success).toBe(false); expect(r.writer.rows()[0].phase).toBe('broadcasting');
    r.receipts.set(hash, await r.proof(hash)); await r.journal.reconcile(); expect(r.writer.rows()[0].phase).toBe('broadcasting');
    r.setHead(12n); await r.journal.reconcile(); expect(await settle(r)).toMatchObject({ success: true, transaction: hash });
    expect(r.terms.reserve).not.toHaveBeenCalled(); expect(r.authorizer.signExactIntent).not.toHaveBeenCalled(); expect(r.sponsorship.authorize).not.toHaveBeenCalled(); expect(r.ports.broadcast).not.toHaveBeenCalled(); expect(r.ports.prepare).not.toHaveBeenCalled();
  });
  it('missing receipt retains higher nonce holds and shares the existing writer queue', async () => {
    const f = fixture(); f.setAccepted(false);
    const first = await settle(f);
    const op = operation(2n); await settle(f, op);
    const rows = f.writer.rows(); expect(rows.map(r => r.nonce)).toEqual([0, 1]);
    f.receipts.set(first.transaction as Hex, await f.proof(first.transaction as Hex)); await f.journal.reconcile();
    expect(f.writer.rows()[0].phase).toBe('confirmed'); expect(f.writer.rows()[1].phase).toBe('submitted');
    expect(f.db.prepare('SELECT COUNT(*) n FROM relayer_spend_reservations').get()).toEqual({ n: 2 });
  });
  it('does not release writer queue when the HTTP callback abandons merchant signing', async () => {
    const f = fixture(); let release!: () => void;
    const gate = new Promise<void>(r => release = r), original = f.authorizer.signExactIntent.getMockImplementation()!;
    f.authorizer.signExactIntent.mockImplementation(async (...args) => { await gate; return original(...args); });
    // Configuration captured the bound mock function, whose implementation remains controllable.
    const task = f.journal.runOnce(operation(), async () => { void f.journal.submit(operation(), proxyCall()); throw new Error('HTTP canceled'); });
    while (!f.authorizer.signExactIntent.mock.calls.length) await new Promise(r => setTimeout(r, 1));
    let entered = false; const other = f.writer.run(async () => { entered = true; });
    await new Promise(r => setTimeout(r, 5)); expect(entered).toBe(false);
    release(); expect((await task).success).toBe(true); await other; expect(entered).toBe(true);
  });
  it('holds an accepted-but-timeout authorization and never obtains another signature after restart', async () => {
    const f = fixture(); let snapshot!: Buffer;
    f.authorizer.signExactIntent.mockImplementation(async (a, i) => { await merchant.signTypedData(intentTypedData(i, a)); snapshot = f.db.serialize(); throw new Error('provider response lost'); });
    expect(await settle(f)).toMatchObject({ success: false, errorReason: 'merchant_authorization_pending' });
    const r = fixture(snapshot); expect(await settle(r)).toMatchObject({ errorReason: 'merchant_authorization_pending' });
    expect(r.authorizer.signExactIntent).not.toHaveBeenCalled(); expect(r.terms.reserve).not.toHaveBeenCalled(); expect(r.ports.prepare).not.toHaveBeenCalled();
  });
  it('resumes a persisted authorized envelope before any prepare without reauthorizing', async () => {
    const f = fixture(); let snapshot!: Buffer;
    f.sponsorship.authorize.mockImplementation(async () => { snapshot = f.db.serialize(); throw new Error('process stopped at policy read'); });
    await settle(f); const original = auth(f).authorization_json;
    const r = fixture(snapshot); expect((await settle(r)).success).toBe(true);
    expect(auth(r).authorization_json).toBe(original); expect(r.authorizer.signExactIntent).not.toHaveBeenCalled(); expect(r.terms.reserve).not.toHaveBeenCalled(); expect(r.ports.broadcast).toHaveBeenCalledTimes(1);
  });
  it('preparation failure becomes durable not_sent and cannot re-sign that payment', async () => {
    const f = fixture(); f.ports.prepare = vi.fn(async () => { throw new Error('signer refused'); });
    expect(await settle(f)).toMatchObject({ success: false, errorReason: 'transaction_not_sent' });
    const r = fixture(f.db.serialize()); expect(await settle(r)).toMatchObject({ errorReason: 'transaction_not_sent' }); expect(r.ports.prepare).not.toHaveBeenCalled(); expect(r.authorizer.signExactIntent).not.toHaveBeenCalled();
  });
  it('requires policy plus actual merchant signature, and enforces shared durable budgets', async () => {
    const f = fixture(); f.config.sponsorship = inactiveM7SponsorshipPolicy as typeof f.sponsorship;
    expect(await settle(f)).toMatchObject({ success: false, errorReason: 'sponsorship_not_authorized' }); expect(f.ports.prepare).not.toHaveBeenCalled();
    const r = fixture(); r.authorizer.signExactIntent.mockResolvedValue(signature);
    expect((await settle(r)).success).toBe(false); expect(r.ports.prepare).not.toHaveBeenCalled();
    const b = fixture(); b.config.maxSpendPerMinuteWei = 1n;
    expect(await settle(b)).toMatchObject({ errorReason: 'circuit_budget' }); expect(b.ports.prepare).not.toHaveBeenCalled(); expect(b.writer.rows()).toHaveLength(0);
  });
  it('freezes route/terms/signature and prevents merchant nonce reuse for another permit', async () => {
    const f = fixture(); await settle(f);
    f.terms.reserve.mockResolvedValue({ nonce: 1n, deadline, feeUSDT: 1_000n, maxGas: 500_000 });
    expect((await settle(f, operation(2n))).success).toBe(false); expect(f.authorizer.signExactIntent).toHaveBeenCalledTimes(1);
    const changed = new X402WriteCoordinator({ ...f.config, funded: { ...f.config.funded, outerGas: 800_000n } });
    await expect(new SqliteFundedX402Journal(changed).runOnce(operation(), vi.fn())).rejects.toThrow('idempotency_conflict');
    await expect(settle(f, { ...operation(), fingerprint: fingerprint('altered') })).rejects.toThrow('idempotency_conflict');
  });
  it.each(['logs', 'gas', 'hash', 'signature'] as const)('does not accept incomplete or mutated %s evidence', async field => {
    const f = fixture(); f.setAccepted(false); const result = await settle(f); const r = await f.proof(result.transaction as Hex);
    if (field === 'logs') r.logs = r.logs.slice(1);
    if (field === 'gas') r.effectiveGasPrice = 3n;
    if (field === 'hash') r.txHash = toHex(33n, { size: 32 });
    if (field === 'signature') { const parsed = JSON.parse(auth(f).authorization_json); parsed.request.signature = signature; f.db.prepare('UPDATE x402_funded_operations SET authorization_json=?').run(canonicalJson(parsed)); }
    f.receipts.set(result.transaction as Hex, r); await f.journal.reconcile(); expect((await settle(f)).success).toBe(false); expect(f.ports.broadcast).toHaveBeenCalledTimes(1);
  });
  it('terminally records an actual matching Router Refused event without treating native success as payment', async () => {
    const f = fixture(); f.setAccepted(false); const result = await settle(f);
    const r: X402Receipt = { txHash: result.transaction as Hex, block: 10n, status: 'success', logs: [{ address: router, topics: encodeEventTopics({ abi: events, eventName: 'Refused', args: { signer: merchant.address, merchant: merchant.address, nonce: 1n } }) as Hex[], data: encodeAbiParameters([{ type: 'uint8' }], [10]) }] };
    f.receipts.set(r.txHash, r); await f.journal.reconcile(); expect(await settle(f)).toMatchObject({ success: false, errorReason: 'funded_router_refused:10' }); expect(f.ports.broadcast).toHaveBeenCalledTimes(1);
  });
  it('migrates legacy direct rows without changing their immutable identity', async () => {
    const f = fixture(), direct = new SqliteX402Journal(f.coordinator);
    const result = await direct.runOnce(operation(), async () => ({ success: false, transaction: '', network: NETWORK, errorReason: 'legacy_failure' }));
    const identity = domain(f).identity_json; f.db.exec('ALTER TABLE x402_operations DROP COLUMN variant');
    const r = fixture(f.db.serialize()); expect(domain(r).variant).toBe('direct'); expect(domain(r).identity_json).toBe(identity);
    expect(await new SqliteX402Journal(r.coordinator).runOnce(operation(), vi.fn())).toEqual(result);
  });
  it('attests funded route links and pinned runtimes before advertising support', async () => {
    const f = fixture(); const expected: Record<string, Address> = { [`${gateway}:router`]: router, [`${gateway}:factory`]: factory, [`${router}:usdt`]: USDT, [`${router}:gasTank`]: gasTank, [`${router}:feeVault`]: feeVault, [`${gasTank}:router`]: router };
    const pub = { getChainId: async () => 1874, getCode: async () => '0x00', readContract: vi.fn(async ({ address, functionName }: any) => expected[`${address}:${functionName}`]) } as unknown as PublicClient;
    await f.journal.initialize(pub);
    vi.mocked(pub.readContract).mockResolvedValue(gateway as never); await expect(f.journal.initialize(pub)).rejects.toThrow('funded_route_mismatch');
  });
});
