import type { WriteOperation } from './account-writer.js';
import { encodeFunctionData, isAddress, keccak256, recoverTypedDataAddress, toFunctionSelector, type Abi, type AbiFunction, type Address, type Hex } from 'viem';
import { escrowAbi, receivablesAbi, subscriptionAbi, subscriptionV2Abi, routerAbi } from './chain.js';
import type { ChainAdapter, IntentRequest } from './types.js';
import { Refusal } from './types.js';

import { intentTypedData } from './typed-data.js';

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
export interface RelayerLimits {
  minAmount: bigint; maxGas: bigint; maxGasPrice: bigint;
  /** Ceiling for all merchants together, per minute (layer 8 circuit breaker). */
  maxSpendPerMinute: bigint;
  /** Ceiling for one merchant per minute, so one busy or hostile merchant cannot use up the global one. Defaults to the global ceiling. */
  maxSpendPerMerchantPerMinute?: bigint;
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
  constructor(private chain: ChainAdapter, private router: Address, private targets: Record<string, readonly Hex[]>, private limits: RelayerLimits = { minAmount: 1_000_000n, maxGas: 1_000_000n, maxGasPrice: 100_000_000_000n, maxSpendPerMinute: 10_000_000_000_000_000n }) {}
  get minimumAmount() { return this.limits.minAmount; }
  /** Seconds left on a merchant's circuit breaker, or 0. */
  pausedFor(merchant: Address) { return Math.max(0, Math.ceil(((this.breakers.get(merchant.toLowerCase())?.pausedUntil ?? 0) - Date.now()) / 1000)); }
  /** Read-only fee floor, not an authorization or an execution guarantee. */
  async quote(targetGas = 300_000) {
    if (!Number.isSafeInteger(targetGas) || targetGas <= 0 || BigInt(targetGas) > this.limits.maxGas) throw new Refusal('gas_limit');
    if (await this.chain.chainId() !== 1874) throw new Refusal('wrong_chain');
    const [policy, price] = await Promise.all([this.chain.routerPolicy(), this.chain.gasPrice()]);
    if (policy.usdtPerWbt <= 0n || policy.maxGasPerCall <= 0n || policy.maxGasPriceWei <= 0n || policy.minimumAmountMinor <= 0n) throw new Error('Invalid Router policy');
    if (BigInt(targetGas) > policy.maxGasPerCall) throw new Refusal('gas_limit');
    if (price <= 0n || price > this.limits.maxGasPrice || price > policy.maxGasPriceWei) throw new Refusal('gas_price');
    const maximum = (BigInt(targetGas) + 40_000n) * price;
    return { chainId: 1874, blockNumber: policy.blockNumber.toString(), targetGas, gasPriceWei: price.toString(),
      usdtPerWbtMinor: policy.usdtPerWbt.toString(), maximumReimbursementWei: maximum.toString(),
      minimumFeeMinor: ((maximum * policy.usdtPerWbt + 10n ** 18n - 1n) / 10n ** 18n).toString(),
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
    if (i.amount < this.limits.minAmount) throw new Refusal('dust');
    if (i.feeUSDT <= 0n) throw new Refusal('fee_too_low');
    if (!Number.isSafeInteger(i.maxGas) || i.maxGas <= 0 || BigInt(i.maxGas) > this.limits.maxGas) throw new Refusal('gas_limit');
    if (!/^0x[\da-f]{8}/i.test(request.data) || !this.targets[i.target.toLowerCase()]?.some(x => x.toLowerCase() === request.data.slice(0, 10).toLowerCase())) throw new Refusal('wrong_selector');
    if (keccak256(request.data) !== i.dataHash) throw new Refusal('data_hash');
    const replay = `${i.signer.toLowerCase()}:${i.nonce}`;
    if (this.used.has(replay) || this.isUsed?.(i.signer, i.nonce)) throw new Refusal('replay');
    const signer = await recoverTypedDataAddress({ ...intentTypedData(i, this.router), signature: request.signature });
    if (signer.toLowerCase() !== i.signer.toLowerCase()) throw new Refusal('invalid_signature');
    const quote = await this.quote(i.maxGas);
    const price = BigInt(quote.gasPriceWei);
    if (i.amount < BigInt(quote.minimumAmountMinor)) throw new Refusal('dust');
    const minute = Math.floor(Date.now() / 60_000);
    if (minute !== this.minute) { this.minute = minute; this.minuteSpent = 0n; this.merchantSpent.clear(); }
    const gas = transactionGas(request);
    if (gas > this.limits.maxGas + 400_000n) throw new Refusal('gas_limit');
    const transactionCost = gas * price;
    // Router fee floor uses target gas + 40k, distinct from relayer exposure.
    const feeFloor = BigInt(quote.minimumFeeMinor);
    if (i.feeUSDT < feeFloor) throw new Refusal('fee_too_low');
    if (this.minuteSpent + transactionCost > this.limits.maxSpendPerMinute) throw new Refusal('circuit_budget');
    const merchantSpent = this.merchantSpent.get(merchantKey) ?? 0n;
    if (merchantSpent + transactionCost > (this.limits.maxSpendPerMerchantPerMinute ?? this.limits.maxSpendPerMinute)) throw new Refusal('merchant_circuit_budget');
    const tank = await this.chain.gasTank(i.merchant);
    const tankReserve = (gas + 40_000n) * price;
    if (tank.balanceWei < tankReserve || tank.dailyCapWei - tank.spentTodayWei < tankReserve) throw new Refusal('tank_limit');
    return { gas, price, transactionCost, merchantKey, merchantSpent, replay };
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
    const { gas, price, transactionCost, merchantKey, merchantSpent, replay } = await this.checks(request);
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
      return hash;
    } catch (e) { this.trip(merchantKey); throw e; }
  }
  private trip(merchant: string) {
    const breaker = this.breakers.get(merchant) ?? { failures: 0, pausedUntil: 0 };
    if (++breaker.failures >= 3) { breaker.pausedUntil = Date.now() + 60_000; breaker.failures = 0; }
    this.breakers.set(merchant, breaker);
  }
}
export function allowedTargets(escrow: Address, subscription: Address, version: 1 | 2 = 1, receivables?: Address): Record<string, readonly Hex[]> {
  const selectors = (abi: Abi, names: string[]) => abi.filter((x): x is AbiFunction => x.type === 'function' && names.includes(x.name)).map(x => toFunctionSelector(x));
  return {
    [escrow.toLowerCase()]: selectors(escrowAbi, ['authorize', 'charge', 'capture', 'refund', 'void', 'reclaim']),
    [subscription.toLowerCase()]: selectors(version === 2 ? subscriptionV2Abi : subscriptionAbi, ['subscribe', 'charge', 'cancel', 'replace']),
    // Invoice financing: only the customer's payment is sponsored; everything else is sent from a wallet.
    ...(receivables ? { [receivables.toLowerCase()]: selectors(receivablesAbi, ['pay']) } : {}),
  };
}
