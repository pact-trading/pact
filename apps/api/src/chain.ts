import { AccountWriter, type WriteOperation } from './account-writer.js';
import { FakeApprovalChain, ViemApprovalChain, gasCost } from './approval-chain.js';
import { USDT } from './token.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaseError, createPublicClient, createWalletClient, decodeErrorResult, decodeEventLog, decodeFunctionData, defineChain, encodeFunctionData, erc20Abi, keccak256, http, parseAbi, parseTransaction, TransactionReceiptNotFoundError, type Abi, type Address, type Hex } from 'viem';
import type { X402Receipt, X402Transaction } from './x402/write-ports.js';
import { privateKeyToAccount } from 'viem/accounts';
import { DEFAULT_TERMS, CHECKOUT, INVOICE, feeFor, gasInUsdt } from './pricing.js';
import type { ChainAdapter, ChainEvent, ChainReceipt, FeeTerms, IntentRequest, Mandate, MerchantFees, Simulation, TransactionGas } from './types.js';
import { Refusal } from './types.js';

const artifact = (name: string): Abi => JSON.parse(readFileSync(process.env.CONTRACT_ARTIFACTS_DIR ? join(process.env.CONTRACT_ARTIFACTS_DIR, `${name}.sol`, `${name}.json`) : new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8')).abi as Abi;
export const routerAbi = artifact('Router');
export const escrowAbi = artifact('PaymentEscrow');
export const subscriptionAbi = artifact('SubscriptionManagerV2');
export const feeScheduleAbi = artifact('FeeSchedule');
export { receivablesAbi };
export interface Addresses { router: Address; escrow: Address; subscription: Address; fees: Address; /** Invoice financing, when deployed: its customer payments settle like escrow charges. */ receivables?: Address }
const receivablesAbi = artifact('InvoiceReceivables');
const chain = defineChain({ id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.whitechain.io'] } }, testnet: true });
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
  async receipt(hash: Hex): Promise<ChainReceipt | null> {
    const receipt = this.receipts.get(hash.toLowerCase());
    if (receipt instanceof Error) throw receipt;
    if (receipt) return { ...receipt, events: receipt.events.map(event => ({ timestamp: new Date().toISOString(), feeRecipient: this.feeRecipient, ...event })) };
    const approval = await this.approval.receipt(hash);
    return approval ? { txHash: hash, block: approval.block, status: approval.status, events: [] } : null;
  }
  async events(from: bigint, to: bigint) { return this.logs.filter(x => x.block >= from && x.block <= to); }
  async simulate(_request: IntentRequest, _transaction: TransactionGas) { return this.simulation; }
  acceptedVersion(merchant: Address) { return this.accepted.get(merchant.toLowerCase()) ?? (this.autoSettle ? this.latestVersion : 0); }
  /** The fee the contracts would take, under the merchant's accepted terms. */
  feeOn(merchant: Address, product: typeof CHECKOUT | typeof INVOICE, amount: bigint) { return this.acceptedVersion(merchant) ? feeFor(this.terms, product, amount) : 0n; }
  async prepareIntent(request: IntentRequest, gas: bigint, nonce: number, gasPrice: bigint) {
    const raw = this.nextHash(), hash = keccak256(raw);
    this.pending.set(raw, () => {
    this.sent.push({ request, gas, nonce, gasPrice, hash });
    if (this.autoSettle) {
      let gasFee = 0n;
      try {
        const call = decodeFunctionData({ abi: escrowAbi, data: request.data });
        if (call.functionName === 'charge' || call.functionName === 'chargeInvoice') {
          const amount = BigInt(String(call.args![2]));
          const product = call.functionName === 'chargeInvoice' ? INVOICE : CHECKOUT;
          this.emit({ id: `${hash}:charge`, txHash: hash, contract: 'escrow', name: 'Charged', args: { id: String(call.args![0]), payer: request.intent.signer, merchant: request.intent.merchant, amount, fee: this.feeOn(request.intent.merchant, product, amount), product }, paymentTerms: { refundWindowSeconds: String(call.args![3]), refundDeadlineUnix: String(BigInt(Math.floor(Date.now() / 1000)) + BigInt(String(call.args![3]))) } });
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
    const settle = this.pending.get(raw); if (!settle) throw new Error('Unknown prepared transaction');
    settle(); this.transactions++; this.pending.delete(raw); return keccak256(raw);
  }
  async transactionCount() { return this.transactions; }
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
  constructor(private rpcUrl: string, private privateKey: Hex, readonly addresses: Addresses) {
    this.public = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }) });
    this.account = privateKeyToAccount(privateKey);
    this.writer = new AccountWriter(this.account.address);
    this.approval = new ViemApprovalChain(rpcUrl, this.account);
    this.wallet = createWalletClient({ chain, account: this.account, transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }) });
  }
  get relayer() { return this.account.address; }
  async chainId() { return this.public.getChainId(); }
  async latestBlock() { return this.public.getBlockNumber(); }
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
        const payment = await this.public.readContract({ address: this.addresses.escrow, abi: escrowAbi, functionName: 'payments', args: [event.args.id], blockNumber: event.block }) as readonly unknown[];
        event.paymentTerms = { refundWindowSeconds: String(payment[7]), refundDeadlineUnix: String(payment[6]) };
      }
      if (feeEvents.has(`${event.contract}:${event.name}`)) event.feeRecipient = await this.recipientAt(event.block);
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
        events.push({ id: `${receipt.transactionHash}:${log.logIndex}`, block: receipt.blockNumber, txHash: receipt.transactionHash, contract: entry[0], name: String(decoded.eventName), args: decoded.args as unknown as ChainEvent['args'] });
      } catch { /* Unknown suite logs are not settlement evidence. */ }
    }
    return { txHash: receipt.transactionHash, block: receipt.blockNumber, status: receipt.status, events: await this.enrichEvents(events), ...gasCost(receipt) };
  }
  async events(from: bigint, to: bigint): Promise<ChainEvent[]> {
    const out: ChainEvent[] = [];
    for (const [contract, address, abi] of this.suite()) {
      const logs = await this.public.getLogs({ address, fromBlock: from, toBlock: to });
      for (const log of logs) {
        try {
          const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
          out.push({ id: `${log.transactionHash}:${log.logIndex}`, block: log.blockNumber!, txHash: log.transactionHash!, contract, name: String(decoded.eventName), args: decoded.args as unknown as Record<string, string | bigint | number> });
        } catch { /* unrelated event from a shared address */ }
      }
    }
    return this.enrichEvents(out.sort((a, b) => a.block < b.block ? -1 : a.block > b.block ? 1 : a.id.localeCompare(b.id)));
  }
  async simulate(request: IntentRequest, transaction: TransactionGas): Promise<Simulation> {
    try {
      const result = await this.public.simulateContract({ address: this.addresses.router, abi: routerAbi, functionName: 'execute', args: [request.intent, request.data, request.signature], account: this.account, ...transaction });
      const accepted = Array.isArray(result.result) && result.result[0] === true;
      return { accepted, reason: accepted ? undefined : 'Router refused intent', gas: transaction.gas };
    } catch (e) { return { accepted: false, reason: e instanceof Error ? e.message : 'Simulation failed', gas: 0n }; }
  }
  async prepareIntent(request: IntentRequest, gas: bigint, nonce: number, gasPrice: bigint) {
    const data = encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: [request.intent, request.data, request.signature] });
    const raw = await this.account.signTransaction({ type: 'legacy', chainId: 1874, to: this.addresses.router, data, value: 0n, gas, nonce, gasPrice });
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
    const raw = await this.account.signTransaction({ type: 'legacy', chainId: 1874, to: request.to, data: request.data, value: 0n, gas: request.gas, nonce, gasPrice: request.maxFeePerGas });
    return { raw, hash: keccak256(raw) };
  }
  async relay(operation: WriteOperation, to: Address, data: Hex, gas: bigint): Promise<Hex> {
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
        this.writer.reserveSpend(operation.id, gas * price, RELAY_SPEND_LIMIT);
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
  async transactionCount() { return this.public.getTransactionCount({ address: this.account.address, blockTag: 'pending' }); }
  async gasPrice() { return this.public.getGasPrice(); }
  async routerPolicy() {
    if (await this.chainId() !== 1874) throw new Error('Wrong chain');
    const blockNumber = await this.public.getBlockNumber({ cacheTime: 0 });
    const read = (functionName: string) => this.public.readContract({ address: this.addresses.router, abi: routerAbi, functionName, blockNumber });
    const [token, gas, price, minimum, payerCalls, rateRead] = await Promise.all([
      ...['usdt', 'maxGasPerCall', 'maxGasPrice', 'minAmount', 'maxPayerCallsPerDay'].map(read),
      this.public.readContract({ address: this.addresses.fees, abi: feeScheduleAbi, functionName: 'usdtPerWBT', blockNumber }),
    ]);
    if (String(token).toLowerCase() !== USDT.toLowerCase()) throw new Error('Unexpected Router token');
    return { blockNumber, usdtPerWbt: BigInt(String(rateRead)), maxGasPerCall: BigInt(String(gas)), maxGasPriceWei: BigInt(String(price)), minimumAmountMinor: BigInt(String(minimum)), maxPayerCallsPerDay: Number(payerCalls) };
  }
  async merchantBalance(merchant: Address) {
    if (await this.chainId() !== 1874) throw new Error('Wrong chain');
    const blockNumber = await this.public.getBlockNumber({ cacheTime: 0 });
    const [routerToken, escrowToken, decimals, balanceMinor] = await Promise.all([
      this.public.readContract({ address: this.addresses.router, abi: routerAbi, functionName: 'usdt', blockNumber }),
      this.public.readContract({ address: this.addresses.escrow, abi: escrowAbi, functionName: 'usdt', blockNumber }),
      this.public.readContract({ address: USDT, abi: erc20Abi, functionName: 'decimals', blockNumber }),
      this.public.readContract({ address: USDT, abi: erc20Abi, functionName: 'balanceOf', args: [merchant], blockNumber }),
    ]);
    if ([routerToken, escrowToken].some(token => String(token).toLowerCase() !== USDT.toLowerCase())) throw new Error('Unexpected settlement token');
    if (decimals !== 6) throw new Error('Unexpected USDT decimals');
    return { token: USDT, blockNumber, balanceMinor };
  }
  async merchantFees(merchant: Address): Promise<MerchantFees> {
    if (await this.chainId() !== 1874) throw new Error('Wrong chain');
    const blockNumber = await this.public.getBlockNumber({ cacheTime: 0 });
    const read = (functionName: string, args: unknown[] = []) => this.public.readContract({ address: this.addresses.fees, abi: feeScheduleAbi, functionName, args, blockNumber });
    const [accepted, latest, recipient, price, nonce] = await Promise.all([read('acceptedVersion', [merchant]), read('latestVersion'), read('recipient'), read('usdtPerWBT'), read('nonces', [merchant])]);
    const acceptedVersion = Number(accepted), latestVersion = Number(latest);
    const [acceptedTerms, latestTerms] = await Promise.all([
      acceptedVersion ? read('terms', [acceptedVersion]) : Promise.resolve(null),
      read('terms', [latestVersion]),
    ]);
    return {
      acceptedVersion, latestVersion, recipient: recipient as Address, usdtPerWbt: BigInt(String(price)), nonce: BigInt(String(nonce)),
      accepted: acceptedTerms ? termsOf(acceptedTerms as { checkout: RateTuple; invoice: RateTuple }) : null,
      latest: termsOf(latestTerms as { checkout: RateTuple; invoice: RateTuple }),
    };
  }
  private async prepareSubscription(data: Hex, nonce: number) {
    if (await this.chainId() !== 1874) throw new Error('Wrong chain');
    const request = await this.wallet.prepareTransactionRequest({ type: 'eip1559', to: this.addresses.subscription, data, value: 0n, nonce });
    if (request.chainId !== 1874) throw new Error('Wrong chain');
    if (!request.gas || request.gas > 1_000_000n || !request.maxFeePerGas || request.maxFeePerGas > MAX_GAS_PRICE) throw new Error('Subscription gas budget exceeded');
    const raw = await this.account.signTransaction({ type: 'eip1559', chainId: 1874, to: this.addresses.subscription, data, value: 0n, nonce, gas: request.gas, maxFeePerGas: request.maxFeePerGas, maxPriorityFeePerGas: request.maxPriorityFeePerGas });
    return { raw, hash: keccak256(raw) };
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
