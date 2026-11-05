import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, hashTypedData, keccak256, toHex, encodeFunctionData, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain, subscriptionV2Abi } from '../src/chain.js';
import { FundedRenewals, RENEWAL_USDT, type MerchantRenewalSigner, type RenewalSnapshot } from '../src/funded-renewals.js';
import { grantHash, type RenewalGrant } from '../src/funded-renewal-store.js';
import { mandateTypedData } from '../src/typed-data.js';
import { Indexer } from '../src/indexer.js';
import { runKeeper } from '../src/keeper.js';
import { reserveRenewal } from '../src/write-reservations.js';
import type { ChainEvent } from '../src/types.js';
import { createApp } from '../src/app.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { bindSubscriptions } from '../src/subscription-binding.js';

const merchant = privateKeyToAccount(`0x${'3'.repeat(64)}`), payer = privateKeyToAccount(`0x${'2'.repeat(64)}`);
const router = '0x0000000000000000000000000000000000000001', manager = '0x0000000000000000000000000000000000000002';
const start = new Date('2026-11-06T00:00:00Z'), time = BigInt(start.getTime() / 1000);
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(start);
  const db = openDb(), chain = new FakeChain(false, 2); chain.writer.bind(db);
  bindSubscriptions(db, manager, 2);
  chain.tank.set(merchant.address.toLowerCase(), { balanceWei: 10n ** 18n, dailyCapWei: 10n ** 18n, spentTodayWei: 0n });
  const keys = seedMerchant(db, merchant.address);
  db.prepare('INSERT INTO plans(id,merchant_id,name,amount_minor,period_seconds,max_periods,created_at) VALUES (?,?,?,?,?,?,?)').run('plan', keys.merchantId, 'Daily', '2000000', 86400, 12, start.toISOString());
  const mandate = { payer: payer.address, merchant: merchant.address, planId: keccak256(toHex('plan')), amountCap: 2_000_000n, periodSeconds: 86400n, maxPeriods: 12, endTime: time + 86400n * 13n, nonce: 0n };
  const subId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'address' }], [payer.address, 0n, manager]));
  db.prepare('INSERT INTO subscriptions(id,merchant_id,plan_id,chain_id,payer,status,next_charge_at,retry_count,pending_tx_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('sub', keys.merchantId, 'plan', subId, payer.address, 'active', start.toISOString(), 0, null, start.toISOString());
  const grant: RenewalGrant = {
    version: 1, merchantId: keys.merchantId, merchant: merchant.address, subscriptionId: 'sub', chainId: 1874, router, manager, token: RENEWAL_USDT, chainSubscriptionId: subId,
    binding: { appId: 'synthetic-app', userId: 'synthetic-user', walletId: 'synthetic-wallet', signerId: 'synthetic-signer', policyId: 'synthetic-policy', policyHash: keccak256(toHex('policy')) },
    mandate, mandateHash: hashTypedData(mandateTypedData(mandate, manager, '2')), dataHash: keccak256(encodeFunctionData({ abi: subscriptionV2Abi, functionName: 'charge', args: [subId, 2_000_000n] })), amount: 2_000_000n,
    validFrom: time, validUntil: time + 86400n * 12n, maxFeeUSDT: 10000n, maxGas: 400_000, maxGasPriceWei: 2_000_000_000n,
    maxTransactionCostWei: 2n * 10n ** 15n, maxTotalGasWei: 10n ** 17n, maxCalls: 12, maxCallsPerDay: 2, maxFeesPerDay: 20000n, maxFeesTotal: 120000n, maxSigningRevisions: 3,
    acceptance: { kind: 'synthetic-local', reference: 'unit test only; no actual delegated authorization' },
  };
  const snapshot: RenewalSnapshot = { chainId: 1874, manager, router, token: RENEWAL_USDT, subscriptionId: subId, blockNumber: 20n, blockHash: keccak256(toHex('block20')), timestamp: time, subscription: { ...mandate, chargedPeriods: 0, nextChargeAt: time, cancelled: false }, chargeAllowed: true, mustReturnTrue: true };
  const reader = { read: vi.fn(async () => structuredClone(snapshot)) };
  const signer: MerchantRenewalSigner = { signExactIntent: vi.fn(async input => ({ signature: await merchant.signTypedData(input.typedData), providerRequestId: 'synthetic-request' })) };
  const options = { mode: 'synthetic-test' as const, localGasBudgetWei: 10n ** 17n, reader, signer };
  const service = new FundedRenewals(db, chain, options);
  const install = (value = grant) => service.installSyntheticGrant(value);
  const row = () => db.prepare('SELECT * FROM subscriptions').get() as { status: string; retry_count: number; pending_tx_hash: Hex | null; next_charge_at: string };
  function receipt(hash: Hex, change?: (events: ChainEvent[]) => void) {
    const request = chain.sent[0].request, block = 21n;
    const events: ChainEvent[] = [
      { id: `${hash}:charge`, block, txHash: hash, timestamp: start.toISOString(), contract: 'subscription', name: 'Charged', args: { id: subId, amount: 2_000_000n, period: 1 } },
      { id: `${hash}:executed`, block, txHash: hash, contract: 'router', name: 'Executed', feeRecipient: chain.feeRecipient, args: { signer: merchant.address, merchant: merchant.address, nonce: request.intent.nonce, target: manager, reimbursement: 123n, feeUSDT: 10000n } },
      { id: `${hash}:reimbursed`, block, txHash: hash, contract: 'gasTank', name: 'Reimbursed', args: { merchant: merchant.address, relayer: chain.writer.relayer, amount: 123n } },
    ];
    change?.(events);
    chain.receipts.set(hash, { txHash: hash, block, status: 'success', events }); chain.block = 23n;
  }
  return { db, chain, keys, grant, snapshot, reader, signer, options, service, install, row, receipt };
}
afterEach(() => vi.useRealTimers());
describe('local funded renewal authorization', () => {
  it('binds a funded grant to the exact discounted renewal amount while retaining the full mandate cap', () => {
    const f = fixture();
    f.db.prepare("UPDATE subscriptions SET discount_code='SAVE',amount_discount_minor='500000',discount_duration='repeating',discount_periods='2' WHERE id='sub'").run();
    expect(() => f.install()).toThrowError(/subscription_binding_changed/);
    const amount = 1_500_000n;
    const grant = { ...f.grant, amount, dataHash: keccak256(encodeFunctionData({ abi: subscriptionV2Abi, functionName: 'charge', args: [f.grant.chainSubscriptionId, amount] })) };
    expect(f.install(grant)).toMatch(/^0x/);
    expect(grant.mandate.amountCap).toBe(2_000_000n);
    f.db.close();
  });
  it('shares the funded service across HTTP and keeper with private durable status', async () => {
    const f = fixture(); f.install();
    const escrow = '0x0000000000000000000000000000000000000003';
    const app = createApp({ db: f.db, chain: f.chain, renewals: f.service, router, subscription: manager, escrow,
      relayer: new Relayer(f.chain, router, allowedTargets(escrow, manager, 2)) });
    const headers = { authorization: `Bearer ${f.keys.secretKey}`, 'content-type': 'application/json' };
    const direct = vi.spyOn(f.chain, 'renew');
    const sent = await app.request('/v1/subscriptions/sub/renew', { method: 'POST', headers, body: '{}' });
    expect(sent.status).toBe(200); const submission = await sent.json();
    expect(submission).toMatchObject({ id: 'sub', status: 'submitted' });
    expect(f.chain.sent).toHaveLength(1); expect(direct).not.toHaveBeenCalled();
    const status = () => app.request('/v1/subscriptions/sub/renewal', { headers });
    expect(await (await status()).json()).toMatchObject({ state: 'pending', txHash: submission.txHash });
    f.receipt(submission.txHash); await new Indexer(f.db, f.chain).poll();
    expect(await (await status()).json()).toMatchObject({ state: 'confirmed', txHash: submission.txHash });
    expect((await app.request('/v1/subscriptions/sub/renewal', { headers: { authorization: `Bearer ${f.keys.publishableKey}` } })).status).toBe(403);
    const other = seedMerchant(f.db, payer.address);
    expect((await app.request('/v1/subscriptions/sub/renewal', { headers: { authorization: `Bearer ${other.secretKey}` } })).status).toBe(404);
    expect((await status()).headers.get('cache-control')).toBe('no-store');
    // A disabled restart may retain a confirmed hash for history; it must never
    // report that old transaction as a new manual renewal submission.
    const inactive = createApp({ db: f.db, chain: f.chain, router, subscription: manager, escrow,
      relayer: new Relayer(f.chain, router, allowedTargets(escrow, manager, 2)) });
    f.db.prepare("UPDATE subscriptions SET next_charge_at='2026-11-06T00:00:00Z' WHERE id='sub'").run();
    const refused = await inactive.request('/v1/subscriptions/sub/renew', { method: 'POST', headers, body: '{}' });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ error: { code: 'automatic_funded_renewal_disabled' } });
    expect(await (await inactive.request('/v1/subscriptions/sub/renewal', { headers })).json()).toMatchObject({ state: 'confirmed', txHash: submission.txHash, automatic: 'disabled' });
    expect(f.chain.sent).toHaveLength(1);
  });
  it('disables unsigned manual renewals by default and rejects a service using a different writer', async () => {
    const f = fixture();
    const relayer = new Relayer(f.chain, router, allowedTargets(manager, manager, 2));
    const services = { db: f.db, chain: f.chain, router, subscription: manager, relayer } as const;
    const app = createApp(services), direct = vi.spyOn(f.chain, 'renew');
    const headers = { authorization: `Bearer ${f.keys.secretKey}`, 'content-type': 'application/json' };
    const response = await app.request('/v1/subscriptions/sub/renew', { method: 'POST', headers, body: '{}' });
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'automatic_funded_renewal_disabled' } });
    expect(direct).not.toHaveBeenCalled(); expect(f.chain.writer.rows()).toHaveLength(0);
    expect(await (await app.request('/v1/subscriptions/sub/renewal', { headers })).json()).toMatchObject({ state: 'disabled' });
    expect(() => createApp({ ...services, renewals: new FundedRenewals(f.db, new FakeChain(false, 2)) })).toThrow('must share');
  });
  it('keeps default keeper disabled without sending directly; identity alone is insufficient', async () => {
    const f = fixture(), direct = vi.spyOn(f.chain, 'renew');
    await runKeeper(f.db, f.chain);
    expect(f.service.store.status('sub')).toMatchObject({ state: 'disabled' });
    expect(await f.service.renew('sub')).toMatchObject({ state: 'delegation_required' });
    expect(direct).not.toHaveBeenCalled(); expect(f.chain.sent).toHaveLength(0);
    expect(f.row()).toMatchObject({ status: 'active', retry_count: 0, pending_tx_hash: null });
    expect(() => new FundedRenewals(f.db, { ...f.chain } as never, f.options)).toThrow('live activation unavailable');
    expect(() => new FundedRenewals(f.db, f.chain, { ...f.options, localGasBudgetWei: 0n })).toThrow('finite local budget');
  });
  it('freezes exact grant and rejects policy/target/amount/binding changes', () => {
    const f = fixture(); const hash = f.install();
    f.grant.maxFeeUSDT = 999999n;
    expect(f.service.store.getGrant(hash)?.maxFeeUSDT).toBe(10000n);
    expect(() => f.db.prepare("UPDATE renewal_grants SET payload='{}'").run()).toThrow('immutable');
    expect(() => f.db.prepare('DELETE FROM renewal_grants').run()).toThrow('immutable');
    expect(() => f.install({ ...f.grant, manager: router })).toThrow('grant_digest');
    expect(() => f.install({ ...f.grant, amount: 3_000_000n })).toThrow('grant_digest');
    expect(() => f.install({ ...f.grant, binding: { ...f.grant.binding, policyId: '' } })).toThrow('delegation_required');
    expect(() => f.install(f.grant)).toThrow('revoke_previous_grant');
  });
  it('persists before calling signer, recovers the real merchant, and uses the SAME writer via strict Router', async () => {
    const f = fixture(); f.install(); const direct = vi.spyOn(f.chain, 'renew');
    vi.mocked(f.signer.signExactIntent).mockImplementation(async input => {
      const revision = f.db.prepare('SELECT typed_data_json FROM renewal_signing_revisions WHERE operation_id=?').get(input.operationId) as { typed_data_json: string };
      expect(JSON.parse(revision.typed_data_json).message.signer).toBe(merchant.address);
      expect(f.chain.writer.record(input.operationId)?.phase).toBe('preparing');
      expect(() => reserveRenewal(f.db, f.chain, 'sub')).toThrow('subscription_pending');
      expect(input.typedData.message.deadline).toBe(time + 120n);
      return { signature: await merchant.signTypedData(input.typedData), providerRequestId: 'synthetic-request' };
    });
    await runKeeper(f.db, f.chain, start, f.service);
    expect(direct).not.toHaveBeenCalled(); expect(f.chain.sent).toHaveLength(1);
    expect(f.chain.sent[0].request.intent).toMatchObject({ signer: merchant.address, merchant: merchant.address, target: manager, amount: 2_000_000n });
    expect(f.chain.writer.rows()).toMatchObject([{ kind: 'renew', phase: 'submitted', nonce: 0, tx_hash: f.row().pending_tx_hash }]);
    expect(f.db.prepare('SELECT * FROM relayer_spend_reservations').all()).toHaveLength(1);
    expect(f.service.store.status('sub').state).toBe('pending');
    f.receipt(f.row().pending_tx_hash!); f.chain.block = 22n;
    const indexer = new Indexer(f.db, f.chain); await indexer.poll();
    expect(f.service.store.status('sub').state).toBe('pending');
    f.chain.block = 23n; await indexer.poll(); await indexer.poll();
    expect(f.service.store.status('sub').state).toBe('confirmed');
    expect(f.row()).toMatchObject({ status: 'active', next_charge_at: '2026-11-07T00:00:00.000Z', pending_tx_hash: null });
    expect(f.db.prepare('SELECT cost_wei,fee_usdt FROM gas_ledger').all()).toEqual([{ cost_wei: '123', fee_usdt: '10000' }]);
  });
  it.each(['wrong_signer', 'changed_payload', 'sign_rejected', 'revoked', 'cancelled', 'period_changed'] as const)('does not send after %s during signing', async scenario => {
    const f = fixture(), hash = f.install();
    vi.mocked(f.signer.signExactIntent).mockImplementation(async input => {
      if (scenario === 'sign_rejected') throw new Error('User rejected signing');
      if (scenario === 'revoked') f.service.store.revoke(hash, 'owner revoked');
      if (scenario === 'cancelled') f.db.prepare("UPDATE subscriptions SET status='cancelled'").run();
      if (scenario === 'period_changed') f.snapshot.subscription.chargedPeriods++;
      if (scenario === 'changed_payload') input.typedData.message.feeUSDT++;
      return { signature: await (scenario === 'wrong_signer' ? payer : merchant).signTypedData(input.typedData), providerRequestId: 'local' };
    });
    await expect(f.service.renew('sub')).rejects.toThrow();
    expect(f.chain.sent).toHaveLength(0); expect(f.chain.writer.rows()[0].phase).toBe('not_sent');
    expect(f.row().retry_count).toBe(0);
    if (scenario === 'cancelled') expect(f.row().status).toBe('cancelled');
  });
  it.each(['policy', 'stale', 'too_early', 'wrong_suite', 'binding', 'fee_budget', 'gas_budget'] as const)('refuses %s before requesting a signature', async scenario => {
    const f = fixture();
    if (scenario === 'fee_budget') f.grant.maxFeesTotal = 1n;
    if (scenario === 'gas_budget') f.grant.maxTransactionCostWei = 1n;
    f.install();
    if (scenario === 'policy') f.snapshot.mustReturnTrue = false;
    if (scenario === 'stale') f.snapshot.timestamp -= 31n;
    if (scenario === 'too_early') f.snapshot.subscription.nextChargeAt++;
    if (scenario === 'wrong_suite') f.snapshot.router = manager;
    if (scenario === 'binding') f.db.prepare("UPDATE plans SET amount_minor='3000000'").run();
    await expect(f.service.renew('sub')).rejects.toThrow();
    expect(f.signer.signExactIntent).not.toHaveBeenCalled(); expect(f.chain.sent).toHaveLength(0);
  });
  it('leaves generic simulation_refused strict: no code-5 send, fee or billing retry', async () => {
    const f = fixture(); f.install(); f.chain.simulation = { accepted: false, reason: 'insufficient funds code 5', gas: 50000n };
    await expect(f.service.renew('sub')).rejects.toMatchObject({ code: 'simulation_refused' });
    expect(f.chain.sent).toHaveLength(0); expect(f.row()).toMatchObject({ status: 'active', retry_count: 0 });
    expect(f.db.prepare('SELECT * FROM gas_ledger').all()).toHaveLength(0);
    expect(f.db.prepare('SELECT * FROM subscription_service_backoff').all()).toHaveLength(1);
  });
  it.each(['revocation', 'cancellation'] as const)('rechecks %s inside transaction preparation after simulation', async scenario => {
    const f = fixture(); const hash = f.install();
    vi.spyOn(f.chain, 'simulate').mockImplementation(async () => {
      if (scenario === 'revocation') f.service.store.revoke(hash, 'owner revoked while waiting');
      else f.db.prepare("UPDATE subscriptions SET status='cancelled'").run();
      return { accepted: true, gas: 200000n };
    });
    await expect(f.service.renew('sub')).rejects.toThrow();
    expect(f.chain.sent).toHaveLength(0); expect(f.chain.writer.rows()[0].phase).toBe('not_sent');
  });
  it('expires a signing revision within its reserved budget day', async () => {
    const f = fixture(); f.install();
    vi.setSystemTime(new Date('2026-11-06T23:59:40Z'));
    f.snapshot.timestamp = time + 86380n;
    await f.service.renew('sub');
    expect(f.chain.sent[0].request.intent.deadline).toBe(time + 86399n);
  });
  it('uses the next daily retry ordinal after a confirmed legacy insufficient-funds event', async () => {
    const f = fixture(); f.install();
    f.db.prepare("UPDATE subscriptions SET status='past_due',retry_count=2").run();
    await f.service.renew('sub');
    expect(f.db.prepare('SELECT period,retry FROM renewal_attempts').get()).toEqual({ period: 1, retry: 3 });
  });
  it('cannot overbook finite operator exposure while another grant is pending', async () => {
    const f = fixture(); f.install();
    const service = new FundedRenewals(f.db, f.chain, { ...f.options, localGasBudgetWei: 1n });
    await expect(service.renew('sub')).rejects.toThrow('renewal_operator_budget');
    expect(f.signer.signExactIntent).not.toHaveBeenCalled();
  });
  it("respects a different feature's uncertain account nonce without another send", async () => {
    const f = fixture(); f.install();
    vi.spyOn(f.chain, 'broadcastTransaction').mockRejectedValueOnce(new Error('ambiguous other write'));
    await f.chain.renew(keccak256(toHex('other subscription')), 2000000n);
    await expect(f.service.renew('sub')).rejects.toThrow('relayer_pending');
    expect(f.chain.writer.rows().map(row => row.phase)).toEqual(['uncertain', 'not_sent']);
    expect(f.chain.broadcastTransaction).toHaveBeenCalledTimes(1);
    expect(f.row()).toMatchObject({ status: 'active', retry_count: 0 });
  });
  it('bounds frozen signing revisions for proven-unsent operations and does not mutate old typed data', async () => {
    const f = fixture(); f.install(); vi.mocked(f.signer.signExactIntent).mockRejectedValue(new Error('sign-only timeout'));
    for (let n = 0; n < 3; n++) await expect(f.service.renew('sub')).rejects.toThrow('sign-only timeout');
    await expect(f.service.renew('sub')).rejects.toThrow('signing_revision_limit');
    const rows = f.db.prepare('SELECT * FROM renewal_signing_revisions').all() as { request_json: string }[];
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map(r => JSON.parse(r.request_json).intent.nonce)).size).toBe(3);
    expect(f.db.prepare('SELECT * FROM renewal_attempts').all()).toHaveLength(1);
    expect(() => f.db.prepare("UPDATE renewal_signing_revisions SET request_json='{}'").run()).toThrow('immutable');
  });
});

describe('funded renewal durable recovery and evidence', () => {
  it('disabling during a hashless preparation preserves operation identity and does not release or resend', async () => {
    const f = fixture(); f.install(); let release!: (s: RenewalSnapshot) => void;
    f.reader.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const running = f.service.renew('sub'); await Promise.resolve();
    const original = f.chain.writer.rows()[0];
    expect(original).toMatchObject({ phase: 'preparing', tx_hash: null });
    const disabled = new FundedRenewals(f.db, f.chain);
    expect(await disabled.renew('sub')).toMatchObject({ state: 'pending', operationId: original.operation_id, automatic: 'disabled' });
    expect(f.chain.writer.rows()[0]).toEqual(original);
    expect((f.db.prepare('SELECT operation_id FROM renewal_service_status').get() as any).operation_id).toBe(original.operation_id);
    expect(f.chain.sent).toHaveLength(0);
    release(structuredClone(f.snapshot)); await running;
  });
  it.each(['preparing', 'signed', 'broadcasting'] as const)('recovers disabled status from journal when its %s pointer was lost', async phase => {
    const f = fixture(); f.install(); let crash: Buffer | undefined;
    const prepare = f.db.prepare.bind(f.db);
    if (phase === 'preparing') vi.mocked(f.signer.signExactIntent).mockImplementation(async input => { crash = f.db.serialize(); return { signature: await merchant.signTypedData(input.typedData), providerRequestId: 'local' }; });
    if (phase === 'signed') vi.spyOn(f.db, 'prepare').mockImplementation(((sql: string) => {
      if (sql.startsWith("UPDATE relayer_operations SET phase='broadcasting'")) crash = f.db.serialize();
      return prepare(sql);
    }) as typeof f.db.prepare);
    if (phase === 'broadcasting') {
      const broadcast = f.chain.broadcastTransaction.bind(f.chain);
      vi.spyOn(f.chain, 'broadcastTransaction').mockImplementation(async raw => { crash = f.db.serialize(); return broadcast(raw); });
    }
    await f.service.renew('sub'); expect(crash).toBeDefined();
    const db = new Database(crash!), chain = new FakeChain(false, 2); chain.writer.bind(db);
    // AccountWriter startup alone retires proven-unsent preparation/signing.
    // The disabled service must not make any additional journal transition.
    const before = chain.writer.rows();
    db.prepare("UPDATE renewal_service_status SET operation_id=NULL,state='disabled'").run();
    const disabled = new FundedRenewals(db, chain);
    const status = await disabled.renew('sub');
    expect(status).toMatchObject({ state: phase === 'broadcasting' ? 'pending' : 'not_sent', operationId: before[0].operation_id, automatic: 'disabled' });
    expect(disabled.store.status('sub').operationId).toBe(before[0].operation_id);
    expect(chain.writer.rows()).toEqual(before); expect(chain.sent).toHaveLength(0);
    db.close();
  });
  it('reserves synchronously and rejects concurrent renewal/cancel/replacement reservations', async () => {
    const f = fixture(); f.install(); let release!: (s: RenewalSnapshot) => void;
    f.reader.read.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = f.service.renew('sub');
    await expect(f.service.renew('sub')).rejects.toThrow('subscription_pending');
    expect(() => reserveRenewal(f.db, f.chain, 'sub')).toThrow('subscription_pending');
    await Promise.resolve(); release(structuredClone(f.snapshot)); await first;
    expect(f.chain.sent).toHaveLength(1);
  });
  it.each(['awaiting_signature', 'signed', 'broadcasting'] as const)('recovers a crash image at %s without duplicate submission', async phase => {
    const f = fixture(); f.install(); let image: Buffer | undefined;
    if (phase === 'awaiting_signature') vi.mocked(f.signer.signExactIntent).mockImplementation(async input => { image = f.db.serialize(); return { signature: await merchant.signTypedData(input.typedData), providerRequestId: 'local' }; });
    if (phase === 'signed') {
      const prepare = f.db.prepare.bind(f.db);
      vi.spyOn(f.db, 'prepare').mockImplementation(((sql: string) => {
        if (sql.startsWith("UPDATE relayer_operations SET phase='broadcasting'")) image = f.db.serialize();
        return prepare(sql);
      }) as typeof f.db.prepare);
    }
    if (phase === 'broadcasting') {
      const broadcast = f.chain.broadcastTransaction.bind(f.chain);
      vi.spyOn(f.chain, 'broadcastTransaction').mockImplementation(async raw => { image = f.db.serialize(); return broadcast(raw); });
    }
    await f.service.renew('sub'); expect(image).toBeDefined();
    const db = new Database(image!), chain = new FakeChain(false, 2); chain.writer.bind(db);
    chain.tank = f.chain.tank;
    const restarted = new FundedRenewals(db, chain, f.options);
    if (phase === 'broadcasting') {
      expect(restarted.store.status('sub').state).toBe('pending');
      await expect(restarted.renew('sub')).rejects.toThrow('subscription_pending');
      expect(chain.sent).toHaveLength(0);
    } else {
      expect(restarted.store.status('sub').state).toBe('not_sent');
      await restarted.renew('sub');
      expect(chain.sent).toHaveLength(1);
      expect(db.prepare('SELECT * FROM renewal_signing_revisions').all()).toHaveLength(2);
    }
    db.close();
  });
  it('accepted-but-timeout stays pending across restart and stale nonce counts, without re-sign or resend', async () => {
    const f = fixture(); f.install(); const broadcast = f.chain.broadcastTransaction.bind(f.chain);
    vi.spyOn(f.chain, 'broadcastTransaction').mockImplementation(async raw => { await broadcast(raw); throw new Error('accepted but timed out'); });
    const result = await f.service.renew('sub'); expect(result.state).toBe('pending');
    expect(f.chain.writer.rows()[0].phase).toBe('uncertain');
    const db = new Database(f.db.serialize()), chain = new FakeChain(false, 2); chain.writer.bind(db);
    const restarted = new FundedRenewals(db, chain, f.options);
    for (const receipt of [null, new Error('RPC unavailable')]) {
      chain.receipts.set(result.txHash!, receipt); chain.block = 23n;
      await new Indexer(db, chain).poll();
      await expect(restarted.renew('sub')).rejects.toThrow('subscription_pending');
    }
    expect(f.signer.signExactIntent).toHaveBeenCalledTimes(1); expect(chain.sent).toHaveLength(0);
    f.receipt(result.txHash!); chain.receipts = f.chain.receipts;
    await new Indexer(db, chain).poll();
    expect(restarted.store.status('sub').state).toBe('confirmed');
    expect(chain.writer.record(result.operationId!)?.phase).toBe('confirmed');
    const op = chain.writer.operation('renew', 'unrelated'); chain.writer.reserve(op);
    await chain.writer.run(() => chain.writer.execute(op, async () => 0, n => chain.prepareRenew(keccak256(toHex('another')), 2_000_000n, n), raw => chain.broadcastTransaction(raw)), op.id);
    expect(chain.writer.record(op.id)?.nonce).toBe(1); db.close();
  });
  it.each(['period', 'missing_executed', 'missing_reimbursement', 'fee', 'relayer', 'id'] as const)('does not settle or bypass fallback on wrong %s evidence', async scenario => {
    const f = fixture(); f.install(); const result = await f.service.renew('sub');
    f.receipt(result.txHash!, events => {
      if (scenario === 'period') events[0].args.period = 2;
      if (scenario === 'id') events[0].args.id = keccak256(toHex('wrong subscription'));
      if (scenario === 'missing_executed') events.splice(1, 1);
      if (scenario === 'missing_reimbursement') events.splice(2, 1);
      if (scenario === 'fee') events[1].args.feeUSDT = 10001n;
      if (scenario === 'relayer') events[2].args.relayer = payer.address;
    });
    const indexer = new Indexer(f.db, f.chain); await indexer.poll(); await indexer.poll();
    expect(f.service.store.status('sub').state).toBe('reconciliation_required');
    expect(f.row()).toMatchObject({ status: 'reconciliation_required', pending_tx_hash: result.txHash, next_charge_at: start.toISOString() });
    expect(f.db.prepare('SELECT * FROM gas_ledger').all()).toHaveLength(0);
    expect(f.chain.writer.record(result.operationId!)?.phase).toBe('confirmed');
    await expect(f.service.renew('sub')).rejects.toThrow('subscription_pending');
  });
  it('releases a confirmed reverted nonce but never automatically resends that semantic attempt', async () => {
    const f = fixture(); f.install(); const result = await f.service.renew('sub');
    f.chain.receipts.set(result.txHash!, { txHash: result.txHash!, block: 21n, status: 'reverted', events: [] }); f.chain.block = 23n;
    await new Indexer(f.db, f.chain).poll();
    expect(f.service.store.status('sub').state).toBe('failed');
    expect(f.row()).toMatchObject({ status: 'paused', pending_tx_hash: null });
    f.db.prepare("UPDATE subscriptions SET status='active'").run();
    await expect(f.service.renew('sub')).rejects.toThrow('renewal_attempt_pending_or_settled');
    expect(f.chain.sent).toHaveLength(1);
  });
  it('does not reuse a confirmed semantic period even if local scheduling state is stale', async () => {
    const f = fixture(); f.install(); const result = await f.service.renew('sub'); f.receipt(result.txHash!);
    await new Indexer(f.db, f.chain).poll();
    f.db.prepare('UPDATE subscriptions SET next_charge_at=?').run(start.toISOString());
    await expect(f.service.renew('sub')).rejects.toThrow('renewal_attempt_pending_or_settled');
    expect(f.chain.sent).toHaveLength(1);
  });
});
