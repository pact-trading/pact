import type { WriteOperation } from './account-writer.js';
import { encodeFunctionData, isAddress, keccak256, recoverTypedDataAddress, toFunctionSelector, type Abi, type AbiFunction, type Address, type Hex } from 'viem';
import { escrowAbi, receivablesAbi, subscriptionAbi, routerAbi } from './chain.js';
import type { ChainAdapter, IntentRequest } from './types.js';
import { Refusal } from './types.js';
import { feeFor, gasInUsdt, type Product } from './pricing.js';
import { ALLOWLIST } from './suite.js';
import { intentTypedData } from './typed-data.js';
import { authorizationSigner, splitSignature, termsTuple, type Authorization } from './collector.js';
import { stopwatch } from './timing.js';
import { CHECKOUT, INVOICE } from './pricing.js';
/** Gas limit of a one-signature escrow charge (measured ~150k; the budget uses measured gas once known). */
export const COLLECTOR_GAS = 350_000n;

/** Gas the Router's own measurement cannot see; it charges merchant-paid calls this much on top. */
export const ROUTER_GAS_OVERHEAD = 60_000n;

// Cover cold validation/storage writes before the late forwarding check, its
// 120k settlement reserve and EIP-150 headroom, plus intrinsic calldata gas.
// This also satisfies the deployed Router's earlier maxGas + 80k check. Never estimate:
// eth_estimateGas can converge on the successful-but-refused return path.
export function transactionGas(request: IntentRequest): bigint {
  const data = encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: [request.intent, request.data, request.signature] });
  let intrinsic = 21_000n;
  for (let offset = 2; offset < data.length; offset += 2) intrinsic += data.slice(offset, offset + 2) === '00' ? 4n : 16n;
  const targetGas = BigInt(request.intent.maxGas);
  return targetGas + targetGas / 63n + 200_000n + 120_000n + intrinsic;
}

/**
 * The gas a call is budgeted at: 1.25x the 95th percentile of the last 50 measured calls of the same kind
 * (`target:selector`), never above its gas limit. Until five calls are measured, the gas limit itself.
 * Budgets and the fee-covers-gas check use this; the transaction still carries the full limit.
 */
export function expectedGas(measured: bigint[], limit: bigint, prior = limit): bigint {
  if (measured.length < 5) return prior < limit ? prior : limit;
  const sorted = [...measured].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
  const budget = p95 * 5n / 4n;
  return budget < limit ? budget : limit;
}
export const callKey = (target: Address, data: Hex) => `${target}:${data.slice(0, 10)}`.toLowerCase();
/**
 * What a Router call is budgeted at before any of its kind is measured: the target's whole gas allowance,
 * the Router's own overhead and the calldata, but not the settlement reserve and EIP-150 headroom the
 * transaction carries on top (which a call never burns). Once measured, measured gas takes over.
 */
export function routerGasPrior(request: IntentRequest, limit: bigint) {
  const intrinsic = transactionGas(request) - (BigInt(request.intent.maxGas) + BigInt(request.intent.maxGas) / 63n + 320_000n);
  const prior = BigInt(request.intent.maxGas) + ROUTER_GAS_OVERHEAD + intrinsic;
  return prior < limit ? prior : limit;
}
/** A one-signature charge before any is measured: above the ~202k measured with real USDT and fresh balances. */
export const COLLECTOR_GAS_PRIOR = 260_000n;

/**
 * Who pays for a sponsored call. `fee`: the target takes Pact's fee out of the money it moves, which
 * must cover the gas. `gas`: the merchant sends money and pays the call's gas in USDT on top (the
 * Router charges it). `free`: no money reaches the merchant; Pact absorbs the gas within the
 * merchant's sponsorship budget. `checksAmount` mirrors the Router: the amount must reach the minimum.
 */
export type SponsoredRule = { charge: 'fee'; product: Product; checksAmount: true } | { charge: 'gas' | 'free'; checksAmount: boolean };
export type SponsoredTargets = Record<string, Record<string, SponsoredRule>>;

export interface RelayerLimits {
  minAmount: bigint; maxGas: bigint; maxGasPrice: bigint;
  /** Ceiling for all merchants together, per minute (layer 8 circuit breaker). */
  maxSpendPerMinute: bigint;
  /** Ceiling for one merchant per minute, so one busy or hostile merchant cannot use up the global one. Defaults to the global ceiling. */
  maxSpendPerMerchantPerMinute?: bigint;
}
/** The merchant sponsorship budget, keyed by the merchant's address. */
export interface SponsorshipHook {
  assert(merchant: Address, costWei: bigint, usdtPerWbt: bigint): void;
  record(merchant: Address, operationId: string, costWei: bigint): void;
}
/** Refusals that come from Pact's own limits or state, not from the merchant's calls failing. */
const OWN_REFUSALS = new Set(['circuit_budget', 'merchant_circuit_budget', 'replay', 'operation_replay', 'relayer_pending', 'relayer_stuck', 'sponsorship_budget', 'circuit_open', 'invalid_gas_budget']);
type Admitted = { gas: bigint; price: bigint; usdtPerWbt: bigint; transactionCost: bigint; merchantKey: string; replay: string; rule: SponsoredRule };
export class Relayer {
  private minute = 0;
  private minuteSpent = 0n;
  private merchantSpent = new Map<string, bigint>();
  // Failed simulations or broadcasts pause sponsorship for that merchant only.
  private breakers = new Map<string, { failures: number; pausedUntil: number }>();
  private used = new Set<string>();
  /** Called for every refusal before broadcast, so the merchant can see what was stopped and why. */
  onRefusal?: (request: IntentRequest, refusal: Refusal) => void;
  /** Durable replay check (survives restarts): true when this signer's nonce already went on chain. */
  isUsed?: (signer: Address, nonce: bigint) => boolean;
  /** Caps the gas Pact absorbs on `free` calls. */
  sponsorship?: SponsorshipHook;
  /**
   * Extra relayer accounts for Router intents (Router.execute accepts any sender). Each has its own nonce
   * sequence, journal rows and watchdog, so a stuck nonce holds one lane, not every payment. Keeper renewals,
   * permits, the treasury and x402 stay on the primary account, which the contracts name.
   */
  lanes: ChainAdapter[] = [];
  constructor(private chain: ChainAdapter, private router: Address, private targets: SponsoredTargets, private limits: RelayerLimits = { minAmount: 1_000_000n, maxGas: 1_000_000n, maxGasPrice: 100_000_000_000n, maxSpendPerMinute: 10_000_000_000_000_000n }) {}
  /** The account that sends this intent: one lane per payer, so a payer's payments keep their order. */
  laneFor(request: Pick<IntentRequest, 'intent'>): ChainAdapter { return this.laneForPayer(request.intent.signer); }
  laneForPayer(payer: Address): ChainAdapter {
    if (!this.lanes.length) return this.chain;
    return this.lanes[Number(BigInt(keccak256(payer.toLowerCase() as Hex)) % BigInt(this.lanes.length))];
  }
  /**
   * A one-signature charge: the payer's EIP-3009 authorization, sent by Pact straight to the escrow's
   * `chargeWithAuthorization`. The same admission as a Router payment (minimum, signed fee terms, the fee
   * covering measured gas, budgets, circuit breakers), simulated before it is signed and sent.
   */
  async submitCollected(a: Authorization, signature: Hex, operation: WriteOperation, escrow: Address): Promise<Hex> {
    const lane = this.laneForPayer(a.terms.payer);
    const merchantKey = a.terms.merchant.toLowerCase();
    const replay = `${a.terms.payer.toLowerCase()}:${BigInt(a.nonce)}`;
    let claimed: { cost: bigint; minute: number } | undefined;
    const clock = stopwatch('relayer.submitCollected');
    try {
      lane.writer.assertAvailable(operation.id);
      if (Date.now() < (this.breakers.get(merchantKey)?.pausedUntil ?? 0)) throw new Refusal('circuit_open');
      if (await this.chain.chainId() !== 1874) throw new Refusal('wrong_chain');
      if (!isAddress(a.terms.payer) || !isAddress(a.terms.merchant)) throw new Refusal('invalid_address');
      if (a.validBefore <= BigInt(Math.floor(Date.now() / 1000)) + 10n) throw new Refusal('deadline');
      if (a.terms.amount < this.limits.minAmount) throw new Refusal('dust');
      if ((await authorizationSigner(a, escrow, signature)).toLowerCase() !== a.terms.payer.toLowerCase()) throw new Refusal('invalid_signature');
      if (this.used.has(replay) || this.isUsed?.(a.terms.payer, BigInt(a.nonce))) throw new Refusal('replay');
      clock.lap('signature');
      const quote = await this.quote(Number(COLLECTOR_GAS));
      const price = BigInt(quote.gasPriceWei), usdtPerWbt = BigInt(quote.usdtPerWbtMinor);
      if (a.terms.amount < BigInt(quote.minimumAmountMinor)) throw new Refusal('dust');
      clock.lap('quote');
      const fees = await this.chain.merchantFees(a.terms.merchant);
      clock.lap('fees');
      if (!fees.acceptedVersion || !fees.accepted) throw new Refusal('fee_terms_required');
      const { v, r, s } = splitSignature(signature);
      const data = encodeFunctionData({ abi: escrowAbi, functionName: 'chargeWithAuthorization', args: [termsTuple(a.terms), a.validAfter, a.validBefore, v, r, s] });
      const key = callKey(escrow, data);
      const cost = expectedGas(lane.writer.measuredGas(key), COLLECTOR_GAS, COLLECTOR_GAS_PRIOR) * price;
      const fee = feeFor(fees.accepted, a.terms.product === 1 ? INVOICE : CHECKOUT, a.terms.amount);
      if (fee * 10n < gasInUsdt(cost, usdtPerWbt) * 12n) throw new Refusal('fee_below_gas');
      this.rollMinute();
      if (this.minuteSpent + cost > this.limits.maxSpendPerMinute) throw new Refusal('circuit_budget');
      const merchantSpent = this.merchantSpent.get(merchantKey) ?? 0n;
      if (merchantSpent + cost > (this.limits.maxSpendPerMerchantPerMinute ?? this.limits.maxSpendPerMinute)) throw new Refusal('merchant_circuit_budget');
      // Claim the authorization and the budget before the send, as a Router payment does.
      this.used.add(replay); this.minuteSpent += cost; this.merchantSpent.set(merchantKey, merchantSpent + cost);
      claimed = { cost, minute: this.minute };
      lane.writer.label(operation.id, key);
      const hash = await lane.relay(operation, escrow, data, COLLECTOR_GAS, cost);
      clock.lap('relay'); clock.done();
      this.breakers.delete(merchantKey);
      return hash;
    } catch (error) {
      lane.writer.notSent(operation.id);
      if (claimed && (lane.writer.record(operation.id)?.phase ?? 'not_sent') === 'not_sent') {
        this.used.delete(replay);
        if (this.minute === claimed.minute) {
          this.minuteSpent = this.minuteSpent > claimed.cost ? this.minuteSpent - claimed.cost : 0n;
          const spent = this.merchantSpent.get(merchantKey) ?? 0n;
          this.merchantSpent.set(merchantKey, spent > claimed.cost ? spent - claimed.cost : 0n);
        }
      }
      if (error instanceof Refusal && ['relay_refused', 'simulation_refused'].includes(error.code)) this.trip(merchantKey);
      if (error instanceof Refusal) try { this.onCollectedRefusal?.(a, error); } catch { /* recording must not hide the refusal */ }
      throw error;
    }
  }
  /** Called for every refused one-signature charge, like `onRefusal` for Router intents. */
  onCollectedRefusal?: (authorization: Authorization, refusal: Refusal) => void;
  get minimumAmount() { return this.limits.minAmount; }
  /** Seconds left on a merchant's circuit breaker, or 0. */
  pausedFor(merchant: Address) { return Math.max(0, Math.ceil(((this.breakers.get(merchant.toLowerCase())?.pausedUntil ?? 0) - Date.now()) / 1000)); }
  /** Who pays for this call, or undefined when it is not sponsored. */
  rule(request: Pick<IntentRequest, 'data'> & { intent: { target: Address } }): SponsoredRule | undefined {
    if (!/^0x[\da-f]{8}/i.test(request.data)) return undefined;
    return this.targets[request.intent.target.toLowerCase()]?.[request.data.slice(0, 10).toLowerCase()];
  }
  /**
   * Read-only: the gas price, the WBT price the FeeSchedule converts gas with, the most a merchant-paid
   * call of `targetGas` can cost in USDT, and the minimum amount. Not an authorization.
   */
  async quote(targetGas = 300_000) {
    if (!Number.isSafeInteger(targetGas) || targetGas <= 0 || BigInt(targetGas) > this.limits.maxGas) throw new Refusal('gas_limit');
    if (await this.chain.chainId() !== 1874) throw new Refusal('wrong_chain');
    const [policy, price] = await Promise.all([this.chain.routerPolicy(), this.chain.gasPrice()]);
    if (policy.usdtPerWbt <= 0n || policy.maxGasPerCall <= 0n || policy.maxGasPriceWei <= 0n || policy.minimumAmountMinor <= 0n) throw new Error('Invalid Router policy');
    if (BigInt(targetGas) > policy.maxGasPerCall) throw new Refusal('gas_limit');
    if (price <= 0n || price > this.limits.maxGasPrice || price > policy.maxGasPriceWei) throw new Refusal('gas_price');
    return { chainId: 1874, blockNumber: policy.blockNumber.toString(), targetGas, gasPriceWei: price.toString(),
      usdtPerWbtMinor: policy.usdtPerWbt.toString(),
      maximumGasFeeMinor: gasInUsdt((BigInt(targetGas) + ROUTER_GAS_OVERHEAD) * price, policy.usdtPerWbt).toString(),
      minimumAmountMinor: (policy.minimumAmountMinor > this.limits.minAmount ? policy.minimumAmountMinor : this.limits.minAmount).toString() };
  }
  async submit(request: IntentRequest, operation = this.laneFor(request).writer.operation('intent', `${request.intent.signer}:${request.intent.nonce}`)): Promise<Hex> {
    const lane = this.laneFor(request);
    try {
      // Fail fast while the sending account cannot take a new write, before spending any RPC on admission.
      lane.writer.assertAvailable(operation.id);
      // Admission runs outside the writer queue: payments check and simulate in parallel. Only the
      // nonce, signature, journal commits and broadcast are serialized.
      const admitted = await this.checks(request);
      // Simulated from the account that will send it (the node checks that account can pay the gas).
      const simulated = await lane.simulate(request, { gas: admitted.gas, gasPrice: admitted.price });
      if (!simulated.accepted) { this.trip(admitted.merchantKey); throw new Refusal('simulation_refused', simulated.reason); }
      lane.writer.label(operation.id, callKey(request.intent.target, request.data));
      return await lane.writer.run(() => this.submitSerial(lane, request, operation, admitted), operation.id);
    }
    catch (error) {
      lane.writer.notSent(operation.id);
      if (error instanceof Refusal) try { this.onRefusal?.(request, error); } catch { /* recording must not hide the refusal */ }
      throw error;
    }
  }
  /** Every check that runs before simulation. Throws the first refusal; sends nothing. */
  private async checks(request: IntentRequest): Promise<Admitted> {
    const i = request.intent;
    const merchantKey = i.merchant.toLowerCase();
    if (Date.now() < (this.breakers.get(merchantKey)?.pausedUntil ?? 0)) throw new Refusal('circuit_open');
    if (await this.chain.chainId() !== 1874) throw new Refusal('wrong_chain');
    if (!isAddress(i.signer) || !isAddress(i.merchant) || !isAddress(i.target)) throw new Refusal('invalid_address');
    if (i.deadline <= BigInt(Math.floor(Date.now() / 1000))) throw new Refusal('deadline');
    const rule = this.rule(request);
    if (!rule) throw new Refusal('wrong_selector');
    if (rule.checksAmount && i.amount < this.limits.minAmount) throw new Refusal('dust');
    if (!Number.isSafeInteger(i.maxGas) || i.maxGas <= 0 || BigInt(i.maxGas) > this.limits.maxGas) throw new Refusal('gas_limit');
    if (keccak256(request.data) !== i.dataHash) throw new Refusal('data_hash');
    const replay = `${i.signer.toLowerCase()}:${i.nonce}`;
    if (this.used.has(replay) || this.isUsed?.(i.signer, i.nonce)) throw new Refusal('replay');
    const signer = await recoverTypedDataAddress({ ...intentTypedData(i, this.router), signature: request.signature });
    if (signer.toLowerCase() !== i.signer.toLowerCase()) throw new Refusal('invalid_signature');
    const quote = await this.quote(i.maxGas);
    const price = BigInt(quote.gasPriceWei), usdtPerWbt = BigInt(quote.usdtPerWbtMinor);
    if (rule.checksAmount && i.amount < BigInt(quote.minimumAmountMinor)) throw new Refusal('dust');
    // Pact takes no payment for a merchant that has not signed its fee terms.
    const fees = await this.chain.merchantFees(i.merchant);
    if (!fees.acceptedVersion || !fees.accepted) throw new Refusal('fee_terms_required');
    this.rollMinute();
    const gas = transactionGas(request);
    if (gas > this.limits.maxGas + 400_000n) throw new Refusal('gas_limit');
    // Budgeted at what calls of this kind actually use (the limit only bounds the worst case).
    const budgetGas = expectedGas(this.laneFor(request).writer.measuredGas(callKey(i.target, request.data)), gas, routerGasPrior(request, gas));
    const transactionCost = budgetGas * price;
    if (this.minuteSpent + transactionCost > this.limits.maxSpendPerMinute) throw new Refusal('circuit_budget');
    const merchantSpent = this.merchantSpent.get(merchantKey) ?? 0n;
    if (merchantSpent + transactionCost > (this.limits.maxSpendPerMerchantPerMinute ?? this.limits.maxSpendPerMinute)) throw new Refusal('merchant_circuit_budget');
    if (rule.charge === 'fee') {
      // The fee pays this call's gas: below it (a stale minimum after a WBT price move), refuse.
      const fee = feeFor(fees.accepted, rule.product, i.amount);
      if (fee * 10n < gasInUsdt(transactionCost, usdtPerWbt) * 12n) throw new Refusal('fee_below_gas');
    } else if (rule.charge === 'gas') {
      if (i.signer.toLowerCase() !== merchantKey) throw new Refusal('signer_not_merchant');
      const ceiling = BigInt(quote.maximumGasFeeMinor);
      const s = await this.chain.approval.snapshot(i.merchant, this.router);
      if (s.allowance < ceiling || s.balance < i.amount + ceiling) throw new Refusal('gas_fee_unavailable');
    } else this.sponsorship?.assert(i.merchant, transactionCost, usdtPerWbt);
    return { gas, price, usdtPerWbt, transactionCost, merchantKey, replay, rule };
  }
  private rollMinute() {
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== this.minute) { this.minute = minute; this.minuteSpent = 0n; this.merchantSpent.clear(); }
  }
  /**
   * Runs the pre-broadcast checks only: never simulates, signs or sends. Used by the drain run, so
   * an attack that unexpectedly passed the checks still could not spend gas.
   */
  async preflight(request: IntentRequest): Promise<void> {
    try { await this.checks(request); }
    catch (error) {
      if (error instanceof Refusal) try { this.onRefusal?.(request, error); } catch { /* recording must not hide the refusal */ }
      throw error;
    }
  }
  /** Inside the writer queue: recheck what concurrent admissions may have changed, then sign and send. */
  private async submitSerial(lane: ChainAdapter, request: IntentRequest, operation: WriteOperation, admitted: Admitted): Promise<Hex> {
    const { gas, price, transactionCost, merchantKey, replay, rule } = admitted;
    if (Date.now() < (this.breakers.get(merchantKey)?.pausedUntil ?? 0)) throw new Refusal('circuit_open');
    if (this.used.has(replay) || this.isUsed?.(request.intent.signer, request.intent.nonce)) throw new Refusal('replay');
    this.rollMinute();
    if (this.minuteSpent + transactionCost > this.limits.maxSpendPerMinute) throw new Refusal('circuit_budget');
    const merchantSpent = this.merchantSpent.get(merchantKey) ?? 0n;
    if (merchantSpent + transactionCost > (this.limits.maxSpendPerMerchantPerMinute ?? this.limits.maxSpendPerMinute)) throw new Refusal('merchant_circuit_budget');
    if (rule.charge === 'free') this.sponsorship?.assert(request.intent.merchant, transactionCost, admitted.usdtPerWbt);
    // Claim the signed identity and the budget before signing: the writer slot is released while this
    // transaction is still in transit, so a duplicate or a concurrent payment must already see them taken.
    const minute = this.minute;
    this.used.add(replay);
    this.minuteSpent += transactionCost;
    this.merchantSpent.set(merchantKey, merchantSpent + transactionCost);
    try {
      const hash = await lane.writer.execute(operation, () => lane.transactionCount(), async nonce => {
        const prepared = await lane.prepareIntent(request, gas, nonce, price);
        lane.writer.reserveSpend(operation.id, transactionCost, this.limits.maxSpendPerMinute);
        return prepared;
      }, raw => lane.broadcastTransaction(raw));
      this.breakers.delete(merchantKey);
      if (rule.charge === 'free') this.sponsorship?.record(request.intent.merchant, operation.id, transactionCost);
      return hash;
    } catch (e) {
      // Free the claims only when the journal proves nothing was signed for the network.
      if ((lane.writer.record(operation.id)?.phase ?? 'not_sent') === 'not_sent') {
        this.used.delete(replay);
        if (this.minute === minute) {
          this.minuteSpent = this.minuteSpent > transactionCost ? this.minuteSpent - transactionCost : 0n;
          const spent = this.merchantSpent.get(merchantKey) ?? 0n;
          this.merchantSpent.set(merchantKey, spent > transactionCost ? spent - transactionCost : 0n);
        }
      }
      // Our own budget, replay and availability refusals say nothing about the merchant: no circuit breaker.
      if (!(e instanceof Refusal) || !OWN_REFUSALS.has(e.code)) this.trip(merchantKey);
      throw e;
    }
  }
  private trip(merchant: string) {
    const breaker = this.breakers.get(merchant) ?? { failures: 0, pausedUntil: 0 };
    if (++breaker.failures >= 3) { breaker.pausedUntil = Date.now() + 60_000; breaker.failures = 0; }
    this.breakers.set(merchant, breaker);
  }
}

const abis = { escrow: escrowAbi, subscription: subscriptionAbi, receivables: receivablesAbi } as const;
const selectorOf = (abi: Abi, name: string) => {
  const fn = abi.find((x): x is AbiFunction => x.type === 'function' && x.name === name);
  if (!fn) throw new Error(`Missing allowlisted function ${name}`);
  return toFunctionSelector(fn).toLowerCase();
};
/** The Router allowlist as the relayer prices it: the suite's ALLOWLIST, for these deployments. */
export function allowedTargets(addresses: { escrow: Address; subscription: Address; receivables?: Address }): SponsoredTargets {
  const out: SponsoredTargets = {};
  for (const entry of ALLOWLIST) {
    const address = addresses[entry.contract];
    if (!address) continue;
    const rule: SponsoredRule = entry.charge === 'fee'
      ? { charge: 'fee', product: entry.product as Product, checksAmount: true }
      : { charge: entry.charge, checksAmount: entry.checksAmount };
    (out[address.toLowerCase()] ??= {})[selectorOf(abis[entry.contract], entry.fn)] = rule;
  }
  return out;
}
