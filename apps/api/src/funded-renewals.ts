import { encodeAbiParameters, encodeFunctionData, hashTypedData, isAddress, keccak256, recoverTypedDataAddress, toHex, type Address, type Hex } from 'viem';
import { FakeChain, subscriptionV2Abi } from './chain.js';
import type { Db } from './db.js';
import { id, now } from './db.js';
import { Relayer } from './relayer.js';
import { Refusal, type ChainAdapter, type IntentRequest, type Mandate } from './types.js';
import { intentTypedData, mandateTypedData } from './typed-data.js';
import { assertSubscriptionAvailable } from './write-reservations.js';
import { grantHash, json, RenewalStore, setRenewalStatus, type RenewalGrant, type RenewalStatus } from './funded-renewal-store.js';
import type { WriteOperation } from './account-writer.js';
import { assertLocalRenewalCapability, type LocalRenewalCapability } from './local/renewal-fork.js';
import { chargedPeriods, renewalDiscountAmount } from './discounts.js';

export const RENEWAL_USDT = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7' as const;
/** Sign-only: a provider must never broadcast or choose/modify a typed field.
 * A providerRequestId is an audit reference, NOT proof of delegated authority. */
export interface MerchantRenewalSigner {
  signExactIntent(request: {
    binding: Readonly<RenewalGrant['binding']>; grantHash: Hex; operationId: string;
    expectedMerchantAddress: Address; typedData: ReturnType<typeof intentTypedData>;
  }): Promise<{ signature: Hex; providerRequestId: string }>;
}
export interface RenewalSnapshot {
  chainId: number; manager: Address; router: Address; token: Address; subscriptionId: Hex;
  blockNumber: bigint; blockHash: Hex; timestamp: bigint;
  subscription: Omit<Mandate, 'nonce'> & { chargedPeriods: number; nextChargeAt: bigint; cancelled: boolean };
  chargeAllowed: boolean; mustReturnTrue: boolean;
}
/** The concrete Viem reader pins suite/state/policy reads to one block. Read
 * capability alone never authorizes a production write or merchant signature. */
export interface RenewalStateReader { read(grant: Readonly<RenewalGrant>): Promise<RenewalSnapshot> }
export interface FundedRenewalOptions {
  mode?: 'disabled' | 'synthetic-test' | 'local-fork';
  localFork?: LocalRenewalCapability;
  signer?: MerchantRenewalSigner; reader?: RenewalStateReader;
  // Finite synthetic exposure budget. No env switch or production activation.
  localGasBudgetWei?: bigint;
}
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();
const reject = (code: string): never => { throw new Refusal(code); };
const seconds = () => BigInt(Math.floor(Date.now() / 1000));
function chargeData(grant: RenewalGrant) { return encodeFunctionData({ abi: subscriptionV2Abi, functionName: 'charge', args: [grant.chainSubscriptionId, grant.amount] }); }

export class FundedRenewals {
  readonly store: RenewalStore;
  private readonly options: FundedRenewalOptions;
  constructor(private db: Db, readonly chain: ChainAdapter, options: FundedRenewalOptions = {}) {
    this.options = { ...options };
    this.store = new RenewalStore(db);
    if (options.mode === 'local-fork') {
      assertLocalRenewalCapability(options.localFork, chain, options.reader);
      if (!options.localGasBudgetWei || options.localGasBudgetWei <= 0n || options.localGasBudgetWei > 10n ** 18n) throw new Error('Finite local budget required');
    }
    if (options.mode === 'synthetic-test' && (!(chain instanceof FakeChain) || !options.localGasBudgetWei || options.localGasBudgetWei <= 0n || options.localGasBudgetWei > 10n ** 18n)) throw new Error('Synthetic FakeChain and finite local budget required; live activation unavailable');
  }
  /** Test provisioning only. Authentication/binding alone cannot call this on a
   * production chain. Real Privy policy verification and consent remain gates. */
  installSyntheticGrant(input: RenewalGrant): Hex {
    if (this.options.mode === 'local-fork') assertLocalRenewalCapability(this.options.localFork, this.chain, this.options.reader, input);
    else if (this.options.mode !== 'synthetic-test' || !(this.chain instanceof FakeChain)) reject('delegation_required');
    this.validateGrant(input);
    const hash = grantHash(input);
    this.db.transaction(() => {
      const active = this.store.activeGrant(input.subscriptionId);
      if (active && active.hash !== hash) reject('revoke_previous_grant');
      this.db.prepare('INSERT OR IGNORE INTO renewal_grants VALUES (?,?,?,?)').run(hash, input.subscriptionId, json(input), now());
    })();
    return hash;
  }
  private validateGrant(g: RenewalGrant) {
    if (g.version !== 1 || g.chainId !== 1874 || this.chain.subscriptionVersion !== 2 || !same(g.token, RENEWAL_USDT) || !same(g.merchant, g.mandate.merchant)) reject('grant_scope');
    if (![g.merchant, g.router, g.manager, g.token, g.mandate.payer].every(value => isAddress(value))) reject('grant_address');
    if (Object.values(g.binding).some(v => typeof v !== 'string' || !v.trim()) || !/^0x[0-9a-f]{64}$/i.test(g.binding.policyHash) || g.acceptance.kind !== 'synthetic-local' || !g.acceptance.reference.trim()) reject('delegation_required');
    if (g.mandateHash !== hashTypedData(mandateTypedData(g.mandate, g.manager, '2')) || g.dataHash !== keccak256(chargeData(g))) reject('grant_digest');
    const subId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'address' }], [g.mandate.payer, g.mandate.nonce, g.manager]));
    if (!same(subId, g.chainSubscriptionId) || g.amount < 1_000_000n || g.amount > g.mandate.amountCap || g.validFrom < 0n || g.validUntil <= g.validFrom || g.validUntil > g.mandate.endTime || g.mandate.periodSeconds <= 0n) reject('grant_terms');
    for (const n of [g.maxCalls, g.maxCallsPerDay, g.maxSigningRevisions, g.maxGas, g.mandate.maxPeriods]) if (!Number.isSafeInteger(n) || n <= 0) reject('grant_limit');
    if (g.maxSigningRevisions > 3 || g.maxGas > 1_000_000 || g.maxCalls > g.mandate.maxPeriods || g.maxGasPriceWei > 100_000_000_000n) reject('grant_limit');
    for (const n of [g.maxFeeUSDT, g.maxGasPriceWei, g.maxTransactionCostWei, g.maxTotalGasWei, g.maxFeesPerDay, g.maxFeesTotal]) if (n <= 0n) reject('grant_limit');
    this.assertBinding(g);
  }
  private assertBinding(g: RenewalGrant) {
    const sub = this.db.prepare(`SELECT s.*,p.amount_minor,p.period_seconds,p.max_periods,m.address FROM subscriptions s JOIN plans p ON p.id=s.plan_id JOIN merchants m ON m.id=s.merchant_id WHERE s.id=?`).get(g.subscriptionId) as Record<string, string> | undefined;
    const period = chargedPeriods(this.db, g.chainSubscriptionId) + 1;
    if (!sub || sub.merchant_id !== g.merchantId || !same(sub.address, g.merchant) || !same(sub.chain_id, g.chainSubscriptionId) || !same(sub.payer, g.mandate.payer) || !same(keccak256(toHex(sub.plan_id)), g.mandate.planId) || BigInt(sub.amount_minor) !== g.mandate.amountCap || renewalDiscountAmount(this.db, g.subscriptionId, period) !== g.amount || BigInt(sub.period_seconds) !== g.mandate.periodSeconds || Number(sub.max_periods) !== g.mandate.maxPeriods) reject('subscription_binding_changed');
  }
  private checkSnapshot(g: RenewalGrant, s: RenewalSnapshot) {
    const at = seconds();
    if (s.chainId !== 1874 || !same(s.manager, g.manager) || !same(s.router, g.router) || !same(s.token, g.token) || !same(s.subscriptionId, g.chainSubscriptionId) || !s.chargeAllowed || !s.mustReturnTrue) reject('renewal_policy_unavailable');
    if (s.blockNumber < 0n || !/^0x[0-9a-f]{64}$/i.test(s.blockHash) || s.timestamp > at + 5n || s.timestamp < at - 30n) reject('stale_renewal_state');
    for (const key of ['payer', 'merchant', 'planId', 'amountCap', 'periodSeconds', 'maxPeriods', 'endTime'] as const) if (!same(s.subscription[key], g.mandate[key])) reject('subscription_binding_changed');
    if (!Number.isSafeInteger(s.subscription.chargedPeriods) || s.subscription.chargedPeriods < 0 || s.subscription.chargedPeriods >= g.mandate.maxPeriods || s.subscription.cancelled || s.subscription.nextChargeAt > s.timestamp || at < g.validFrom || at >= g.validUntil) reject('renewal_not_due');
    this.assertBinding(g);
    const sub = this.db.prepare('SELECT status,next_charge_at FROM subscriptions WHERE id=?').get(g.subscriptionId) as { status: string; next_charge_at: string };
    if (!['trialing', 'active', 'past_due'].includes(sub.status) || new Date(sub.next_charge_at).getTime() > Date.now()) reject('renewal_not_due');
  }
  private reserveBudget(g: RenewalGrant, hash: Hex, cost: bigint, day: number) {
    // Reserve worst-case cost/fee before signing, conservatively retaining every
    // potentially broadcast attempt, including refused/reverted/unknown ones.
    const rows = this.db.prepare(`SELECT r.* FROM renewal_signing_revisions r JOIN relayer_operations o ON o.operation_id=r.operation_id WHERE o.phase!='not_sent'`).all() as Array<{ grant_hash: string; gas_cost: string; fee: string; day: number }>;
    if (rows.reduce((n, r) => n + BigInt(r.gas_cost), 0n) + cost > this.options.localGasBudgetWei!) reject('renewal_operator_budget');
    const own = rows.filter(r => r.grant_hash === hash), daily = own.filter(r => r.day === day);
    if (own.length >= g.maxCalls || daily.length >= g.maxCallsPerDay || own.reduce((n, r) => n + BigInt(r.gas_cost), 0n) + cost > g.maxTotalGasWei || own.reduce((n, r) => n + BigInt(r.fee), 0n) + g.maxFeeUSDT > g.maxFeesTotal || daily.reduce((n, r) => n + BigInt(r.fee), 0n) + g.maxFeeUSDT > g.maxFeesPerDay) reject('renewal_grant_budget');
  }
  status(subscriptionId: string): RenewalStatus {
    const existing = this.store.status(subscriptionId);
    return this.options.mode === 'synthetic-test' || this.options.mode === 'local-fork' ? existing : { ...existing, automatic: 'disabled' };
  }
  async renew(subscriptionId: string): Promise<RenewalStatus> {
    if (this.options.mode !== 'synthetic-test' && this.options.mode !== 'local-fork') {
      const existing = this.store.operationStatus(subscriptionId);
      if (existing) return { ...existing, automatic: 'disabled' };
      return { ...setRenewalStatus(this.db, subscriptionId, 'disabled', 'automatic_funded_renewal_disabled'), automatic: 'disabled' };
    }
    const active = this.store.activeGrant(subscriptionId);
    if (!active || !this.options.reader || !this.options.signer) return setRenewalStatus(this.db, subscriptionId, 'delegation_required', 'verified_renewal_grant_and_signer_required');
    const { grant: g, hash } = active;
    if (this.options.mode === 'local-fork') assertLocalRenewalCapability(this.options.localFork, this.chain, this.options.reader, g);
    const operation: WriteOperation = { id: id('renew'), kind: 'renew', objectId: subscriptionId };
    operation.links = { subscriptionId, intentId: operation.id };
    // No asynchronous reads or provider calls before this cross-feature hold.
    this.chain.writer.reserve(operation, () => assertSubscriptionAvailable(this.db, subscriptionId));
    setRenewalStatus(this.db, subscriptionId, 'pending', 'preparing', operation.id);
    try {
      this.validateGrant(g);
      if (await this.chain.chainId() !== 1874) reject('wrong_chain');
      const snapshot = await this.options.reader.read(structuredClone(g));
      this.checkSnapshot(g, snapshot);
      const period = snapshot.subscription.chargedPeriods + 1;
      const sub = this.db.prepare('SELECT status,retry_count FROM subscriptions WHERE id=?').get(subscriptionId) as { status: string; retry_count: number };
      const retry = sub.status === 'past_due' ? sub.retry_count + 1 : 0;
      if (!Number.isSafeInteger(sub.retry_count) || sub.retry_count < 0 || retry > 3) reject('retry_limit');
      const deadline = [seconds() + 120n, g.validUntil, snapshot.timestamp + g.mandate.periodSeconds - 1n, (seconds() / 86400n + 1n) * 86400n - 1n].reduce((a, b) => a < b ? a : b);
      if (deadline <= seconds() + 5n) reject('renewal_window_too_short');
      const data = chargeData(g);
      const cost = BigInt(g.maxGas + 400_000) * g.maxGasPriceWei;
      if (cost > g.maxTransactionCostWei) reject('renewal_transaction_budget');
      let request!: IntentRequest;
      this.db.transaction(() => {
        let attempt = this.db.prepare('SELECT id FROM renewal_attempts WHERE chain_id=? AND manager=? AND chain_subscription_id=? AND period=? AND retry=?').get(1874, g.manager.toLowerCase(), g.chainSubscriptionId.toLowerCase(), period, retry) as { id: string } | undefined;
        if (!attempt) {
          attempt = { id: id('attempt') };
          this.db.prepare('INSERT INTO renewal_attempts VALUES (?,?,?,?,?,?,?,?)').run(attempt.id, subscriptionId, 1874, g.manager.toLowerCase(), g.chainSubscriptionId.toLowerCase(), period, retry, now());
        }
        const revisions = this.db.prepare(`SELECT r.revision,o.phase FROM renewal_signing_revisions r JOIN relayer_operations o ON o.operation_id=r.operation_id WHERE r.attempt_id=? ORDER BY revision`).all(attempt.id) as { revision: number; phase: string }[];
        if (revisions.some(r => r.phase !== 'not_sent')) reject('renewal_attempt_pending_or_settled');
        if (revisions.length >= g.maxSigningRevisions) reject('signing_revision_limit');
        const revision = revisions.length + 1;
        const nonce = BigInt(keccak256(toHex(json(['settle-renewal-v1', 1874, g.router.toLowerCase(), g.manager.toLowerCase(), g.chainSubscriptionId.toLowerCase(), period, retry, revision]))));
        const intent = { signer: g.merchant, merchant: g.merchant, target: g.manager, dataHash: g.dataHash, amount: g.amount, feeUSDT: g.maxFeeUSDT, nonce, deadline, maxGas: g.maxGas };
        request = { intent, data, signature: '0x' };
        const day = Number(seconds() / 86400n);
        this.reserveBudget(g, hash, cost, day);
        this.db.prepare('INSERT INTO renewal_signing_revisions VALUES (?,?,?,?,?,?,?,?,?,?)').run(operation.id, attempt.id, revision, hash, json(intentTypedData(intent, g.router)), json(request), day, g.maxFeeUSDT.toString(), cost.toString(), now());
        this.db.prepare('INSERT INTO intents VALUES (?,?,?,?,?,?,?,?,?)').run(operation.id, g.merchantId, g.merchant.toLowerCase(), nonce.toString(), json(request), 'reconciliation_required', 'awaiting_merchant_signature', null, now());
      })();
      // Isolate mutable provider inputs from the frozen local request/grant.
      const response = await this.options.signer.signExactIntent({ binding: { ...g.binding }, grantHash: hash, operationId: operation.id, expectedMerchantAddress: g.merchant, typedData: structuredClone(intentTypedData(request.intent, g.router)) });
      const recovered = await recoverTypedDataAddress({ ...intentTypedData(request.intent, g.router), signature: response.signature });
      if (!same(recovered, g.merchant) || !response.providerRequestId?.trim()) reject('merchant_signature_mismatch');
      this.db.prepare('INSERT INTO renewal_signatures VALUES (?,?,?,?)').run(operation.id, response.signature, response.providerRequestId, now());
      request.signature = response.signature;
      this.db.prepare('UPDATE intents SET request_json=? WHERE id=?').run(json(request), operation.id);
      // Revocation/cancellation may arrive while the provider is working. A
      // second pinned read must still describe the same due period.
      const latest = await this.options.reader.read(structuredClone(g));
      this.checkSnapshot(g, latest);
      if (latest.subscription.chargedPeriods + 1 !== period || latest.blockNumber < snapshot.blockNumber || (latest.blockNumber === snapshot.blockNumber && latest.blockHash !== snapshot.blockHash)) reject('renewal_state_changed');
      if (this.store.activeGrant(subscriptionId)?.hash !== hash) reject('renewal_grant_revoked');
      if (request.intent.deadline <= seconds()) reject('deadline');
      // Preserve the exact writer while rechecking local revocation/cancellation
      // at preparation inside its queue (it may have waited behind another write).
      const checkBeforeSigningTransaction = () => {
        if (this.options.mode === 'local-fork') assertLocalRenewalCapability(this.options.localFork, this.chain, this.options.reader, g);
        if (this.store.activeGrant(subscriptionId)?.hash !== hash) reject('renewal_grant_revoked');
        this.assertBinding(g);
        const current = this.db.prepare('SELECT status FROM subscriptions WHERE id=?').get(subscriptionId) as { status: string };
        if (!['trialing', 'active', 'past_due'].includes(current.status)) reject('renewal_not_due');
        if (request.intent.deadline <= seconds()) reject('deadline');
      };
      const guardedChain = new Proxy(this.chain, { get(target, key) {
        if (key === 'prepareIntent') return async (...args: Parameters<ChainAdapter['prepareIntent']>) => {
          checkBeforeSigningTransaction();
          const prepared = await target.prepareIntent(...args);
          checkBeforeSigningTransaction();
          return prepared;
        };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const relayer = new Relayer(guardedChain, g.router, { [g.manager.toLowerCase()]: [data.slice(0, 10) as Hex] }, { minAmount: 1_000_000n, maxGas: 1_000_000n, maxGasPrice: g.maxGasPriceWei, maxSpendPerMinute: 10n ** 16n });
      await relayer.submit(request, operation);
      return this.store.status(subscriptionId);
    } catch (error) {
      this.chain.writer.notSent(operation.id, error instanceof Refusal ? error.code : 'renewal_preparation_failed');
      // Infrastructure errors retain billing retry_count and exact signing audit.
      if (this.chain.writer.record(operation.id)?.phase === 'not_sent') this.db.prepare(`INSERT INTO subscription_service_backoff VALUES (?,?) ON CONFLICT(subscription_id) DO UPDATE SET next_attempt_at=excluded.next_attempt_at`).run(subscriptionId, new Date(Date.now() + 60_000).toISOString());
      throw error;
    }
  }
}
