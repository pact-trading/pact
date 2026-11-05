import { AccountWriter, type WriteOperation } from './account-writer.js';
import { FakeApprovalChain, ViemApprovalChain } from './approval-chain.js';
import { USDT } from './token.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, createWalletClient, decodeEventLog, decodeFunctionData, defineChain, encodeFunctionData, erc20Abi, keccak256, http, parseAbi, parseTransaction, TransactionReceiptNotFoundError, type Abi, type Address, type Hex } from 'viem';
import type { X402Receipt, X402Transaction } from './x402/write-ports.js';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainAdapter, ChainEvent, ChainReceipt, IntentRequest, Mandate, MerchantConsent, Simulation, TransactionGas } from './types.js';

const artifact = (name: string): Abi => JSON.parse(readFileSync(process.env.CONTRACT_ARTIFACTS_DIR ? join(process.env.CONTRACT_ARTIFACTS_DIR, `${name}.sol`, `${name}.json`) : new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8')).abi as Abi;
export const routerAbi = artifact('Router');
export const escrowAbi = artifact('PaymentEscrow');
export const subscriptionAbi = artifact('SubscriptionManager');
export const subscriptionV2Abi = artifact('SubscriptionManagerV2');
export const gasTankAbi = artifact('GasTank');
export { receivablesAbi };
export interface Addresses { router: Address; escrow: Address; subscription: Address; gasTank: Address; /** Invoice financing, when deployed: its customer payments settle like escrow charges. */ receivables?: Address }
const receivablesAbi = artifact('InvoiceReceivables');
const chain = defineChain({ id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.whitechain.io'] } }, testnet: true });

export class FakeChain implements ChainAdapter {
  readonly writer = new AccountWriter('0x0000000000000000000000000000000000000099');
  readonly approval = new FakeApprovalChain(() => this.nextHash(), () => { this.transactions++; });
  constructor(readonly autoSettle = false, readonly subscriptionVersion: 1 | 2 = 1) {}
  block = 0n;
  private transactions = 0;
  private sequence = 0;
  private pending = new Map<Hex, () => void>();
  private nextHash(): Hex { return `0x${(++this.sequence).toString(16).padStart(64, '0')}`; }
  logs: ChainEvent[] = [];
  receipts = new Map<string, ChainReceipt | null | Error>();
  sent: Array<{ request: IntentRequest; gas: bigint; nonce: number; gasPrice: bigint; hash: Hex }> = [];
  tank = new Map<string, { balanceWei: bigint; dailyCapWei: bigint; spentTodayWei: bigint }>();
  mandateNonces = new Map<string, bigint>();
  simulation: Simulation = { accepted: true, gas: 200_000n };
  price = 1_000_000_000n;
  policy = { usdtPerWbt: 1_000_000n, maxGasPerCall: 1_000_000n, maxGasPriceWei: 100_000_000_000n, minimumAmountMinor: 1_000_000n, maxPayerCallsPerDay: 10 };
  merchantBalances = new Map<string, bigint>();
  feeRecipient: Address = '0x00000000000000000000000000000000000000ff';
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
  async prepareIntent(request: IntentRequest, gas: bigint, nonce: number, gasPrice: bigint) {
    const raw = this.nextHash(), hash = keccak256(raw);
    this.pending.set(raw, () => {
    this.sent.push({ request, gas, nonce, gasPrice, hash });
    if (this.autoSettle) {
      try {
        const call = decodeFunctionData({ abi: escrowAbi, data: request.data });
        if (call.functionName === 'charge') this.emit({ id: `${hash}:charge`, txHash: hash, contract: 'escrow', name: 'Charged', args: { id: String(call.args![0]), payer: request.intent.signer, merchant: request.intent.merchant, amount: BigInt(String(call.args![2])) }, paymentTerms: { refundWindowSeconds: String(call.args![3]), refundDeadlineUnix: String(BigInt(Math.floor(Date.now() / 1000)) + BigInt(String(call.args![3]))) } });
        if (call.functionName === 'refund') this.emit({ id: `${hash}:refund`, txHash: hash, contract: 'escrow', name: 'Refunded', args: { id: String(call.args![0]), amount: BigInt(String(call.args![1])), reason: String(call.args![2]) } });
      } catch { /* Other allowed calls do not create escrow events. */ }
      try {
        const call = decodeFunctionData({ abi: receivablesAbi, data: request.data });
        if (call.functionName === 'pay') this.emit({ id: `${hash}:paid`, txHash: hash, contract: 'receivables', name: 'Paid', args: { claimId: BigInt(String(call.args![0])), paymentId: String(call.args![1]), payer: request.intent.signer, amount: BigInt(String(call.args![2])), toHolders: BigInt(String(call.args![2])), toMerchant: 0n } });
      } catch { /* Not a financed invoice payment. */ }
      this.emit({ id: `${hash}:executed`, txHash: hash, contract: 'router', name: 'Executed', args: { signer: request.intent.signer, merchant: request.intent.merchant, nonce: request.intent.nonce, target: request.intent.target, reimbursement: 0n, feeUSDT: request.intent.feeUSDT } });
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
  async gasTank(merchant: Address) { return this.tank.get(merchant.toLowerCase()) ?? (this.autoSettle ? { balanceWei: 10n ** 18n, dailyCapWei: 10n ** 18n, spentTodayWei: 0n } : { balanceWei: 0n, dailyCapWei: 0n, spentTodayWei: 0n }); }
  async prepareRenew(subscriptionId: Hex, amount: bigint, _nonce: number) {
    const raw = this.nextHash(), hash = keccak256(raw);
    this.pending.set(raw, () => { if (this.autoSettle) { this.emit({ id: `${hash}:renew`, txHash: hash, contract: 'subscription', name: 'Charged', args: { id: subscriptionId, amount, period: 1 } }); this.block += 2n; } });
    return { raw, hash };
  }
  async prepareSubscribe(mandate: Mandate, _signature: Hex, _nonce: number, consent?: MerchantConsent) {
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
  async subscribe(mandate: Mandate, signature: Hex, operation = this.writer.operation('subscribe', `${mandate.payer}:${mandate.nonce}`), consent?: MerchantConsent): Promise<Hex> {
    try { return await this.writer.run(() => this.writer.execute(operation, () => this.transactionCount(), nonce => this.prepareSubscribe(mandate, signature, nonce, consent), raw => this.broadcastTransaction(raw)), operation.id); }
    catch (error) { this.writer.notSent(operation.id); throw error; }
  }
  async cancelSigned(subscriptionId: Hex, _deadline: bigint, _signature: Hex, operation = this.writer.operation('cancel', subscriptionId)): Promise<Hex> {
    if (this.subscriptionVersion !== 2) throw new Error('Signed cancellation requires subscription V2');
    try { return await this.writer.run(() => this.writer.execute(operation, () => this.transactionCount(), async () => {
      const raw = this.nextHash(), hash = keccak256(raw);
      this.pending.set(raw, () => { if (this.autoSettle) { this.emit({ id: `${hash}:cancel`, txHash: hash, contract: 'subscription', name: 'Cancelled', args: { id: subscriptionId } }); this.block += 2n; } });
      return { raw, hash };
    }, raw => this.broadcastTransaction(raw)), operation.id); }
    catch (error) { this.writer.notSent(operation.id); throw error; }
  }
  async mandateNonce(payer: Address): Promise<bigint> { return this.mandateNonces.get(payer.toLowerCase()) ?? 0n; }
  emit(event: Omit<ChainEvent, 'block'>) {
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

export class ViemChain implements ChainAdapter {
  readonly writer: AccountWriter;
  readonly approval: ViemApprovalChain;
  private public;
  private account;
  private wallet;
  private blockTimes = new Map<bigint, string>();
  private feeRecipient?: Address;
  constructor(private rpcUrl: string, private privateKey: Hex, readonly addresses: Addresses, readonly subscriptionVersion: 1 | 2 = 1) {
    this.public = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }) });
    this.account = privateKeyToAccount(privateKey);
    this.writer = new AccountWriter(this.account.address);
    this.approval = new ViemApprovalChain(rpcUrl, this.account);
    this.wallet = createWalletClient({ chain, account: this.account, transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }) });
  }
  async chainId() { return this.public.getChainId(); }
  async latestBlock() { return this.public.getBlockNumber(); }
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
      if (event.contract === 'router' && event.name === 'Executed') {
        // This suite has no feeVault setter; read it from the configured Router.
        this.feeRecipient ??= await this.public.readContract({ address: this.addresses.router, abi: routerAbi, functionName: 'feeVault' }) as Address;
        event.feeRecipient = this.feeRecipient;
      }
    }
    return events;
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
      const contract = (Object.keys(this.addresses) as Array<keyof Addresses>).find(name => this.addresses[name]?.toLowerCase() === log.address.toLowerCase());
      if (!contract) continue;
      const abi = { router: routerAbi, escrow: escrowAbi, subscription: this.subscriptionVersion === 2 ? subscriptionV2Abi : subscriptionAbi, gasTank: gasTankAbi, receivables: receivablesAbi }[contract];
      try {
        const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
        events.push({ id: `${receipt.transactionHash}:${log.logIndex}`, block: receipt.blockNumber, txHash: receipt.transactionHash, contract, name: String(decoded.eventName), args: decoded.args as unknown as ChainEvent['args'] });
      } catch { /* Unknown suite logs are not settlement evidence. */ }
    }
    return { txHash: receipt.transactionHash, block: receipt.blockNumber, status: receipt.status, events: await this.enrichEvents(events) };
  }
  async events(from: bigint, to: bigint): Promise<ChainEvent[]> {
    const out: ChainEvent[] = [];
    for (const [contract, address, abi] of [
      ['escrow', this.addresses.escrow, escrowAbi], ['subscription', this.addresses.subscription, this.subscriptionVersion === 2 ? subscriptionV2Abi : subscriptionAbi],
      ['router', this.addresses.router, routerAbi], ['gasTank', this.addresses.gasTank, gasTankAbi],
      ...(this.addresses.receivables ? [['receivables', this.addresses.receivables, receivablesAbi] as const] : []),
    ] as const) {
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
      || request.maxFeePerGas > 100_000_000_000n || !Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Invalid x402 envelope');
    // Legacy gasPrice is exactly the authorized ceiling, as with prepareIntent. It cannot
    // exceed the gas * maxFeePerGas admission reservation and needs no fee-estimation RPC.
    const raw = await this.account.signTransaction({ type: 'legacy', chainId: 1874, to: request.to,
      data: request.data, value: 0n, gas: request.gas, nonce, gasPrice: request.maxFeePerGas });
    return { raw, hash: keccak256(raw) };
  }
  /** Signing only, for agent-account setup (deploy, owner-signed session changes): bounded gas, no value. */
  async prepareAgentTransaction(request: { to: Address; data: Hex; gas: bigint; maxFeePerGas: bigint }, nonce: number) {
    if (await this.chainId() !== 1874 || request.gas <= 0n || request.gas > 3_000_000n || request.maxFeePerGas <= 0n
      || request.maxFeePerGas > 100_000_000_000n || !Number.isSafeInteger(nonce) || nonce < 0) throw new Error('Invalid agent transaction');
    const raw = await this.account.signTransaction({ type: 'legacy', chainId: 1874, to: request.to, data: request.data, value: 0n, gas: request.gas, nonce, gasPrice: request.maxFeePerGas });
    return { raw, hash: keccak256(raw) };
  }
  async x402BlockNumber() { return this.public.getBlockNumber({ cacheTime: 0 }); }
  async x402Receipt(hash: Hex): Promise<X402Receipt | null> {
    try {
      const receipt = await this.public.getTransactionReceipt({ hash });
      return { txHash: receipt.transactionHash, block: receipt.blockNumber, status: receipt.status,
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
    const [token, rate, gas, price, minimum, payerCalls] = await Promise.all(['usdt', 'usdtPerWBT', 'maxGasPerCall', 'maxGasPrice', 'minAmount', 'maxPayerCallsPerDay'].map(read));
    if (String(token).toLowerCase() !== USDT.toLowerCase()) throw new Error('Unexpected Router token');
    return { blockNumber, usdtPerWbt: BigInt(String(rate)), maxGasPerCall: BigInt(String(gas)), maxGasPriceWei: BigInt(String(price)), minimumAmountMinor: BigInt(String(minimum)), maxPayerCallsPerDay: Number(payerCalls) };
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
  async gasTank(merchant: Address) {
    const [balanceWei, dailyCapWei, daily] = await Promise.all([
      this.public.readContract({ address: this.addresses.gasTank, abi: gasTankAbi, functionName: 'balanceOf', args: [merchant] }),
      this.public.readContract({ address: this.addresses.gasTank, abi: gasTankAbi, functionName: 'dailyCap', args: [merchant] }),
      this.public.readContract({ address: this.addresses.gasTank, abi: gasTankAbi, functionName: 'dailySpend', args: [merchant] }),
    ]);
    const d = daily as readonly [bigint, bigint];
    return { balanceWei: balanceWei as bigint, dailyCapWei: dailyCapWei as bigint, spentTodayWei: Number(d[0]) === Math.floor(Date.now() / 86_400_000) ? d[1] : 0n };
  }
  private async prepareSubscription(data: Hex, nonce: number) {
    if (await this.chainId() !== 1874) throw new Error('Wrong chain');
    const request = await this.wallet.prepareTransactionRequest({ type: 'eip1559', to: this.addresses.subscription, data, value: 0n, nonce });
    if (request.chainId !== 1874) throw new Error('Wrong chain');
    if (!request.gas || request.gas > 1_000_000n || !request.maxFeePerGas || request.maxFeePerGas > 100_000_000_000n) throw new Error('Subscription gas budget exceeded');
    const raw = await this.account.signTransaction({ type: 'eip1559', chainId: 1874, to: this.addresses.subscription, data, value: 0n, nonce, gas: request.gas, maxFeePerGas: request.maxFeePerGas, maxPriorityFeePerGas: request.maxPriorityFeePerGas });
    return { raw, hash: keccak256(raw) };
  }
  async prepareRenew(subscriptionId: Hex, amount: bigint, nonce: number) {
    return this.prepareSubscription(encodeFunctionData({ abi: subscriptionAbi, functionName: 'charge', args: [subscriptionId, amount] }), nonce);
  }
  async prepareSubscribe(mandate: Mandate, signature: Hex, nonce: number, consent?: MerchantConsent) {
    if (this.subscriptionVersion === 2 && !consent) throw new Error('Merchant consent required');
    return this.prepareSubscription(encodeFunctionData({ abi: this.subscriptionVersion === 2 ? subscriptionV2Abi : subscriptionAbi, functionName: 'subscribe', args: this.subscriptionVersion === 2 ? [mandate, signature, consent!.deadline, consent!.signature] : [mandate, signature] }), nonce);
  }
  async renew(subscriptionId: Hex, amount: bigint, operation = this.writer.operation('renew', subscriptionId)): Promise<Hex> {
    try { return await this.writer.run(() => this.writer.execute(operation, () => this.transactionCount(), nonce => this.budgetWrite(operation, () => this.prepareRenew(subscriptionId, amount, nonce)), raw => this.broadcastTransaction(raw)), operation.id); }
    catch (error) { this.writer.notSent(operation.id); throw error; }
  }
  async subscribe(mandate: Mandate, signature: Hex, operation = this.writer.operation('subscribe', `${mandate.payer}:${mandate.nonce}`), consent?: MerchantConsent): Promise<Hex> {
    try { return await this.writer.run(() => this.writer.execute(operation, () => this.transactionCount(), nonce => this.budgetWrite(operation, () => this.prepareSubscribe(mandate, signature, nonce, consent)), raw => this.broadcastTransaction(raw)), operation.id); }
    catch (error) { this.writer.notSent(operation.id); throw error; }
  }
  private async budgetWrite(operation: WriteOperation, prepare: () => Promise<{ raw: Hex; hash: Hex }>) {
    const prepared = await prepare();
    const transaction = parseTransaction(prepared.raw);
    this.writer.reserveSpend(operation.id, transaction.gas! * (transaction.maxFeePerGas ?? transaction.gasPrice!), 10_000_000_000_000_000n);
    return prepared;
  }
  async cancelSigned(subscriptionId: Hex, deadline: bigint, signature: Hex, operation = this.writer.operation('cancel', subscriptionId)): Promise<Hex> {
    if (this.subscriptionVersion !== 2) throw new Error('Signed cancellation requires subscription V2');
    try { return await this.writer.run(() => this.writer.execute(operation, () => this.transactionCount(), nonce => this.budgetWrite(operation, () => this.prepareSubscription(encodeFunctionData({ abi: subscriptionV2Abi, functionName: 'cancelWithSignature', args: [subscriptionId, deadline, signature] }), nonce)), raw => this.broadcastTransaction(raw)), operation.id); }
    catch (error) { this.writer.notSent(operation.id); throw error; }
  }
  async mandateNonce(payer: Address): Promise<bigint> { return this.public.readContract({ address: this.addresses.subscription, abi: subscriptionAbi, functionName: 'nonces', args: [payer] }) as Promise<bigint>; }
}
