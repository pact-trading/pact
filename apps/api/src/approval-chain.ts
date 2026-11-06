import { createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, erc20Abi, http, keccak256, parseAbi, parseSignature, TransactionReceiptNotFoundError, type Address, type Hex, type LocalAccount } from 'viem';
import { USDT } from './token.js';

/** Whitechain USDT's EIP-2612 surface. */
export const permitAbi = parseAbi([
  'function nonces(address owner) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)',
]);
export interface ApprovalSnapshot { balance: bigint; allowance: bigint; nonce: bigint }
/** A permit the owner signed, for Pact's relayer to submit. */
export interface ApprovalCall { owner: Address; spender: Address; value: bigint; deadline: bigint; signature: Hex }
/** What a mined transaction cost its sender, when the receipt reports gas used and the effective price. */
export const gasCost = (receipt: { gasUsed?: bigint; effectiveGasPrice?: bigint }): { gasCostWei?: bigint } =>
  typeof receipt.gasUsed === 'bigint' && typeof receipt.effectiveGasPrice === 'bigint' ? { gasCostWei: receipt.gasUsed * receipt.effectiveGasPrice } : {};
export interface ApprovalReceipt {
  hash: Hex; block: bigint; status: 'success' | 'reverted';
  approvals: Array<{ owner: Address; spender: Address; value: bigint }>;
  /** What the permit transaction cost Pact's relayer, in WBT wei. */
  gasCostWei?: bigint;
}
/** USDT allowances: read them, and submit a signed permit from the relayer, which pays the gas. */
export interface ApprovalChain {
  snapshot(owner: Address, spender: Address): Promise<ApprovalSnapshot>;
  prepare(call: ApprovalCall, nonce: number, gas: bigint, price: bigint): Promise<{ raw: Hex; hash: Hex }>;
  broadcast(raw: Hex): Promise<Hex>;
  receipt(hash: Hex, owner: Address): Promise<ApprovalReceipt | null>;
}
export function permitCalldata(call: ApprovalCall): Hex {
  const { r, s, v, yParity } = parseSignature(call.signature);
  return encodeFunctionData({ abi: permitAbi, functionName: 'permit', args: [call.owner, call.spender, call.value, call.deadline, Number(v ?? 27n + BigInt(yParity)), r, s] });
}
const network = defineChain({ id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: ['https://rpc.testnet.whitechain.io'] } }, testnet: true });
export class ViemApprovalChain implements ApprovalChain {
  private public;
  private wallet;
  constructor(rpc: string, private account: LocalAccount) {
    // Broadcast retries are disabled, including transport retries.
    this.public = createPublicClient({ chain: network, transport: http(rpc, { retryCount: 0, timeout: 10_000 }) });
    this.wallet = createWalletClient({ chain: network, account, transport: http(rpc, { retryCount: 0, timeout: 10_000 }) });
  }
  async snapshot(owner: Address, spender: Address): Promise<ApprovalSnapshot> {
    // Never a cached block number: with 1-second blocks a cached one can predate the permit.
    const blockNumber = await this.public.getBlockNumber({ cacheTime: 0 });
    const [balance, allowance, nonce] = await Promise.all([
      this.public.readContract({ address: USDT, abi: erc20Abi, functionName: 'balanceOf', args: [owner], blockNumber }),
      this.public.readContract({ address: USDT, abi: erc20Abi, functionName: 'allowance', args: [owner, spender], blockNumber }),
      this.public.readContract({ address: USDT, abi: permitAbi, functionName: 'nonces', args: [owner], blockNumber }),
    ]);
    return { balance, allowance, nonce };
  }
  async prepare(call: ApprovalCall, nonce: number, gas: bigint, price: bigint) {
    // All transaction fields explicit. No estimate, fee bump, or implicit nonce.
    const raw = await this.account.signTransaction({ type: 'legacy', chainId: 1874, nonce, to: USDT, value: 0n, data: permitCalldata(call), gas, gasPrice: price });
    return { raw, hash: keccak256(raw) };
  }
  async broadcast(raw: Hex) { return this.wallet.sendRawTransaction({ serializedTransaction: raw }); }
  async receipt(hash: Hex, owner: Address): Promise<ApprovalReceipt | null> {
    let receipt;
    try { receipt = await this.public.getTransactionReceipt({ hash }); }
    catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; }
    const approvals: ApprovalReceipt['approvals'] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDT.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: permitAbi, data: log.data, topics: log.topics, strict: true });
        if (decoded.eventName === 'Approval' && decoded.args.owner.toLowerCase() === owner.toLowerCase()) approvals.push(decoded.args);
      } catch { /* A different event cannot establish an approval. */ }
    }
    return { hash: receipt.transactionHash, block: receipt.blockNumber, status: receipt.status, approvals, ...gasCost(receipt) };
  }
}

export class FakeApprovalChain implements ApprovalChain {
  state: ApprovalSnapshot = { balance: 10_000_000n, allowance: 0n, nonce: 0n };
  /** Per-spender allowances; `state.allowance` applies to any spender not listed. */
  allowances = new Map<string, bigint>();
  receipts = new Map<string, ApprovalReceipt | null | Error>();
  prepared: Array<{ call: ApprovalCall; nonce: number; gas: bigint; price: bigint; hash: Hex }> = [];
  broadcasts: Hex[] = [];
  constructor(private nextHash: () => Hex, private onBroadcast = () => {}) {}
  async snapshot(_owner: Address, spender: Address): Promise<ApprovalSnapshot> {
    return { ...this.state, allowance: this.allowances.get(spender.toLowerCase()) ?? this.state.allowance };
  }
  async prepare(call: ApprovalCall, nonce: number, gas: bigint, price: bigint) {
    const raw = this.nextHash(), hash = keccak256(raw); this.prepared.push({ call, nonce, gas, price, hash }); return { raw, hash };
  }
  async broadcast(raw: Hex) { this.broadcasts.push(raw); this.onBroadcast(); return keccak256(raw); }
  async receipt(hash: Hex): Promise<ApprovalReceipt | null> {
    const r = this.receipts.get(hash); if (r instanceof Error) throw r; return r ?? null;
  }
}
