import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BaseError, createPublicClient, decodeErrorResult, decodeEventLog, defineChain, encodeFunctionData, erc20Abi, hashDomain, http,
  parseAbi, TransactionReceiptNotFoundError, type Abi, type Address, type Hex,
} from 'viem';
import { USDT } from '../token.js';
import type { ViemChain } from '../chain.js';
import { Refusal } from '../types.js';
import { gasCost } from '../approval-chain.js';

const artifact = (name: string): Abi => JSON.parse(readFileSync(process.env.CONTRACT_ARTIFACTS_DIR ? join(process.env.CONTRACT_ARTIFACTS_DIR, `${name}.sol`, `${name}.json`) : new URL(`../../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), 'utf8')).abi as Abi;
export const receivablesAbi = artifact('InvoiceReceivables');
export const registryAbi = artifact('InvestorRegistry');

export interface FinancingAddresses { receivables: Address; registry: Address }
export type ClaimStatus = 'none' | 'listed' | 'funded' | 'defaulted' | 'repaid' | 'bought_back' | 'cancelled' | 'withdrawn';
export const CLAIM_STATUSES: ClaimStatus[] = ['none', 'listed', 'funded', 'defaulted', 'repaid', 'bought_back', 'cancelled', 'withdrawn'];
/** HolderPaid sources, in the contract's enum order. */
export const PAYMENT_SOURCES = ['customer', 'reserve', 'buy_back'] as const;

export interface FinancingEvent {
  /** `${txHash}:${logIndex}` */
  id: string;
  block: bigint;
  txHash: Hex;
  contract: 'receivables' | 'registry';
  name: string;
  args: Record<string, unknown>;
  /** Block time, unix seconds. */
  at: number;
}
export interface FinancingReceipt { txHash: Hex; block: bigint; status: 'success' | 'reverted'; from: Address; to: Address | null; events: FinancingEvent[] }
export interface ChainClaim {
  merchant: Address; maturity: bigint; status: ClaimStatus; face: bigint; sold: bigint; collected: bigint; reserve: bigint;
}

/** Reads and keeper writes for the receivables contract and the investor registry. */
export interface FinancingChain {
  readonly addresses: FinancingAddresses;
  latestBlock(): Promise<bigint>;
  /** Latest block time, unix seconds: the clock the contracts enforce (a local fork can run ahead). */
  now(): Promise<number>;
  events(from: bigint, to: bigint): Promise<FinancingEvent[]>;
  receipt(hash: Hex): Promise<FinancingReceipt | null>;
  claim(claimId: bigint): Promise<ChainClaim>;
  owed(claimId: bigint): Promise<bigint>;
  /** The open claim for a merchant's invoice reference, or 0. */
  activeClaimId(merchant: Address, invoiceRef: Hex): Promise<bigint>;
  /** The claim an acknowledgement already backs, or 0: one acknowledged debt backs one claim. */
  acknowledgementClaim(ackHash: Hex): Promise<bigint>;
  /** Whether a merchant's invoice already backed a claim that sold or was paid: it cannot be listed again. */
  invoicePledged(merchant: Address, invoiceRef: Hex): Promise<boolean>;
  /** How many registry decisions were made about an investor: a signed decision names it. */
  decisionVersion(investor: Address): Promise<bigint>;
  isApproved(investor: Address): Promise<boolean>;
  isOfficer(account: Address): Promise<boolean>;
  usdtBalance(account: Address): Promise<bigint>;
  allowance(owner: Address, spender: Address): Promise<bigint>;
  /** USDT the receivables contract could not deliver to an account, waiting for it to withdraw. */
  claimable(account: Address): Promise<bigint>;
  /** Signed-order nonces: an investor's on the receivables contract, an officer's on the registry. */
  nonce(contract: 'receivables' | 'registry', account: Address): Promise<bigint>;
  /** The EIP-2612 permit domain and nonce of the USDT the contract settles in. */
  permit(owner: Address): Promise<{ domain: { name: string; version: string; chainId: number; verifyingContract: Address }; nonce: bigint }>;
  /** Keeper calls anyone may make: close a listing at its record date, mark a default after grace. */
  keeper(functionName: 'closeListing' | 'markDefault', claimId: bigint): Promise<Hex>;
  /**
   * Sends a signed order (purchase, transfer, listing, registry decision, USDT permit) from Pact's
   * relayer, which pays the gas. The call is simulated first: a revert is returned as its error name
   * and nothing is sent.
   */
  relay(contract: 'receivables' | 'registry' | 'usdt', data: Hex, gas: bigint): Promise<Hex>;
}

const chain = (rpcUrl: string) => defineChain({ id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class ViemFinancingChain implements FinancingChain {
  private public;
  private times = new Map<bigint, number>();
  constructor(rpcUrl: string, readonly addresses: FinancingAddresses, private writerChain: ViemChain) {
    this.public = createPublicClient({ chain: chain(rpcUrl), transport: http(rpcUrl, { retryCount: 0, timeout: 10_000 }) });
  }
  latestBlock() { return this.public.getBlockNumber({ cacheTime: 0 }); }
  async now() {
    const block = await this.public.getBlock({ blockTag: 'latest' });
    return Number(block.timestamp);
  }
  private async time(block: bigint) {
    let at = this.times.get(block);
    if (at === undefined) {
      at = Number((await this.public.getBlock({ blockNumber: block })).timestamp);
      if (this.times.size >= 512) this.times.delete(this.times.keys().next().value!);
      this.times.set(block, at);
    }
    return at;
  }
  private decode(log: { address: Address; data: Hex; topics: readonly Hex[]; transactionHash: Hex | null; logIndex: number | null; blockNumber: bigint | null }): Omit<FinancingEvent, 'at'> | null {
    const contract = same(log.address, this.addresses.receivables) ? 'receivables' : same(log.address, this.addresses.registry) ? 'registry' : null;
    if (!contract) return null;
    try {
      const decoded = decodeEventLog({ abi: contract === 'receivables' ? receivablesAbi : registryAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      return { id: `${log.transactionHash}:${log.logIndex}`, block: log.blockNumber!, txHash: log.transactionHash!, contract, name: String(decoded.eventName), args: decoded.args as unknown as Record<string, unknown> };
    } catch { return null; }
  }
  async events(from: bigint, to: bigint) {
    const logs = await this.public.getLogs({ address: [this.addresses.receivables, this.addresses.registry], fromBlock: from, toBlock: to });
    const out: FinancingEvent[] = [];
    for (const log of logs) {
      const event = this.decode(log);
      if (event) out.push({ ...event, at: await this.time(event.block) });
    }
    return out.sort((a, b) => a.block === b.block ? (Number(a.id.split(':')[1]) - Number(b.id.split(':')[1])) : a.block < b.block ? -1 : 1);
  }
  async receipt(hash: Hex): Promise<FinancingReceipt | null> {
    let receipt;
    try { receipt = await this.public.getTransactionReceipt({ hash }); }
    catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; }
    const at = await this.time(receipt.blockNumber);
    const events = receipt.logs.map(log => this.decode(log)).filter((e): e is Omit<FinancingEvent, 'at'> => e !== null).map(e => ({ ...e, at }));
    return { txHash: receipt.transactionHash, block: receipt.blockNumber, status: receipt.status, from: receipt.from, to: receipt.to, events };
  }
  async claim(claimId: bigint): Promise<ChainClaim> {
    const c = await this.public.readContract({ address: this.addresses.receivables, abi: receivablesAbi, functionName: 'claims', args: [claimId] }) as readonly unknown[];
    return { merchant: c[0] as Address, maturity: BigInt(c[1] as bigint), status: CLAIM_STATUSES[Number(c[4])], face: c[6] as bigint, sold: c[7] as bigint, collected: c[8] as bigint, reserve: c[9] as bigint };
  }
  async owed(claimId: bigint) { return await this.public.readContract({ address: this.addresses.receivables, abi: receivablesAbi, functionName: 'owed', args: [claimId] }) as bigint; }
  async activeClaimId(merchant: Address, invoiceRef: Hex) { return await this.public.readContract({ address: this.addresses.receivables, abi: receivablesAbi, functionName: 'activeClaim', args: [merchant, invoiceRef] }) as bigint; }
  async acknowledgementClaim(ackHash: Hex) { return await this.public.readContract({ address: this.addresses.receivables, abi: receivablesAbi, functionName: 'acknowledgementClaim', args: [ackHash] }) as bigint; }
  async invoicePledged(merchant: Address, invoiceRef: Hex) { return await this.public.readContract({ address: this.addresses.receivables, abi: receivablesAbi, functionName: 'invoicePledged', args: [merchant, invoiceRef] }) as boolean; }
  async decisionVersion(investor: Address) { return await this.public.readContract({ address: this.addresses.registry, abi: registryAbi, functionName: 'decisions', args: [investor] }) as bigint; }
  async isApproved(investor: Address) { return await this.public.readContract({ address: this.addresses.registry, abi: registryAbi, functionName: 'isApproved', args: [investor] }) as boolean; }
  async isOfficer(account: Address) { return await this.public.readContract({ address: this.addresses.registry, abi: registryAbi, functionName: 'officers', args: [account] }) as boolean; }
  async usdtBalance(account: Address) { return await this.public.readContract({ address: USDT, abi: erc20Abi, functionName: 'balanceOf', args: [account] }); }
  async allowance(owner: Address, spender: Address) { return await this.public.readContract({ address: USDT, abi: erc20Abi, functionName: 'allowance', args: [owner, spender] }); }
  async claimable(account: Address) { return await this.public.readContract({ address: this.addresses.receivables, abi: receivablesAbi, functionName: 'claimable', args: [account] }) as bigint; }
  async nonce(contract: 'receivables' | 'registry', account: Address) {
    return await this.public.readContract({ address: this.addresses[contract], abi: contract === 'receivables' ? receivablesAbi : registryAbi, functionName: 'nonces', args: [account] }) as bigint;
  }
  async permit(owner: Address) {
    const [name, separator, nonce] = await Promise.all([
      this.public.readContract({ address: USDT, abi: permitAbi, functionName: 'name' }),
      this.public.readContract({ address: USDT, abi: permitAbi, functionName: 'DOMAIN_SEPARATOR' }),
      this.public.readContract({ address: USDT, abi: permitAbi, functionName: 'nonces', args: [owner] }),
    ]);
    const domain = { name, version: '1', chainId: 1874, verifyingContract: USDT };
    // The token's own separator must match the domain we ask investors to sign.
    if (hashDomain({ domain: { ...domain, chainId: 1874n }, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] } }) !== separator)
      throw new Refusal('permit_unavailable');
    return { domain, nonce };
  }
  async keeper(functionName: 'closeListing' | 'markDefault', claimId: bigint): Promise<Hex> {
    const data = encodeFunctionData({ abi: receivablesAbi, functionName, args: [claimId] });
    const hash = await this.send(this.addresses.receivables, data, functionName === 'markDefault' ? 900_000n : 150_000n, `${functionName}:${claimId}`);
    return hash;
  }
  async relay(contract: 'receivables' | 'registry' | 'usdt', data: Hex, gas: bigint): Promise<Hex> {
    const to = contract === 'usdt' ? USDT : this.addresses[contract];
    try { await this.public.call({ account: this.writerChain.writer.relayer, to, data, gas }); }
    catch (error) {
      // Refuse before sending: a revert would cost Pact gas and tell the user nothing.
      const name = revertName(error, contract === 'registry' ? registryAbi : receivablesAbi);
      throw new Refusal('relay_refused', name ?? 'reverted');
    }
    return this.send(to, data, gas, `relay:${contract}`);
  }
  private async send(to: Address, data: Hex, gas: bigint, objectId: string): Promise<Hex> {
    const writer = this.writerChain.writer;
    const price = await this.writerChain.gasPrice();
    if (price > 100_000_000_000n) throw new Refusal('gas_price');
    const operation = writer.operation('financing', objectId);
    const hash = await writer.run(() => writer.execute(operation, () => this.writerChain.transactionCount(), async nonce => {
      const prepared = await this.writerChain.prepareAgentTransaction({ to, data, gas, maxFeePerGas: price }, nonce);
      writer.reserveSpend(operation.id, gas * price, 100_000_000_000_000_000n);
      return prepared;
    }, raw => this.writerChain.broadcastTransaction(raw)), operation.id).catch(error => { writer.notSent(operation.id); throw error; });
    const receipt = await this.public.waitForTransactionReceipt({ hash, timeout: 60_000 });
    writer.resolve(hash, receipt.blockNumber, receipt.status, gasCost(receipt).gasCostWei);
    if (receipt.status !== 'success') throw new Refusal('financing_transaction_failed');
    return hash;
  }
}

const permitAbi = parseAbi(['function name() view returns (string)', 'function DOMAIN_SEPARATOR() view returns (bytes32)', 'function nonces(address) view returns (uint256)']);

/** The custom error a simulated call reverted with, by name, when the ABI knows it. */
function revertName(error: unknown, abi: Abi): string | null {
  let data: Hex | undefined;
  if (error instanceof BaseError) {
    const found = error.walk(e => typeof (e as { data?: unknown }).data === 'string' && String((e as { data: string }).data).startsWith('0x'));
    data = (found as { data?: Hex } | null)?.data;
  }
  if (!data || data === '0x') return null;
  try { return decodeErrorResult({ abi, data }).errorName; } catch { return null; }
}
