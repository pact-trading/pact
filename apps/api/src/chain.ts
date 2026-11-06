import { AccountWriter, type WriteOperation } from './account-writer.js';
import { FakeApprovalChain, ViemApprovalChain, gasCost } from './approval-chain.js';
import { USDT } from './token.js';
import { readAll } from './reads.js';
import { authorizationNonceOf, offlineAuthorizationNonce, termsTuple, usdtDomainSeparator, type ChargeTerms } from './collector.js';
const hasFunction = (abi: Abi, name: string) => abi.some(item => item.type === 'function' && item.name === name);
export { readAll } from './reads.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaseError, createPublicClient, createWalletClient, decodeErrorResult, decodeEventLog, decodeFunctionData, defineChain, encodeFunctionData, erc20Abi, keccak256, http, parseAbi, parseTransaction, TransactionReceiptNotFoundError, BlockNotFoundError, toHex, webSocket, type Abi, type Address, type Hex } from 'viem';
import type { X402Receipt, X402Transaction } from './x402/write-ports.js';
import { privateKeyToAccount } from 'viem/accounts';
import { DEFAULT_TERMS, CHECKOUT, INVOICE, feeFor, gasInUsdt } from './pricing.js';
import type { ChainAdapter, ChainEvent, ChainReceipt, FeeTerms, IntentRequest, Mandate, MerchantFees, Simulation, TokenTransfer, TransactionGas } from './types.js';
import { Refusal } from './types.js';

const artifact = (name: string): Abi => JSON.parse(readFileSync(process.env.CONTRACT_ARTIFACTS_DIR ? join(process.env.CONTRACT_ARTIFACTS_DIR, `${name}.sol`, `${name}.json`) : new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8')).abi as Abi;
export const routerAbi = artifact('Router');
export const escrowAbi = artifact('PaymentEscrow');
export const subscriptionAbi = artifact('SubscriptionManagerV2');
export const feeScheduleAbi = artifact('FeeSchedule');
export { receivablesAbi };
export interface Addresses { router: Address; escrow: Address; subscription: Address; fees: Address; /** Invoice financing, when deployed: its customer payments settle like escrow charges. */ receivables?: Address }
const receivablesAbi = artifact('InvoiceReceivables');
/** Multicall3, preinstalled on Whitechain (OP Stack): concurrent reads at one block become one eth_call. */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const chain = defineChain({ id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.whitechain.io'] } }, contracts: { multicall3: { address: MULTICALL3 } }, testnet: true });
/** How long chain reads that rarely change are reused. The simulation of every write still runs against
 * the live chain, so a stale value can only cause a refusal, never a wrong transaction. */
export interface ChainViewTtl { chainIdMs: number; gasPriceMs: number; policyMs: number; acceptedFeesMs: number; pendingNonceMs: number }
export const DEFAULT_TTL: ChainViewTtl = { chainIdMs: 60_000, gasPriceMs: 1_000, policyMs: 5_000, acceptedFeesMs: 15_000, pendingNonceMs: 10_000 };
/** The gas a relayed direct write may use at most, and the gas price it may pay. */
const MAX_RELAY_GAS = 3_000_000n;
const MAX_GAS_PRICE = 100_000_000_000n;
/** What one relayed write may spend from the shared per-minute relayer budget. */
const RELAY_SPEND_LIMIT = 100_000_000_000_000_000n;

/** The custom error a simulated call reverted with, by name, when one of the suite's ABIs knows it. */
export function revertName(error: unknown, abis: Abi[]): string | null {
  let data: Hex | undefined;
  if (error instanceof BaseError) {
    const found = error.walk(e => typeof (e as { data?: unknown }).data === 'string' && String((e as { data: string }).data).startsWith('0x'));
    data = (found as { data?: Hex } | null)?.data;
  }
  if (!data || data === '0x') return null;
  for (const abi of abis) { try { return decodeErrorResult({ abi, data }).errorName; } catch { /* try the next ABI */ } }
  return null;
}

export class FakeChain implements ChainAdapter {
  readonly writer = new AccountWriter('0x0000000000000000000000000000000000000099');
  readonly approval = new FakeApprovalChain(() => this.nextHash(), () => { this.transactions++; });
  constructor(readonly autoSettle = false) {
    // The offline stack has no wallets to fund or approve: every wallet holds USDT and has approved.
    if (autoSettle) this.approval.state = { balance: 1_000_000_000_000n, allowance: 2n ** 256n - 1n, nonce: 0n };
  }
  block = 0n;
  private transactions = 0;
  private sequence = 0;
  private pending = new Map<Hex, () => void>();
  private nextHash(): Hex { return `0x${(++this.sequence).toString(16).padStart(64, '0')}`; }
  logs: ChainEvent[] = [];
  receipts = new Map<string, ChainReceipt | null | Error>();
  sent: Array<{ request: IntentRequest; gas: bigint; nonce: number; gasPrice: bigint; hash: Hex }> = [];
  /** Direct relayer writes (permits, acceptances, signed financing orders), in order. */
  relayed: Array<{ operation: WriteOperation; to: Address; data: Hex; gas: bigint; hash: Hex }> = [];
  mandateNonces = new Map<string, bigint>();
  /** Subscriptions cancelled on this chain: their renewals are refused, as the contract refuses them. */
  cancelledSubscriptions = new Set<string>();
  simulation: Simulation = { accepted: true, gas: 200_000n };
  /** When set, `relay` refuses as a simulated revert with this error name. */
  relayRevert: string | null = null;
  price = 1_000_000_000n;
  policy = { usdtPerWbt: 79_000_000n, maxGasPerCall: 1_000_000n, maxGasPriceWei: 100_000_000_000n, minimumAmountMinor: 1_000_000n, maxPayerCallsPerDay: 10 };
  merchantBalances = new Map<string, bigint>();
  feeRecipient: Address = '0x00000000000000000000000000000000000000ff';
  terms: FeeTerms = DEFAULT_TERMS;
  latestVersion = 1;
  /** Explicit acceptances. With `autoSettle`, every merchant has accepted the latest version. */
  accepted = new Map<string, number>();
  acceptanceNonces = new Map<string, bigint>();
  async chainId() { return 1874; }
  async latestBlock() { return this.block; }
  /** Another relayer account on this same simulated chain: its own journal, everything else shared. */
  lane(address: Address): FakeChain {
    const writer = new AccountWriter(address);
    // Each account has its own nonce sequence: count this lane's broadcasts separately.
    let sent = 0;
    const own: Record<PropertyKey, unknown> = {
      writer,
      transactionCount: async () => sent,
      minedNonce: async () => sent,
      broadcastTransaction: async (raw: Hex) => { const hash = await this.broadcastTransaction(raw); sent++; return hash; },
    };
    return new Proxy(this, { get: (target, key) => key in own ? own[key] : Reflect.get(target, key, target) });
  }
  /** How far `safe` and `finalized` trail the latest block (both 0: everything is final at once). */
  safeLag = 0n;
  finalizedLag = 0n;
  /** Changing this rewrites the hash of every block from `reorgFrom` on: a simulated reorg. */
  reorgSalt = 0;
  reorgFrom = 0n;
  async finalityHeads() {
    const back = (lag: bigint) => this.block > lag ? this.block - lag : 0n;
    return { latest: this.block, safe: back(this.safeLag), finalized: back(this.finalizedLag) };
  }
  hashOf(block: bigint): Hex { return keccak256(toHex(`fake-block:${block}:${block >= this.reorgFrom ? this.reorgSalt : 0}`)); }
  async blockHash(block: bigint) { return block <= this.block ? this.hashOf(block) : null; }
  async authorizationNonce(terms: ChargeTerms) { return offlineAuthorizationNonce(terms, '0x0000000000000000000000000000000000000002'); }
  /** One-signature checkout on this chain (set false to exercise the permit path, as with mainnet USDT). */
  collectorEnabled = true;
  async collectorReady() { return this.collectorEnabled && hasFunction(escrowAbi, 'chargeWithAuthorization'); }
  /** USDT movements per transaction. With `autoSettle`, charges record the payer→merchant and fee transfers. */
  transfers = new Map<string, TokenTransfer[]>();
  async tokenTransfers(hash: Hex) { return this.transfers.get(hash.toLowerCase()) ?? (this.receipts.has(hash.toLowerCase()) ? [] : null); }
  async receipt(hash: Hex): Promise<ChainReceipt | null> {
    const receipt = this.receipts.get(hash.toLowerCase());
    if (receipt instanceof Error) throw receipt;
    if (receipt) return { ...receipt, blockHash: this.hashOf(receipt.block), events: receipt.events.map(event => ({ timestamp: new Date().toISOString(), feeRecipient: this.feeRecipient, blockHash: this.hashOf(event.block), ...event })) };
    const approval = await this.approval.receipt(hash);
    return approval ? { txHash: hash, block: approval.block, status: approval.status, events: [] } : null;
  }
  async events(from: bigint, to: bigint) { return this.logs.filter(x => x.block >= from && x.block <= to).map(x => ({ blockHash: this.hashOf(x.block), ...x })); }
  async simulate(_request: IntentRequest, _transaction: TransactionGas) { return this.simulation; }
  acceptedVersion(merchant: Address) { return this.accepted.get(merchant.toLowerCase()) ?? (this.autoSettle ? this.latestVersion : 0); }
  /** The fee the contracts would take, under the merchant's accepted terms. */
  feeOn(merchant: Address, product: typeof CHECKOUT | typeof INVOICE, amount: bigint) { return this.acceptedVersion(merchant) ? feeFor(this.terms, product, amount) : 0n; }
  async prepareIntent(request: IntentRequest, gas: bigint, nonce: number, gasPrice: bigint) {
    const raw = this.nextHash(), hash = keccak256(raw);
    this.nonceOfRaw.set(raw, nonce);
    this.pending.set(raw, () => {
    this.sent.push({ request, gas, nonce, gasPrice, hash });
    if (this.autoSettle) {
      let gasFee = 0n;
      try {
        const call = decodeFunctionData({ abi: escrowAbi, data: request.data });
        if (call.functionName === 'charge' || call.functionName === 'chargeInvoice') {
          const amount = BigInt(String(call.args![2]));
          const product = call.functionName === 'chargeInvoice' ? INVOICE : CHECKOUT;
          const fee = this.feeOn(request.intent.merchant, product, amount);
          this.emit({ id: `${hash}:charge`, txHash: hash, contract: 'escrow', name: 'Charged', args: { id: String(call.args![0]), payer: request.intent.signer, merchant: request.intent.merchant, amount, fee, product }, paymentTerms: { refundWindowSeconds: String(call.args![3]), refundDeadlineUnix: String(BigInt(Math.floor(Date.now() / 1000)) + BigInt(String(call.args![3]))) } });
          this.transfers.set(hash.toLowerCase(), [{ from: request.intent.signer, to: request.intent.merchant, value: amount - fee }, ...(fee ? [{ from: request.intent.signer, to: this.feeRecipient, value: fee }] : [])]);
        }
        if (call.functionName === 'refund') {
          this.emit({ id: `${hash}:refund`, txHash: hash, contract: 'escrow', name: 'Refunded', args: { id: String(call.args![0]), amount: BigInt(String(call.args![1])), reason: String(call.args![2]) } });
          // A refund pays its own gas, in USDT: the measured gas at the FeeSchedule price.
          gasFee = gasInUsdt(150_000n * gasPrice, this.policy.usdtPerWbt);
        }
      } catch { /* Other allowed calls do not create escrow events. */ }
      try {
        const call = decodeFunctionData({ abi: receivablesAbi, data: request.data });
        if (call.functionName === 'pay') this.emit({ id: `${hash}:paid`, txHash: hash, contract: 'receivables', name: 'Paid', args: { claimId: BigInt(String(call.args![0])), paymentId: String(call.args![1]), payer: request.intent.signer, amount: BigInt(String(call.args![2])), toHolders: BigInt(String(call.args![2])), toMerchant: 0n, fee: 0n } });
        if (call.functionName === 'buyBack') gasFee = gasInUsdt(300_000n * gasPrice, this.policy.usdtPerWbt);
      } catch { /* Not a financed invoice call. */ }
      this.emit({ id: `${hash}:executed`, txHash: hash, contract: 'router', name: 'Executed', args: { signer: request.intent.signer, merchant: request.intent.merchant, nonce: request.intent.nonce, target: request.intent.target, gasFee } });
      this.block += 2n;
    }
    });
    return { raw, hash };
  }
  async broadcastTransaction(raw: Hex): Promise<Hex> {
    const settle = this.pending.get(raw);
    if (!settle) {
      // The same signed bytes again: a node answers with the same hash and changes nothing.
      if (this.nonceOfRaw.has(raw) && this.settledNonces.has(this.nonceOfRaw.get(raw)!)) throw new Error('already known');
      throw new Error('Unknown prepared transaction');
    }
    settle(); this.transactions++; this.pending.delete(raw);
    if (this.nonceOfRaw.has(raw)) this.settledNonces.add(this.nonceOfRaw.get(raw)!);
    return keccak256(raw);
  }
  async transactionCount() { return this.transactions; }
  /** Nonces whose transaction reached this chain. A real chain mines them in order: a missing one holds the rest. */
  private settledNonces = new Set<number>();
  private nonceOfRaw = new Map<Hex, number>();
  async minedNonce() {
    if (!this.settledNonces.size) return this.transactions;
    let n = 0; while (this.settledNonces.has(n)) n++; return n;
  }
  async gasPrice() { return this.price; }
  async routerPolicy() { return { ...this.policy, blockNumber: this.block }; }
  async merchantBalance(merchant: Address) { return { token: USDT, blockNumber: this.block, balanceMinor: this.merchantBalances.get(merchant.toLowerCase()) ?? 0n }; }
  async merchantFees(merchant: Address): Promise<MerchantFees> {
    const version = this.acceptedVersion(merchant);
    return { acceptedVersion: version, latestVersion: this.latestVersion, accepted: version ? this.terms : null, latest: this.terms, recipient: this.feeRecipient, usdtPerWbt: this.policy.usdtPerWbt, nonce: this.acceptanceNonces.get(merchant.toLowerCase()) ?? 0n };
  }
  async relay(operation: WriteOperation, to: Address, data: Hex, gas: bigint): Promise<Hex> {
    if (gas <= 0n || gas > MAX_RELAY_GAS) throw new Refusal('relay_gas');
    if (this.relayRevert) throw new Refusal('relay_refused', this.relayRevert);
    try {
      return await this.writer.run(() => this.writer.execute(operation, () => this.transactionCount(), async () => {
        const raw = this.nextHash(), hash = keccak256(raw);
        this.pending.set(raw, () => {
          this.relayed.push({ operation, to, data, gas, hash });
          if (this.autoSettle) {
            // A one-signature charge sent straight to the escrow (EIP-3009 or Permit2, also inside a Multicall3
            // batch that first deploys a passkey account): the escrow charges as `charge` does.
            const escrowCalls: Hex[] = [data];
            try {
              const batch = decodeFunctionData({ abi: parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])']), data });
              for (const c of batch.args![0] as readonly { callData: Hex }[]) escrowCalls.push(c.callData);
            } catch { /* not a batch */ }
            for (const callData of escrowCalls) try {
              const call = decodeFunctionData({ abi: escrowAbi, data: callData });
              if (call.functionName === 'chargeWithAuthorization' || call.functionName === 'chargeWithPermit2') {
                const t = call.args![0] as { id: Hex; payer: Address; merchant: Address; amount: bigint; refundWindow: number; product: number };
                const product = Number(t.product) === 1 ? INVOICE : CHECKOUT;
                const fee = this.feeOn(t.merchant, product, BigInt(t.amount));
                const deadline = BigInt(Math.floor(Date.now() / 1000)) + BigInt(t.refundWindow);
                this.emit({ id: `${hash}:charge`, txHash: hash, contract: 'escrow', name: 'Charged', args: { id: t.id, payer: t.payer, merchant: t.merchant, amount: BigInt(t.amount), fee, product, refundDeadline: deadline, refundWindow: Number(t.refundWindow), feeRecipient: this.feeRecipient }, paymentTerms: { refundWindowSeconds: String(t.refundWindow), refundDeadlineUnix: String(deadline) } });
                this.transfers.set(hash.toLowerCase(), [{ from: t.payer, to: t.merchant, value: BigInt(t.amount) - fee }, ...(fee ? [{ from: t.payer, to: this.feeRecipient, value: fee }] : [])]);
                this.block += 2n;
              }
            } catch { /* Not an escrow call. */ }
            try {
              const call = decodeFunctionData({ abi: subscriptionAbi, data });
              if (call.functionName === 'subscribeWithPermit') {
                const mandate = call.args![0] as Mandate;
                this.mandateNonces.set(mandate.payer.toLowerCase(), (this.mandateNonces.get(mandate.payer.toLowerCase()) ?? 0n) + 1n);
              }
            } catch { /* Not a subscription call. */ }
            try {
              const call = decodeFunctionData({ abi: feeScheduleAbi, data });
              if (call.functionName === 'acceptWithSig') {
                const merchant = String(call.args![0]).toLowerCase();
                this.accepted.set(merchant, Number(call.args![1]));
                this.acceptanceNonces.set(merchant, (this.acceptanceNonces.get(merchant) ?? 0n) + 1n);
              }
            } catch { /* Not a FeeSchedule call. */ }
          }
        });
        return { raw, hash };
      }, raw => this.broadcastTransaction(raw)), operation.id);
    } catch (error) { this.writer.notSent(operation.id); throw error; }
  }
  /** Refusal codes the next renewals get from the contract (e.g. 2, TooEarly), in order; the fake does not track periods. */
  renewalRefusals: number[] = [];
  async prepareRenew(subscriptionId: Hex, amount: bigint, _nonce: number, merchant?: Address) {
    const raw = this.nextHash(), hash = keccak256(raw);
    // As the contract does: a renewal whose fee cannot be taken is refused (FeeUnavailable), not reverted.
    let fee: bigint | null;
    try { fee = merchant ? this.feeOn(merchant, CHECKOUT, amount) : feeFor(this.terms, CHECKOUT, amount); } catch { fee = null; }
    const refusal = this.renewalRefusals.shift();
    this.pending.set(raw, () => {
      if (!this.autoSettle) return;
      if (refusal !== undefined) this.emit({ id: `${hash}:refused`, txHash: hash, contract: 'subscription', name: 'Refused', args: { id: subscriptionId, reason: refusal } });
      else if (this.cancelledSubscriptions.has(subscriptionId.toLowerCase())) this.emit({ id: `${hash}:refused`, txHash: hash, contract: 'subscription', name: 'Refused', args: { id: subscriptionId, reason: 0 } });
      else if (fee === null) this.emit({ id: `${hash}:refused`, txHash: hash, contract: 'subscription', name: 'Refused', args: { id: subscriptionId, reason: 7 } });
      else this.emit({ id: `${hash}:renew`, txHash: hash, contract: 'subscription', name: 'Charged', args: { id: subscriptionId, amount, period: 1, fee } });
      this.block += 2n;
    });
    return { raw, hash };
  }
  async renewBatch(subscriptionIds: Hex[], amounts: bigint[], operation: WriteOperation): Promise<Hex> {
    if (!hasFunction(subscriptionAbi, 'chargeBatch')) throw new Refusal('batch_unavailable');
    try {
      return await this.writer.run(() => this.writer.execute(operation, () => this.transactionCount(), async () => {
        const raw = this.nextHash(), hash = keccak256(raw);
        const refusals = subscriptionIds.map(() => this.renewalRefusals.shift());
        this.pending.set(raw, () => {
          if (!this.autoSettle) return;
          subscriptionIds.forEach((id, i) => {
            const refusal = refusals[i];
            if (refusal !== undefined) this.emit({ id: `${hash}:refused:${i}`, txHash: hash, contract: 'subscription', name: 'Refused', args: { id, reason: refusal } });
            else if (this.cancelledSubscriptions.has(id.toLowerCase())) this.emit({ id: `${hash}:refused:${i}`, txHash: hash, contract: 'subscription', name: 'Refused', args: { id, reason: 0 } });
            else this.emit({ id: `${hash}:renew:${i}`, txHash: hash, contract: 'subscription', name: 'Charged', args: { id, amount: amounts[i], period: 1, fee: feeFor(this.terms, CHECKOUT, amounts[i]) } });
          });
          this.block += 2n;
        });
        return { raw, hash };
      }, raw => this.broadcastTransaction(raw)), operation.id);
    } catch (error) { this.writer.notSent(operation.id); throw error; }
  }
  async prepareSubscribe(mandate: Mandate, _signature: Hex, _nonce: number) {
    const current = await this.mandateNonce(mandate.payer);
    if (mandate.nonce !== current) throw new Error('Mandate nonce mismatch');
    const raw = this.nextHash(), hash = keccak256(raw);
    this.pending.set(raw, () => { this.mandateNonces.set(mandate.payer.toLowerCase(), current + 1n); });
    return { raw, hash };
  }
  async renew(subscriptionId: Hex, amount: bigint, operation = this.writer.operation('renew', subscriptionId)): Promise<Hex> {
    try { return await this.writer.run(() => this.writer.execute(operation, () => this.transactionCount(), nonce => this.prepareRenew(subscriptionId, amount, nonce), raw => this.broadcastTransaction(raw)), operation.id); }
    catch (error) { this.writer.notSent(operation.id); throw error; }
  }
  async subscribe(mandate: Mandate, signature: Hex, operation = this.writer.operation('subscribe', `${mandate.payer}:${mandate.nonce}`)): Promise<Hex> {
    try { return await this.writer.run(() => this.writer.execute(operation, () => this.transactionCount(), nonce => this.prepareSubscribe(mandate, signature, nonce), raw => this.broadcastTransaction(raw)), operation.id); }
    catch (error) { this.writer.notSent(operation.id); throw error; }
  }
  async cancelSigned(subscriptionId: Hex, _deadline: bigint, _signature: Hex, operation = this.writer.operation('cancel', subscriptionId)): Promise<Hex> {
    try { return await this.writer.run(() => this.writer.execute(operation, () => this.transactionCount(), () => this.prepareCancel(subscriptionId), raw => this.broadcastTransaction(raw)), operation.id); }
    catch (error) { this.writer.notSent(operation.id); throw error; }
  }
  /** Signs the relayer's `cancelWithSignature` transaction (offline). */
  async prepareCancel(subscriptionId: Hex): Promise<{ raw: Hex; hash: Hex }> {
    const raw = this.nextHash(), hash = keccak256(raw);
    this.pending.set(raw, () => { if (this.autoSettle) { this.emit({ id: `${hash}:cancel`, txHash: hash, contract: 'subscription', name: 'Cancelled', args: { id: subscriptionId } }); this.block += 2n; } });
    return { raw, hash };
  }
  async mandateNonce(payer: Address): Promise<bigint> { return this.mandateNonces.get(payer.toLowerCase()) ?? 0n; }
  emit(event: Omit<ChainEvent, 'block'>) {
    if (event.contract === 'subscription' && event.name === 'Cancelled') this.cancelledSubscriptions.add(String(event.args.id).toLowerCase());
    this.block++;
    const hash = event.txHash.toLowerCase();
    const previous = this.receipts.get(hash);
    const receipt = previous && !(previous instanceof Error) ? previous : { txHash: event.txHash, block: this.block, status: 'success' as const, events: [] };
    const log = { timestamp: new Date().toISOString(), feeRecipient: this.feeRecipient, ...event, block: receipt.block };
    this.logs.push(log);
    receipt.events.push(log);
    this.receipts.set(hash, receipt);
  }
}

const feeEvents = new Set(['escrow:Charged', 'escrow:Captured', 'subscription:Charged', 'receivables:Paid', 'router:Executed']);
type RateTuple = { bps: number; minFee: bigint; maxFee: bigint };
const rate = (r: RateTuple) => ({ bps: Number(r.bps), minFeeMinor: BigInt(r.minFee), maxFeeMinor: BigInt(r.maxFee) });
const termsOf = (t: { checkout: RateTuple; invoice: RateTuple }): FeeTerms => ({ checkout: rate(t.checkout), invoice: rate(t.invoice) });

export class ViemChain implements ChainAdapter {
  readonly writer: AccountWriter;
  readonly approval: ViemApprovalChain;
  private public;
  private account;
  private wallet;
  private blockTimes = new Map<bigint, string>();
  private recipients = new Map<bigint, Address>();
  private memo = new Map<string, { at: number; value: Promise<unknown> }>();
  /** The newest block a WebSocket subscription announced, when one is running. */
  private head: { number: bigint; at: number } | null = null;
  ttl: ChainViewTtl = DEFAULT_TTL;
  constructor(private rpcUrl: string, private privateKey: Hex, readonly addresses: Addresses, options: { batch?: boolean } = {}) {
    // Requests issued together go out as one JSON-RPC batch (Whitechain accepts up to 100 per batch).
    const batch = options.batch ?? process.env.RPC_BATCH !== '0';
    // Reads retry rate limits, 5xx and timeouts with backoff (a broadcast never does: the wallet client below
    // has no retries, and the watchdog resends exactly the signed bytes instead).
    this.public = createPublicClient({ chain, cacheTime: 0, transport: http(rpcUrl, { retryCount: 6, retryDelay: 200, timeout: 10_000, ...(batch ? { batch: { batchSize: 50, wait: 0 } } : {}) }) });
    this.account = privateKeyToAccount(privateKey);
    this.writer = new AccountWriter(this.account.address);
    this.approval = new ViemApprovalChain(rpcUrl, this.account);
    this.wallet = createWalletClient({ chain, account: this.account, transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }) });
  }
  get relayer() { return this.account.address; }
  /**
   * Another relayer account (a lane) on the same RPC: its own key, wallet, journal and permit signer; the
   * chain view, caches and head subscription are shared. Each lane key must be owned by this process alone.
   */
  lane(privateKey: Hex): ViemChain {
    const account = privateKeyToAccount(privateKey);
    const own: Record<PropertyKey, unknown> = {
      account,
      wallet: createWalletClient({ chain, account, transport: http(this.rpcUrl, { retryCount: 0, timeout: 10_000 }) }),
      writer: new AccountWriter(account.address),
      approval: new ViemApprovalChain(this.rpcUrl, account),
    };
    return new Proxy(this, {
      get: (target, key) => key in own ? own[key] : key === 'relayer' ? account.address : Reflect.get(target, key, target) as unknown,
    });
  }
  /**
   * One in-flight or recent read per key: concurrent callers share it, failures are not kept. Past its TTL a
   * value is still served (stale-while-revalidate) for up to 10x the TTL while one background refresh runs, so
   * the payment path never waits on a refresh; beyond that it waits for a fresh read.
   */
  private cached<T>(key: string, ttlMs: number, read: () => Promise<T>): Promise<T> {
    const hit = this.memo.get(key) as { at: number; value: Promise<T>; settled?: boolean; refreshing?: boolean } | undefined;
    const age = hit ? Date.now() - hit.at : Infinity;
    if (hit && age < ttlMs) return hit.value;
    if (hit?.settled && age < ttlMs * 10) {
      if (!hit.refreshing) {
        hit.refreshing = true;
        const next = read();
        next.then(() => { this.memo.set(key, { at: Date.now(), value: next, settled: true } as never); }, () => { hit.refreshing = false; });
      }
      return hit.value;
    }
    const value = read();
    const entry = { at: Date.now(), value, settled: false };
    this.memo.set(key, entry);
    value.then(() => { entry.settled = true; }, () => { if (this.memo.get(key)?.value === value) this.memo.delete(key); });
    if (this.memo.size > 4096) this.memo.delete(this.memo.keys().next().value!);
    return value;
  }
  /** Drops cached reads: all of them, or those whose key starts with `prefix`. */
  invalidate(prefix?: string) { for (const key of [...this.memo.keys()]) if (!prefix || key.startsWith(prefix)) this.memo.delete(key); }
  async chainId() { return this.cached('chainId', this.ttl.chainIdMs, () => this.public.getChainId()); }
  async finalityHeads() {
    // `safe` and `finalized` move in batch-sized jumps (minutes apart on Whitechain): read them every 2 s at most.
    const [latest, [safe, finalized]] = await Promise.all([
      this.latestBlock(),
      this.cached('finalityTags', 2_000, () => Promise.all([
        this.public.getBlock({ blockTag: 'safe' }).then(b => b.number!),
        this.public.getBlock({ blockTag: 'finalized' }).then(b => b.number!),
      ])),
    ]);
    return { latest, safe, finalized };
  }
  /** Whether the local nonce formula matches this escrow (checked once against its own view). */
  private localNonceVerified: Promise<boolean> | null = null;
  /** The escrow's EIP-3009 nonce for these terms: computed locally once the formula is verified against the escrow. */
  async authorizationNonce(terms: ChargeTerms): Promise<Hex> {
    const local = authorizationNonceOf(terms, this.addresses.escrow);
    const read = async () => await this.public.readContract({ address: this.addresses.escrow, abi: escrowAbi, functionName: 'authorizationNonce', args: [termsTuple(terms)] }) as Hex;
    this.localNonceVerified ??= read().then(onChain => {
      if (onChain.toLowerCase() === local.toLowerCase()) return true;
      console.error('Escrow authorizationNonce differs from the local formula: reading it from the escrow');
      return false;
    }, () => { this.localNonceVerified = null; return false; });
    return await this.localNonceVerified ? local : read();
  }
  /** One-signature checkout needs the v3 escrow and a USDT domain that matches the token's own separator. */
  async collectorReady() {
    return this.cached('collectorReady', 300_000, async () => {
      if (!hasFunction(escrowAbi, 'chargeWithAuthorization') || process.env.CHECKOUT_COLLECTOR === 'off') return false;
      try {
        const separator = await this.public.readContract({ address: USDT, abi: parseAbi(['function DOMAIN_SEPARATOR() view returns (bytes32)']), functionName: 'DOMAIN_SEPARATOR' });
        if (separator.toLowerCase() !== usdtDomainSeparator().toLowerCase()) { console.error('USDT EIP-712 domain mismatch: one-signature checkout disabled'); return false; }
        // The token must implement EIP-3009 (mainnet USDT has permit but not 3009): its view must answer.
        try {
          await this.public.readContract({ address: USDT, abi: parseAbi(['function authorizationState(address,bytes32) view returns (bool)']), functionName: 'authorizationState', args: ['0x0000000000000000000000000000000000000000', `0x${'0'.repeat(64)}`] });
          return true;
        } catch { console.error('USDT has no EIP-3009: one-signature checkout disabled, permit checkout in use'); }
      } catch (error) { console.error('USDT domain check failed: one-signature checkout disabled', error); }
      return false;
    });
  }
  async tokenTransfers(hash: Hex) {
    let receipt;
    try { receipt = await this.public.getTransactionReceipt({ hash }); }
    catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; }
    const out: TokenTransfer[] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDT.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
        if (decoded.eventName === 'Transfer') out.push({ from: decoded.args.from, to: decoded.args.to, value: decoded.args.value });
      } catch { /* not a Transfer */ }
    }
    return out;
  }
  async blockHash(block: bigint): Promise<Hex | null> {
    try { return (await this.public.getBlock({ blockNumber: block })).hash; }
    catch (error) { if (error instanceof BlockNotFoundError) return null; throw error; }
  }
  async latestBlock() {
    // A WebSocket head younger than a block is as fresh as a poll; otherwise ask (never viem's 4 s cache).
    if (this.head && Date.now() - this.head.at < 1_000) return this.head.number;
    return this.public.getBlockNumber({ cacheTime: 0 });
  }
  /**
   * Subscribes to new heads over WebSocket (Whitechain serves `newHeads` at /ws). Calls `onBlock` for each,
   * so the indexer and receipt reconciliation run when a block lands instead of on a timer.
   */
  watchHeads(wsUrl: string, onBlock: (block: bigint) => void, onError: (error: unknown) => void = () => {}) {
    const ws = createPublicClient({ chain, transport: webSocket(wsUrl, { retryCount: 1_000_000, retryDelay: 1_000, keepAlive: { interval: 15_000 }, reconnect: { attempts: 1_000_000, delay: 1_000 } }) });
    // Full headers: the head number for the indexer and each block's timestamp, so settling a receipt does not
    // read its block again.
    return ws.watchBlocks({ emitMissed: true, onBlock: header => {
      const block = header.number!;
      if (!this.head || block > this.head.number) this.head = { number: block, at: Date.now() };
      if (this.blockTimes.size >= 256) this.blockTimes.delete(this.blockTimes.keys().next().value!);
      this.blockTimes.set(block, new Date(Number(header.timestamp) * 1000).toISOString());
      onBlock(block);
    }, onError });
  }
  /** Where the FeeSchedule sent fees at a block; the recipient can move to a fee vault later. */
  private async recipientAt(block: bigint) {
    let recipient = this.recipients.get(block);
    if (!recipient) {
      recipient = await this.public.readContract({ address: this.addresses.fees, abi: feeScheduleAbi, functionName: 'recipient', blockNumber: block }) as Address;
      if (this.recipients.size >= 256) this.recipients.delete(this.recipients.keys().next().value!);
      this.recipients.set(block, recipient);
    }
    return recipient;
  }
  private async enrichEvents(events: ChainEvent[]) {
    for (const event of events) {
      let timestamp = this.blockTimes.get(event.block);
      if (!timestamp) {
        const block = await this.public.getBlock({ blockNumber: event.block });
        timestamp = new Date(Number(block.timestamp) * 1000).toISOString();
        if (this.blockTimes.size >= 256) this.blockTimes.delete(this.blockTimes.keys().next().value!);
        this.blockTimes.set(event.block, timestamp);
      }
      event.timestamp = timestamp;
      if (event.contract === 'escrow' && ['Authorized', 'Charged', 'Captured'].includes(event.name)) {
        if (event.args.refundDeadline !== undefined && event.args.refundWindow !== undefined) {
          // The v3 escrow puts the refund terms in the event itself: no read needed.
          event.paymentTerms = { refundWindowSeconds: String(event.args.refundWindow), refundDeadlineUnix: String(event.args.refundDeadline) };
        } else if (hasFunction(escrowAbi, 'paymentTerms')) {
          const [deadline, window] = await this.public.readContract({ address: this.addresses.escrow, abi: escrowAbi, functionName: 'paymentTerms', args: [event.args.id], blockNumber: event.block }) as readonly [bigint, number];
          event.paymentTerms = { refundWindowSeconds: String(window), refundDeadlineUnix: String(deadline) };
        } else {
          const payment = await this.public.readContract({ address: this.addresses.escrow, abi: escrowAbi, functionName: 'payments', args: [event.args.id], blockNumber: event.block }) as readonly unknown[];
          event.paymentTerms = { refundWindowSeconds: String(payment[7]), refundDeadlineUnix: String(payment[6]) };
        }
      }
      // v3 fee events name their recipient; older ones need the FeeSchedule read at that block.
      if (feeEvents.has(`${event.contract}:${event.name}`)) event.feeRecipient = typeof event.args.feeRecipient === 'string' ? event.args.feeRecipient as Address : await this.recipientAt(event.block);
    }
    return events;
  }
  private suite(): Array<[ChainEvent['contract'], Address, Abi]> {
    return [
      ['escrow', this.addresses.escrow, escrowAbi], ['subscription', this.addresses.subscription, subscriptionAbi],
      ['router', this.addresses.router, routerAbi],
      ...(this.addresses.receivables ? [['receivables', this.addresses.receivables, receivablesAbi] as [ChainEvent['contract'], Address, Abi]] : []),
    ];
  }
  async receipt(hash: Hex): Promise<ChainReceipt | null> {
    let receipt;
    try { receipt = await this.public.getTransactionReceipt({ hash }); }
    catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    }
    const events: ChainEvent[] = [];
    for (const log of receipt.logs) {
      const entry = this.suite().find(([, address]) => address.toLowerCase() === log.address.toLowerCase());
      if (!entry) continue;
      try {
        const decoded = decodeEventLog({ abi: entry[2], data: log.data, topics: log.topics });
        events.push({ id: `${receipt.transactionHash}:${log.logIndex}`, block: receipt.blockNumber, blockHash: receipt.blockHash, txHash: receipt.transactionHash, contract: entry[0], name: String(decoded.eventName), args: decoded.args as unknown as ChainEvent['args'] });
      } catch { /* Unknown suite logs are not settlement evidence. */ }
    }
    return { txHash: receipt.transactionHash, block: receipt.blockNumber, blockHash: receipt.blockHash, status: receipt.status, events: await this.enrichEvents(events), ...gasCost(receipt) };
  }
  async events(from: bigint, to: bigint): Promise<ChainEvent[]> {
    const out: ChainEvent[] = [];
    // One eth_getLogs for every suite contract: the address filter takes a list.
    const suite = this.suite();
    const logs = await this.public.getLogs({ address: suite.map(([, address]) => address), fromBlock: from, toBlock: to });
    for (const log of logs) {
      const entry = suite.find(([, address]) => address.toLowerCase() === log.address.toLowerCase());
      if (!entry) continue;
      const [contract, , abi] = entry;
      try {
        const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
        out.push({ id: `${log.transactionHash}:${log.logIndex}`, block: log.blockNumber!, blockHash: log.blockHash ?? undefined, txHash: log.transactionHash!, contract, name: String(decoded.eventName), args: decoded.args as unknown as Record<string, string | bigint | number> });
      } catch { /* unrelated event from a shared address */ }
    }
    return this.enrichEvents(out.sort((a, b) => a.block < b.block ? -1 : a.block > b.block ? 1 : a.id.localeCompare(b.id)));
  }
  /** The sequencer's suggested tip (Whitechain: 0.001 gwei), read at most every 30 s. */
  private async tip() {
    return this.cached('tip', 30_000, async () => BigInt(await this.public.request({ method: 'eth_maxPriorityFeePerGas' }) as Hex)).catch(() => 1_000_000n);
  }
  /**
   * EIP-1559 fees for a relayer transaction: a fee cap of twice the current gas price (so a base fee that
   * rises before inclusion does not strand the nonce) and the suggested tip. The chain charges base fee
   * plus tip, never the cap, so the headroom costs nothing.
   */
  async fees(gasPrice: bigint) {
    const cap = gasPrice * 2n < MAX_GAS_PRICE ? gasPrice * 2n : MAX_GAS_PRICE;
    const tip = await this.tip();
    return { maxFeePerGas: cap, maxPriorityFeePerGas: tip < cap ? tip : cap };
  }
  async simulate(request: IntentRequest, transaction: TransactionGas): Promise<Simulation> {
    try {
      // Simulated with the exact gas and fee fields the signed transaction carries.
      const result = await this.public.simulateContract({ address: this.addresses.router, abi: routerAbi, functionName: 'execute', args: [request.intent, request.data, request.signature], account: this.account, gas: transaction.gas, ...await this.fees(transaction.gasPrice) });
      const accepted = Array.isArray(result.result) && result.result[0] === true;
      return { accepted, reason: accepted ? undefined : 'Router refused intent', gas: transaction.gas };
    } catch (e) { return { accepted: false, reason: e instanceof Error ? e.message : 'Simulation failed', gas: 0n }; }
  }
  async prepareIntent(request: IntentRequest, gas: bigint, nonce: number, gasPrice: bigint) {
    const data = encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: [request.intent, request.data, request.signature] });
    const raw = await this.account.signTransaction({ type: 'eip1559', chainId: 1874, to: this.addresses.router, data, value: 0n, gas, nonce, ...await this.fees(gasPrice) });
    return { raw, hash: keccak256(raw) };
  }
  async broadcastTransaction(raw: Hex) { return this.wallet.sendRawTransaction({ serializedTransaction: raw }); }
  /** Signing only. No routing, estimation, wrapping or broadcast. The x402 coordinator must
   * authorize and durably reserve this exact envelope before AccountWriter invokes this. */
  async prepareX402Transaction(request: X402Transaction & { maxFeePerGas: bigint }, nonce: number) {
    if (request.chainId !== 1874 || await this.chainId() !== 1874 || request.value !== 0n
      || request.gas <= 0n || request.gas > 1_000_000n || request.maxFeePerGas <= 0n
      || request.maxFeePerGas > MAX_GAS_PRICE || !Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Invalid x402 envelope');
    // Legacy gasPrice is exactly the authorized ceiling, as with prepareIntent. It cannot
    // exceed the gas * maxFeePerGas admission reservation and needs no fee-estimation RPC.
    const raw = await this.account.signTransaction({ type: 'legacy', chainId: 1874, to: request.to,
      data: request.data, value: 0n, gas: request.gas, nonce, gasPrice: request.maxFeePerGas });
    return { raw, hash: keccak256(raw) };
  }
  /** Signing only, for agent-account setup and other direct writes: bounded gas, no value. */
  async prepareAgentTransaction(request: { to: Address; data: Hex; gas: bigint; maxFeePerGas: bigint }, nonce: number) {
    if (await this.chainId() !== 1874 || request.gas <= 0n || request.gas > MAX_RELAY_GAS || request.maxFeePerGas <= 0n
      || request.maxFeePerGas > MAX_GAS_PRICE || !Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Invalid agent transaction');
    const raw = await this.account.signTransaction({ type: 'eip1559', chainId: 1874, to: request.to, data: request.data, value: 0n, gas: request.gas, nonce, ...await this.fees(request.maxFeePerGas) });
    return { raw, hash: keccak256(raw) };
  }
  async relay(operation: WriteOperation, to: Address, data: Hex, gas: bigint, budgetWei?: bigint): Promise<Hex> {
    if (gas <= 0n || gas > MAX_RELAY_GAS) throw new Refusal('relay_gas');
    if (await this.chainId() !== 1874) throw new Refusal('wrong_chain');
    const price = await this.gasPrice();
    if (price <= 0n || price > MAX_GAS_PRICE) throw new Refusal('gas_price');
    // Refuse before sending: a revert would cost Pact gas and tell the signer nothing.
    try { await this.public.call({ account: this.account.address, to, data, gas }); }
    catch (error) { throw new Refusal('relay_refused', revertName(error, [feeScheduleAbi, receivablesAbi, escrowAbi, subscriptionAbi, routerAbi]) ?? 'reverted'); }
    try {
      return await this.writer.run(() => this.writer.execute(operation, () => this.transactionCount(), async nonce => {
        const prepared = await this.prepareAgentTransaction({ to, data, gas, maxFeePerGas: price }, nonce);
        // Budgeted at the caller's expected cost when it has one (measured gas), else the gas limit.
        this.writer.reserveSpend(operation.id, budgetWei && budgetWei > 0n ? budgetWei : gas * price, RELAY_SPEND_LIMIT);
        return prepared;
      }, raw => this.broadcastTransaction(raw)), operation.id);
    } catch (error) { this.writer.notSent(operation.id); throw error; }
  }
  async x402BlockNumber() { return this.public.getBlockNumber({ cacheTime: 0 }); }
  async x402Receipt(hash: Hex): Promise<X402Receipt | null> {
    try {
      const receipt = await this.public.getTransactionReceipt({ hash });
      return { txHash: receipt.transactionHash, block: receipt.blockNumber, status: receipt.status, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice,
        logs: receipt.logs.map(({ address, topics, data }) => ({ address, topics, data })) };
    } catch (error) {
      if (error instanceof TransactionReceiptNotFoundError) return null;
      throw error;
    }
  }
  async x402ReservationValid(account: Address, digest: Hex, signature: Hex) {
    if (await this.chainId() !== 1874) throw new Error('Wrong chain');
    return await this.public.readContract({ address: account,
      abi: parseAbi(['function isValidSignature(bytes32,bytes) view returns (bytes4)']),
      functionName: 'isValidSignature', args: [digest, signature] }) === '0x1626ba7e';
  }
  /**
   * The node's pending nonce for the relayer. The journal is the nonce authority (AccountWriter takes the
   * max of this and one past its highest journaled nonce), so a slightly old value is safe while this
   * process alone owns the key; it only matters for the first write of a fresh journal.
   */
  /** Relayer transactions already mined: the watchdog resends only what is at or above this nonce. */
  async minedNonce() { return this.public.getTransactionCount({ address: this.account.address, blockTag: 'latest' }); }
  async transactionCount() { return this.cached(`pendingNonce:${this.account.address}`, this.ttl.pendingNonceMs, () => this.public.getTransactionCount({ address: this.account.address, blockTag: 'pending' })); }
  async gasPrice() { return this.cached('gasPrice', this.ttl.gasPriceMs, () => this.public.getGasPrice()); }
  async routerPolicy() { return this.cached('policy', this.ttl.policyMs, () => this.readRouterPolicy()); }
  private async readRouterPolicy() {
    if (await this.chainId() !== 1874) throw new Error('Wrong chain');
    const blockNumber = await this.latestBlock();
    const [token, gas, price, minimum, payerCalls, rateRead] = await readAll(this.public, [
      ...['usdt', 'maxGasPerCall', 'maxGasPrice', 'minAmount', 'maxPayerCallsPerDay'].map(functionName => ({ address: this.addresses.router, abi: routerAbi, functionName })),
      { address: this.addresses.fees, abi: feeScheduleAbi, functionName: 'usdtPerWBT' },
    ], blockNumber);
    if (String(token).toLowerCase() !== USDT.toLowerCase()) throw new Error('Unexpected Router token');
    return { blockNumber, usdtPerWbt: BigInt(String(rateRead)), maxGasPerCall: BigInt(String(gas)), maxGasPriceWei: BigInt(String(price)), minimumAmountMinor: BigInt(String(minimum)), maxPayerCallsPerDay: Number(payerCalls) };
  }
  async merchantBalance(merchant: Address) {
    if (await this.chainId() !== 1874) throw new Error('Wrong chain');
    const blockNumber = await this.latestBlock();
    const [routerToken, escrowToken, decimals, balanceMinor] = await readAll(this.public, [
      { address: this.addresses.router, abi: routerAbi, functionName: 'usdt' },
      { address: this.addresses.escrow, abi: escrowAbi, functionName: 'usdt' },
      { address: USDT, abi: erc20Abi as Abi, functionName: 'decimals' },
      { address: USDT, abi: erc20Abi as Abi, functionName: 'balanceOf', args: [merchant] },
    ], blockNumber) as [unknown, unknown, number, bigint];
    if ([routerToken, escrowToken].some(token => String(token).toLowerCase() !== USDT.toLowerCase())) throw new Error('Unexpected settlement token');
    if (decimals !== 6) throw new Error('Unexpected USDT decimals');
    return { token: USDT, blockNumber, balanceMinor };
  }
  /** A merchant's fee position. Kept briefly once terms are accepted (they change only by a new signed
   * acceptance, which invalidates it); never kept while unaccepted, so a fresh acceptance takes effect at once. */
  async merchantFees(merchant: Address): Promise<MerchantFees> {
    const key = `fees:${merchant.toLowerCase()}`;
    const fees = await this.cached(key, this.ttl.acceptedFeesMs, () => this.readMerchantFees(merchant));
    if (!fees.acceptedVersion) this.memo.delete(key);
    return fees;
  }
  private async readMerchantFees(merchant: Address): Promise<MerchantFees> {
    if (await this.chainId() !== 1874) throw new Error('Wrong chain');
    const blockNumber = await this.latestBlock();
    const read = (functionName: string, args: unknown[] = []) => ({ address: this.addresses.fees, abi: feeScheduleAbi, functionName, args });
    const [accepted, latest, recipient, price, nonce] = await readAll(this.public, [read('acceptedVersion', [merchant]), read('latestVersion'), read('recipient'), read('usdtPerWBT'), read('nonces', [merchant])], blockNumber);
    const acceptedVersion = Number(accepted), latestVersion = Number(latest);
    const [latestTerms, acceptedTerms = null] = await readAll(this.public, [read('terms', [latestVersion]), ...(acceptedVersion ? [read('terms', [acceptedVersion])] : [])], blockNumber);
    return {
      acceptedVersion, latestVersion, recipient: recipient as Address, usdtPerWbt: BigInt(String(price)), nonce: BigInt(String(nonce)),
      accepted: acceptedTerms ? termsOf(acceptedTerms as { checkout: RateTuple; invoice: RateTuple }) : null,
      latest: termsOf(latestTerms as { checkout: RateTuple; invoice: RateTuple }),
    };
  }
  private async prepareSubscription(data: Hex, nonce: number, maxGas = 1_000_000n) {
    if (await this.chainId() !== 1874) throw new Error('Wrong chain');
    const request = await this.wallet.prepareTransactionRequest({ type: 'eip1559', to: this.addresses.subscription, data, value: 0n, nonce });
    if (request.chainId !== 1874) throw new Error('Wrong chain');
    if (!request.gas || request.gas > maxGas || !request.maxFeePerGas || request.maxFeePerGas > MAX_GAS_PRICE) throw new Error('Subscription gas budget exceeded');
    const raw = await this.account.signTransaction({ type: 'eip1559', chainId: 1874, to: this.addresses.subscription, data, value: 0n, nonce, gas: request.gas, maxFeePerGas: request.maxFeePerGas, maxPriorityFeePerGas: request.maxPriorityFeePerGas });
    return { raw, hash: keccak256(raw) };
  }
  /** Up to `RENEWAL_BATCH` renewals in one keeper transaction: one nonce and one intrinsic cost for all. */
  async renewBatch(subscriptionIds: Hex[], amounts: bigint[], operation: WriteOperation): Promise<Hex> {
    if (!hasFunction(subscriptionAbi, 'chargeBatch')) throw new Refusal('batch_unavailable');
    const data = encodeFunctionData({ abi: subscriptionAbi, functionName: 'chargeBatch', args: [subscriptionIds, amounts] });
    try { return await this.writer.run(() => this.writer.execute(operation, () => this.transactionCount(), nonce => this.budgetWrite(operation, () => this.prepareSubscription(data, nonce, 3_000_000n)), raw => this.broadcastTransaction(raw)), operation.id); }
    catch (error) { this.writer.notSent(operation.id); throw error; }
  }
  async prepareRenew(subscriptionId: Hex, amount: bigint, nonce: number) {
    return this.prepareSubscription(encodeFunctionData({ abi: subscriptionAbi, functionName: 'charge', args: [subscriptionId, amount] }), nonce);
  }
  async prepareSubscribe(mandate: Mandate, signature: Hex, nonce: number) {
    return this.prepareSubscription(encodeFunctionData({ abi: subscriptionAbi, functionName: 'subscribe', args: [mandate, signature] }), nonce);
  }
  async renew(subscriptionId: Hex, amount: bigint, operation = this.writer.operation('renew', subscriptionId)): Promise<Hex> {
    try { return await this.writer.run(() => this.writer.execute(operation, () => this.transactionCount(), nonce => this.budgetWrite(operation, () => this.prepareRenew(subscriptionId, amount, nonce)), raw => this.broadcastTransaction(raw)), operation.id); }
    catch (error) { this.writer.notSent(operation.id); throw error; }
  }
  async subscribe(mandate: Mandate, signature: Hex, operation = this.writer.operation('subscribe', `${mandate.payer}:${mandate.nonce}`)): Promise<Hex> {
    try { return await this.writer.run(() => this.writer.execute(operation, () => this.transactionCount(), nonce => this.budgetWrite(operation, () => this.prepareSubscribe(mandate, signature, nonce)), raw => this.broadcastTransaction(raw)), operation.id); }
    catch (error) { this.writer.notSent(operation.id); throw error; }
  }
  private async budgetWrite(operation: WriteOperation, prepare: () => Promise<{ raw: Hex; hash: Hex }>) {
    const prepared = await prepare();
    const transaction = parseTransaction(prepared.raw);
    this.writer.reserveSpend(operation.id, transaction.gas! * (transaction.maxFeePerGas ?? transaction.gasPrice!), 10_000_000_000_000_000n);
    return prepared;
  }
  async cancelSigned(subscriptionId: Hex, deadline: bigint, signature: Hex, operation = this.writer.operation('cancel', subscriptionId)): Promise<Hex> {
    try { return await this.writer.run(() => this.writer.execute(operation, () => this.transactionCount(), nonce => this.budgetWrite(operation, () => this.prepareSubscription(encodeFunctionData({ abi: subscriptionAbi, functionName: 'cancelWithSignature', args: [subscriptionId, deadline, signature] }), nonce)), raw => this.broadcastTransaction(raw)), operation.id); }
    catch (error) { this.writer.notSent(operation.id); throw error; }
  }
  async mandateNonce(payer: Address): Promise<bigint> { return this.public.readContract({ address: this.addresses.subscription, abi: subscriptionAbi, functionName: 'nonces', args: [payer] }) as Promise<bigint>; }
}
