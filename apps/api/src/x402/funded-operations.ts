import { decodeEventLog, encodeFunctionData, isAddress, isHash, keccak256, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import type { Db } from '../db.js';
import type { IntentRequest } from '../types.js';
import type { SettlementOperation } from './journal.js';
import { bindSettlement, same, validateEnvelope } from './call-binding.js';
import { canonicalJson, fingerprint } from './sqlite-store.js';
import { authorizeGatewayPayment, fundedReceipt, gatewayPayment, type ExactMerchantIntentAuthorizer, type GatewayPayment, type MerchantIntentTerms } from './funded-gateway.js';
import type { X402Receipt, X402Transaction, X402WritePorts } from './write-ports.js';
import { USDT } from './constants.js';

export const fundedRouterAbi = parseAbi(['function execute((address signer,address merchant,address target,bytes32 dataHash,uint256 amount,uint256 feeUSDT,uint256 nonce,uint64 deadline,uint32 maxGas) i,bytes data,bytes signature) returns (bool,bytes)']);
export interface FundedRoute {
  router: Address; gasTank: Address; feeVault: Address; factory: Address; gateway: Address;
  /** Independently pinned deployed runtime hashes, never learned during initialization. */
  runtimeHashes: Readonly<Record<string, Hex>>;
}
export interface MerchantIntentTermsSource {
  /** Root must durably allocate the merchant Router nonce across keeper and every caller.
   * This is a required port, NOT an in-memory nonce allocator or app-secret permission. */
  reserve(operationId: string, payment: GatewayPayment, route: Readonly<FundedRoute>): Promise<MerchantIntentTerms>;
}
export interface FundedConfiguration {
  route: FundedRoute; outerGas: bigint; maxTargetGas: number; maxFeeUSDT: bigint;
  terms: MerchantIntentTermsSource; authorizer: ExactMerchantIntentAuthorizer;
}
interface FundedRow {
  router: string | null; merchant: string | null; merchant_nonce: string | null; terms_json: string | null;
  operation_key: string; draft_json: string; draft_hash: Hex; state: string;
  authorization_json: string | null; authorization_hash: Hex | null;
  envelope_json: string | null; envelope_hash: Hex | null;
}
export interface FundedBinding { payment: GatewayPayment; request: IntentRequest; transaction: X402Transaction; route: FundedRoute }
export class FundedOperations {
  readonly route?: Readonly<FundedRoute>;
  readonly routeFingerprint?: Hex;
  private readonly settings?: Omit<FundedConfiguration, 'terms' | 'authorizer'>;
  private readonly reserveTerms?: MerchantIntentTermsSource['reserve'];
  private readonly authorizer?: ExactMerchantIntentAuthorizer;
  constructor(private readonly db: Db, config: FundedConfiguration | undefined, private readonly now: () => number) {
    if (config) {
      const route = Object.freeze({ ...config.route, runtimeHashes: Object.freeze({ ...config.route.runtimeHashes }) });
      for (const address of [route.router, route.gasTank, route.feeVault, route.factory, route.gateway]) if (!isAddress(address) || BigInt(address) === 0n) throw new Error('invalid_funded_route');
      for (const address of [route.router, route.gasTank, route.factory, route.gateway, USDT]) if (!isHash(route.runtimeHashes[address.toLowerCase()])) throw new Error('funded_runtime_hash_required');
      if (config.outerGas <= 0n || config.outerGas > 1_000_000n || !Number.isSafeInteger(config.maxTargetGas) || config.maxTargetGas <= 0 || config.maxTargetGas > 1_000_000 || config.maxFeeUSDT <= 0n || !config.terms?.reserve || !config.authorizer?.signExactIntent) throw new Error('invalid_funded_config');
      this.route = route;
      this.settings = Object.freeze({ route, outerGas: config.outerGas, maxTargetGas: config.maxTargetGas, maxFeeUSDT: config.maxFeeUSDT });
      this.routeFingerprint = fingerprint(this.settings);
      this.reserveTerms = config.terms.reserve.bind(config.terms);
      this.authorizer = { signExactIntent: config.authorizer.signExactIntent.bind(config.authorizer) };
    }
  }
  row(key: string) { return this.db.prepare('SELECT * FROM x402_funded_operations WHERE operation_key=?').get(key) as FundedRow | undefined; }
  held(key: string) { const row = this.row(key); return !!row && row.state !== 'authorized'; }
  async initialize(pub: PublicClient) {
    if (!this.route || await pub.getChainId() !== 1874) throw new Error('funded_not_configured');
    const r = this.route;
    for (const address of [r.router, r.gasTank, r.factory, r.gateway, USDT]) {
      const code = await pub.getCode({ address });
      if (!code || keccak256(code) !== r.runtimeHashes[address.toLowerCase()]) throw new Error('funded_runtime_mismatch');
    }
    const readAddress = (address: Address, name: string) => pub.readContract({ address, abi: parseAbi([`function ${name}() view returns (address)`]), functionName: name }) as Promise<Address>;
    for (const [address, name, expected] of [[r.gateway, 'router', r.router], [r.gateway, 'factory', r.factory], [r.router, 'usdt', USDT], [r.router, 'gasTank', r.gasTank], [r.router, 'feeVault', r.feeVault], [r.gasTank, 'router', r.router]] as const) {
      if (!same(await readAddress(address, name), expected)) throw new Error('funded_route_mismatch');
    }
  }
  /** Called only inside the existing AccountWriter queue and coordinator's tracked send scope. */
  async authorize(key: string, op: SettlementOperation, proxy: X402Transaction): Promise<FundedBinding> {
    if (!this.settings || !this.reserveTerms || !this.authorizer) throw new Error('funded_not_configured');
    bindSettlement(op, proxy, this.settings.route.gateway);
    const payment = gatewayPayment(proxy.to, proxy.data, this.settings.route.gateway);
    const draft = canonicalJson({ settings: this.settings, payment });
    const old = this.row(key);
    if (old) {
      if (old.draft_json !== draft) throw new Error('funded_draft_conflict');
      if (old.state !== 'authorized') throw new Error('merchant_authorization_pending');
      return this.binding(key);
    }
    // Persist BEFORE any external terms/authorization request. If its response is lost, no new
    // nonce/signature is automatically requested. Public operator/provider recovery remains needed.
    this.db.prepare("INSERT INTO x402_funded_operations(operation_key,draft_json,draft_hash,state) VALUES (?,?,?,'authorizing')").run(key, draft, fingerprint(JSON.parse(draft)));
    try {
      const supplied = await this.reserveTerms(key, payment, this.settings.route);
      const terms = Object.freeze({ nonce: supplied.nonce, deadline: supplied.deadline, feeUSDT: supplied.feeUSDT, maxGas: supplied.maxGas });
      const nowSeconds = BigInt(Math.floor(this.now() / 1000));
      if (terms.feeUSDT > this.settings.maxFeeUSDT || terms.maxGas > this.settings.maxTargetGas || terms.deadline < nowSeconds || terms.deadline > nowSeconds + 300n) throw new Error('merchant_terms_exceed_policy');
      this.db.prepare('UPDATE x402_funded_operations SET router=?,merchant=?,merchant_nonce=?,terms_json=? WHERE operation_key=?')
        .run(this.settings.route.router.toLowerCase(), op.merchant.toLowerCase(), terms.nonce.toString(), canonicalJson(terms), key);
      const request = await authorizeGatewayPayment(payment, this.settings.route.router, terms, this.authorizer);
      const transaction: X402Transaction = { chainId: 1874, to: this.settings.route.router, value: 0n, gas: this.settings.outerGas,
        data: encodeFunctionData({ abi: fundedRouterAbi, functionName: 'execute', args: [request.intent, request.data, request.signature] }) };
      const binding = { payment, request, transaction, route: this.settings.route };
      this.db.prepare("UPDATE x402_funded_operations SET authorization_json=?,authorization_hash=?,state='authorized' WHERE operation_key=? AND state='authorizing'")
        .run(canonicalJson(binding), fingerprint(binding), key);
      return binding;
    } catch (error) {
      this.db.prepare("UPDATE x402_funded_operations SET state='authorization_unknown' WHERE operation_key=? AND state='authorizing'").run(key);
      throw error;
    }
  }
  async binding(key: string): Promise<FundedBinding> {
    const row = this.row(key);
    if (!row?.authorization_json || row.state !== 'authorized' || fingerprint(JSON.parse(row.authorization_json)) !== row.authorization_hash || fingerprint(JSON.parse(row.draft_json)) !== row.draft_hash) throw new Error('funded_authorization_corrupt');
    const stored = JSON.parse(row.authorization_json);
    const draft = JSON.parse(row.draft_json);
    const identity = this.db.prepare('SELECT identity_json,payer,merchant,permit_nonce,amount FROM x402_operations WHERE operation_key=?').get(key) as { identity_json: string; payer: Address; merchant: Address; permit_nonce: string; amount: string };
    if (JSON.parse(identity.identity_json).routeFingerprint !== fingerprint(draft.settings) || canonicalJson(stored.route) !== canonicalJson(draft.settings.route) || canonicalJson(stored.payment) !== canonicalJson(draft.payment)) throw new Error('funded_identity_conflict');
    const payment = gatewayPayment(stored.payment.proxy, stored.payment.proxyData, stored.route.gateway);
    if (!same(payment.payer, identity.payer) || !same(payment.merchant, identity.merchant) || payment.nonce.toString() !== identity.permit_nonce || payment.amount.toString() !== identity.amount || canonicalJson(payment) !== canonicalJson(stored.payment)) throw new Error('funded_identity_conflict');
    const i = stored.request.intent;
    const terms = { nonce: BigInt(i.nonce), deadline: BigInt(i.deadline), feeUSDT: BigInt(i.feeUSDT), maxGas: i.maxGas };
    if (row.router !== stored.route.router.toLowerCase() || row.merchant !== payment.merchant.toLowerCase() || row.merchant_nonce !== terms.nonce.toString() || canonicalJson(terms) !== row.terms_json) throw new Error('funded_terms_conflict');
    const request = await authorizeGatewayPayment(payment, stored.route.router, terms, { signExactIntent: async () => stored.request.signature });
    if (canonicalJson(request) !== canonicalJson(stored.request)) throw new Error('funded_signature_conflict');
    const transaction: X402Transaction = { chainId: 1874, to: stored.route.router, value: 0n, gas: BigInt(draft.settings.outerGas), data: encodeFunctionData({ abi: fundedRouterAbi, functionName: 'execute', args: [request.intent, request.data, request.signature] }) };
    validateEnvelope(transaction);
    if (canonicalJson(transaction) !== canonicalJson(stored.transaction)) throw new Error('funded_envelope_conflict');
    return { payment, request, transaction, route: stored.route };
  }
  async preflight(key: string, transaction: X402Transaction, maxFeePerGas: bigint, ports: X402WritePorts) {
    const binding = await this.binding(key);
    if (canonicalJson(binding.transaction) !== canonicalJson(transaction) || !ports.simulateFunded) throw new Error('funded_transport_required');
    await ports.simulateFunded(binding.request, { ...transaction, maxFeePerGas });
  }
  /** Called within the SAME SQLite transaction as AccountWriter reserve + shared gas budgets. */
  bindEnvelope(key: string, transaction: X402Transaction, maxFeePerGas: bigint) {
    const row = this.row(key)!;
    const json = canonicalJson({ ...transaction, maxFeePerGas, authorizationHash: row.authorization_hash });
    if (row.envelope_json && row.envelope_json !== json) throw new Error('funded_envelope_conflict');
    this.db.prepare('UPDATE x402_funded_operations SET envelope_json=?,envelope_hash=? WHERE operation_key=?').run(json, fingerprint(JSON.parse(json)), key);
  }
  async failure(key: string, receipt: X402Receipt): Promise<string | undefined> {
    try {
      const { payment, request, route } = await this.binding(key);
      // A genuine Router refusal has no committed payment, gateway, fee or tank events.
      if (receipt.logs.some(l => [payment.proxy, payment.gateway, USDT, route.gasTank].some(a => same(l.address, a)))) return;
      const abi = parseAbi(['event Refused(address indexed signer,address indexed merchant,uint256 indexed nonce,uint8 reason)']);
      const logs = receipt.logs.filter(l => same(l.address, route.router));
      if (logs.length !== 1) return;
      const event = decodeEventLog({ abi, topics: [...logs[0].topics] as [Hex, ...Hex[]], data: logs[0].data });
      if (same(event.args.signer, payment.merchant) && same(event.args.merchant, payment.merchant) && event.args.nonce === request.intent.nonce && event.args.reason <= 13) return `funded_router_refused:${event.args.reason}`;
    } catch { /* Ambiguous evidence remains reconciliation_required. */ }
  }
  async matches(key: string, receipt: X402Receipt, relayer: Address): Promise<boolean> {
    try {
      const binding = await this.binding(key), row = this.row(key)!;
      if (!row.envelope_json || fingerprint(JSON.parse(row.envelope_json)) !== row.envelope_hash) return false;
      const envelope = JSON.parse(row.envelope_json);
      const { authorizationHash: _hash, maxFeePerGas: _fee, ...unsigned } = envelope;
      if (canonicalJson(unsigned) !== canonicalJson(binding.transaction)) return false;
      if (envelope.authorizationHash !== row.authorization_hash || !receipt.effectiveGasPrice || receipt.gasUsed === undefined || receipt.gasUsed <= 0n
        || receipt.effectiveGasPrice !== BigInt(envelope.maxFeePerGas) || receipt.gasUsed > binding.transaction.gas) return false;
      const proof = fundedReceipt(receipt, binding.payment, binding.request, { ...binding.route, relayer }, receipt.effectiveGasPrice);
      const actualGasCostWei = receipt.gasUsed * receipt.effectiveGasPrice;
      this.db.prepare('UPDATE x402_funded_operations SET proof_json=? WHERE operation_key=?').run(canonicalJson({ ...proof, actualGasCostWei, relayerNetGasCostWei: actualGasCostWei - proof.reimbursement }), key);
      return true;
    } catch { return false; }
  }
}
