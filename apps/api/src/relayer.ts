import type { WriteOperation } from './account-writer.js';
import { encodeFunctionData, isAddress, keccak256, recoverTypedDataAddress, toFunctionSelector, type Abi, type AbiFunction, type Address, type Hex } from 'viem';
import { escrowAbi, receivablesAbi, subscriptionAbi, routerAbi } from './chain.js';
import type { ChainAdapter, IntentRequest } from './types.js';
import { Refusal } from './types.js';
import { feeFor, gasInUsdt, type Product } from './pricing.js';
import { ALLOWLIST } from './suite.js';
import { intentTypedData } from './typed-data.js';

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
  constructor(private chain: ChainAdapter, private router: Address, private targets: SponsoredTargets, private limits: RelayerLimits = { minAmount: 1_000_000n, maxGas: 1_000_000n, maxGasPrice: 100_000_000_000n, maxSpendPerMinute: 10_000_000_000_000_000n }) {}
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
  async submit(request: IntentRequest, operation = this.chain.writer.operation('intent', `${request.intent.signer}:${request.intent.nonce}`)): Promise<Hex> {
    try { return await this.chain.writer.run(() => this.submitSerial(request, operation), operation.id); }
    catch (error) {
      this.chain.writer.notSent(operation.id);
      if (error instanceof Refusal) try { this.onRefusal?.(request, error); } catch { /* recording must not hide the refusal */ }
      throw error;
    }
  }
  /** Every check that runs before simulation. Throws the first refusal; sends nothing. */
  private async checks(request: IntentRequest) {
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
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== this.minute) { this.minute = minute; this.minuteSpent = 0n; this.merchantSpent.clear(); }
    const gas = transactionGas(request);
    if (gas > this.limits.maxGas + 400_000n) throw new Refusal('gas_limit');
    const transactionCost = gas * price;
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
    return { gas, price, transactionCost, merchantKey, merchantSpent, replay, rule };
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
  private async submitSerial(request: IntentRequest, operation: WriteOperation): Promise<Hex> {
    const { gas, price, transactionCost, merchantKey, merchantSpent, replay, rule } = await this.checks(request);
    const simulated = await this.chain.simulate(request, { gas, gasPrice: price });
    if (!simulated.accepted) { this.trip(merchantKey); throw new Refusal('simulation_refused', simulated.reason); }
    try {
      const hash = await this.chain.writer.execute(operation, () => this.chain.transactionCount(), async nonce => {
        const prepared = await this.chain.prepareIntent(request, gas, nonce, price);
        this.chain.writer.reserveSpend(operation.id, transactionCost, this.limits.maxSpendPerMinute);
        return prepared;
      }, raw => this.chain.broadcastTransaction(raw));
      this.used.add(replay);
      this.minuteSpent += transactionCost;
      this.merchantSpent.set(merchantKey, merchantSpent + transactionCost);
      this.breakers.delete(merchantKey);
      if (rule.charge === 'free') this.sponsorship?.record(request.intent.merchant, operation.id, transactionCost);
      return hash;
    } catch (e) { this.trip(merchantKey); throw e; }
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
