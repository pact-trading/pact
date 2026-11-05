import { createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, erc20Abi, http, keccak256, parseAbi, TransactionReceiptNotFoundError, type Address, type Hex, type LocalAccount, type SignedAuthorization } from 'viem';

export const approvalAbi = parseAbi([
  'function approvalNonce() view returns (uint256)',
  'function approveFor(address token,address spender,uint256 amount,uint256 deadline,bytes signature)',
  'event ApprovalSponsored(address indexed payer,address indexed token,address indexed spender,uint256 amount,uint256 nonce)',
]);
export interface ApprovalSnapshot {
  balance: bigint; allowance: bigint; code: Hex; runtime: Hex;
  approvalNonce: bigint; authorizationNonce: number;
}
export interface ApprovalCall {
  payer: Address; token: Address; spender: Address; amount: bigint;
  approvalNonce: bigint; deadline: bigint; signature: Hex; authorization?: SignedAuthorization;
}
export interface ApprovalReceipt {
  hash: Hex; block: bigint; status: 'success' | 'reverted';
  approvals: Array<{ payer: Address; token: Address; spender: Address; amount: bigint; nonce: bigint }>;
}
export interface ApprovalChain {
  snapshot(payer: Address, token: Address, spender: Address, delegate: Address): Promise<ApprovalSnapshot>;
  prepare(call: ApprovalCall, nonce: number, gas: bigint, price: bigint): Promise<{ raw: Hex; hash: Hex }>;
  broadcast(raw: Hex): Promise<Hex>;
  receipt(hash: Hex, payer: Address): Promise<ApprovalReceipt | null>;
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
  async snapshot(payer: Address, token: Address, spender: Address, delegate: Address): Promise<ApprovalSnapshot> {
    // Never a cached block number: with 1-second blocks a cached one can predate the approval,
    // so the payer's nonce at it would not match the pending nonce.
    const blockNumber = await this.public.getBlockNumber({ cacheTime: 0 });
    const [balance, allowance, code, runtime, storage, latestNonce, pendingNonce] = await Promise.all([
      this.public.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [payer], blockNumber }),
      this.public.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [payer, spender], blockNumber }),
      this.public.getCode({ address: payer, blockNumber }), this.public.getCode({ address: delegate, blockNumber }),
      // SponsoredApprover approvalNonce is the sole storage field, slot 0.
      // Read storage even for no-code EOAs; previous delegations may leave data.
      this.public.getStorageAt({ address: payer, slot: `0x${'0'.repeat(64)}`, blockNumber }),
      this.public.getTransactionCount({ address: payer, blockNumber }),
      this.public.getTransactionCount({ address: payer, blockTag: 'pending' }),
    ]);
    if (!storage || !/^0x[0-9a-f]{64}$/i.test(storage)) throw new Error('approval_nonce_unavailable');
    if (!Number.isSafeInteger(pendingNonce) || pendingNonce < 0 || latestNonce !== pendingNonce) throw new Error('authorization_nonce_unavailable');
    return { balance, allowance, code: code ?? '0x', runtime: runtime ?? '0x', approvalNonce: BigInt(storage), authorizationNonce: pendingNonce };
  }
  async prepare(call: ApprovalCall, nonce: number, gas: bigint, price: bigint) {
    const data = encodeFunctionData({ abi: approvalAbi, functionName: 'approveFor', args: [call.token, call.spender, call.amount, call.deadline, call.signature] });
    // All transaction fields explicit. No estimate, fee bump, or implicit nonce.
    const tx = { chainId: 1874, nonce, to: call.payer, value: 0n, data, gas, maxFeePerGas: price, maxPriorityFeePerGas: price };
    const raw = call.authorization
      ? await this.account.signTransaction({ ...tx, type: 'eip7702', authorizationList: [call.authorization] })
      : await this.account.signTransaction({ ...tx, type: 'eip1559' });
    return { raw, hash: keccak256(raw) };
  }
  async broadcast(raw: Hex) { return this.wallet.sendRawTransaction({ serializedTransaction: raw }); }
  async receipt(hash: Hex, payer: Address): Promise<ApprovalReceipt | null> {
    let receipt;
    try { receipt = await this.public.getTransactionReceipt({ hash }); }
    catch (error) { if (error instanceof TransactionReceiptNotFoundError) return null; throw error; }
    const approvals: ApprovalReceipt['approvals'] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== payer.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: approvalAbi, data: log.data, topics: log.topics, strict: true });
        if (decoded.eventName === 'ApprovalSponsored') approvals.push(decoded.args);
      } catch { /* A different emitter/event cannot establish approval success. */ }
    }
    return { hash: receipt.transactionHash, block: receipt.blockNumber, status: receipt.status, approvals };
  }
}

export class FakeApprovalChain implements ApprovalChain {
  state: ApprovalSnapshot = { balance: 10_000_000n, allowance: 0n, code: '0x', runtime: '0x60006000', approvalNonce: 0n, authorizationNonce: 0 };
  receipts = new Map<string, ApprovalReceipt | null | Error>();
  prepared: Array<{ call: ApprovalCall; nonce: number; gas: bigint; price: bigint; hash: Hex }> = [];
  broadcasts: Hex[] = [];
  constructor(private nextHash: () => Hex, private onBroadcast = () => {}) {}
  async snapshot(): Promise<ApprovalSnapshot> { return { ...this.state }; }
  async prepare(call: ApprovalCall, nonce: number, gas: bigint, price: bigint) {
    const raw = this.nextHash(), hash = keccak256(raw); this.prepared.push({ call, nonce, gas, price, hash }); return { raw, hash };
  }
  async broadcast(raw: Hex) { this.broadcasts.push(raw); this.onBroadcast(); return keccak256(raw); }
  async receipt(hash: Hex): Promise<ApprovalReceipt | null> {
    const r = this.receipts.get(hash); if (r instanceof Error) throw r; return r ?? null;
  }
}
