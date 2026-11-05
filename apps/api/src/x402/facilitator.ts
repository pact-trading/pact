import { x402Facilitator } from '@x402/core/facilitator';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/facilitator';
import { UptoEvmScheme } from '@x402/evm/upto/facilitator';
import type { FacilitatorEvmSigner } from '@x402/evm';
import { AsyncLocalStorage } from 'node:async_hooks';
import { encodeFunctionData, isAddress, keccak256, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { fingerprint as digest } from './sqlite-store.js';
import { EXACT, NETWORK, PERMIT2, UPTO, USDT } from './constants.js';
import type { SettlementOperation, X402Journal } from './journal.js';

export interface X402Config {
  publicClient: PublicClient;
  journal: X402Journal;
  /** Audited runtime hashes, including immutables. Never learn these from the target RPC at startup. */
  runtimeHashes: Record<typeof PERMIT2 | typeof EXACT | typeof UPTO, Hex>;
  /** Authenticated, onboarded payees only. Root must also budget their gas in the journal. */
  merchants: readonly Address[];
  maxAmount: bigint;
  maxGas: bigint;
}
const norm = (s: string) => s.toLowerCase();
class PolicyError extends Error {}
const fail = (reason: string): never => { throw new PolicyError(reason); };

export class Permit2Facilitator {
  private readonly core: x402Facilitator;
  private readonly scope = new AsyncLocalStorage<SettlementOperation>();
  private ready = false;
  readonly counters = { verified: 0, refused: 0, settled: 0, failed: 0 };

  constructor(private readonly config: X402Config) {
    if (config.maxGas <= 0n || config.maxGas > 1_000_000n || config.maxAmount <= 0n || !config.merchants.length) fail('invalid_x402_policy');
    const pub = config.publicClient;
    const signer: FacilitatorEvmSigner = {
      getAddresses: () => [config.journal.settlementCaller ?? config.journal.address],
      readContract: args => pub.readContract({ ...args, account: config.journal.settlementCaller ?? config.journal.address } as never),
      verifyTypedData: args => pub.verifyTypedData(args as never),
      getCode: args => pub.getCode(args),
      waitForTransactionReceipt: async args => pub.waitForTransactionReceipt({ ...args, confirmations: 1, timeout: 60_000 }),
      sendTransaction: async () => fail('arbitrary_transactions_disabled'),
      writeContract: async args => {
        const op = this.scope.getStore() ?? fail('missing_journal_operation');
        if (![EXACT, UPTO].some(a => norm(a) === norm(args.address)) || args.functionName !== 'settle' || args.dataSuffix) fail('unsupported_x402_write');
        const data = encodeFunctionData(args as never);
        return config.journal.submit(op, { chainId: 1874, to: args.address, data, value: 0n, gas: config.maxGas });
      },
    };
    this.core = new x402Facilitator()
      .register(NETWORK, new ExactEvmScheme(signer, { simulateInSettle: true, pendingSettlementStore: config.journal.pending }))
      .register(NETWORK, new UptoEvmScheme(signer, { pendingSettlementStore: config.journal.pending }));
  }

  /** Fail closed until both official schemes and their shared Permit2 runtime are attested. */
  async initialize() {
    this.ready = false;
    const pub = this.config.publicClient;
    if (await pub.getChainId() !== 1874) fail('wrong_chain');
    for (const address of [PERMIT2, EXACT, UPTO] as const) {
      const code = await pub.getCode({ address });
      if (!code || code === '0x' || keccak256(code) !== this.config.runtimeHashes[address]) fail(`runtime_unavailable_or_mismatch:${address}`);
    }
    for (const address of [EXACT, UPTO]) {
      const actual = await pub.readContract({ address, abi: parseAbi(['function PERMIT2() view returns (address)']), functionName: 'PERMIT2' });
      if (norm(actual) !== norm(PERMIT2)) fail('wrong_permit2');
    }
    if (await pub.readContract({ address: USDT, abi: parseAbi(['function decimals() view returns (uint8)']), functionName: 'decimals' }) !== 6) fail('wrong_usdt_decimals');
    await this.config.journal.initialize?.(pub);
    this.ready = true;
  }
  getSupported() { return this.ready ? this.core.getSupported() : { kinds: [], extensions: [], signers: {} }; }
  health() { return { ready: this.ready, network: NETWORK }; }

  private validate(payload: PaymentPayload, req: PaymentRequirements): SettlementOperation {
    if (!this.ready) fail('x402_not_activated');
    if (payload.x402Version !== 2 || req.network !== NETWORK || payload.accepted?.network !== NETWORK) fail('unsupported_network_or_version');
    if (!['exact', 'upto'].includes(req.scheme) || payload.accepted.scheme !== req.scheme || req.extra?.assetTransferMethod !== 'permit2') fail('permit2_required');
    if (!isAddress(req.asset) || norm(req.asset) !== norm(USDT) || !isAddress(req.payTo) || !this.config.merchants.some(a => norm(a) === norm(req.payTo))) fail('asset_or_merchant_not_allowed');
    if (!/^\d{1,78}$/.test(req.amount) || BigInt(req.amount) <= 0n || BigInt(req.amount) > this.config.maxAmount) fail('amount_cap');
    if (!Number.isInteger(req.maxTimeoutSeconds) || req.maxTimeoutSeconds <= 0 || req.maxTimeoutSeconds > 300) fail('timeout_cap');
    if (payload.extensions && Object.keys(payload.extensions).length) fail('extensions_not_enabled');
    const raw = payload.payload as { signature?: string; permit2Authorization?: { from: Address; nonce: string; deadline: string; permitted: { amount: string }; witness: { facilitator?: string } } };
    const auth = raw.permit2Authorization ?? fail('malformed_permit2_payload');
    if (!auth || !isAddress(auth.from) || !/^\d{1,78}$/.test(auth.nonce) || !/^\d{1,78}$/.test(auth.permitted?.amount) || !/^\d{1,78}$/.test(auth.deadline) || !/^0x[0-9a-fA-F]{130}$/.test(raw.signature ?? '')) fail('malformed_permit2_payload');
    if (BigInt(auth.permitted.amount) > this.config.maxAmount || BigInt(auth.deadline) > BigInt(Math.floor(Date.now() / 1000) + 300)) fail('authorization_cap');
    if (req.scheme === 'upto' && norm(auth.witness.facilitator ?? '') !== norm(this.config.journal.settlementCaller ?? this.config.journal.address)) fail('wrong_facilitator');
    return { id: `${NETWORK}:permit2:${norm(auth.from)}:${BigInt(auth.nonce)}`, fingerprint: digest({ payload, req }), merchant: req.payTo as Address, payer: auth.from, amount: BigInt(req.amount) };
  }
  async verify(payload: PaymentPayload, req: PaymentRequirements) {
    try {
      this.validate(payload, req);
      const result = await this.core.verify(payload, req);
      this.counters[result.isValid ? 'verified' : 'refused']++;
      return result;
    } catch (e) { this.counters.refused++; return { isValid: false, invalidReason: e instanceof PolicyError ? e.message : 'x402_verification_failed' }; }
  }
  async settle(payload: PaymentPayload, req: PaymentRequirements): Promise<SettleResponse> {
    try {
      const op = this.validate(payload, req);
      return await this.config.journal.runOnce(op, () => this.scope.run(op, async () => {
        const result = await this.core.settle(payload, req);
        this.counters[result.success ? 'settled' : 'failed']++;
        return result;
      }));
    } catch (e) { this.counters.failed++; return { success: false, network: NETWORK, transaction: '', errorReason: e instanceof PolicyError ? e.message : 'x402_settlement_failed' }; }
  }
}
