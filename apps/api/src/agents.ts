import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ExactEvmScheme as ExactClient } from '@x402/evm/exact/client';
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { encodeAbiParameters, encodeFunctionData, getContractAddress, keccak256, parseAbi, recoverTypedDataAddress, toHex, type Address, type Hex, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { ViemChain } from './chain.js';
import { id, now, type Db } from './db.js';
import { IdentityError } from './identity.js';
import { Refusal } from './types.js';
import { createX402AccountSigner } from './x402/account-client.js';
import { NETWORK, USDT } from './x402/constants.js';
import { PAID_ENDPOINT, paidPath, type LiveX402 } from './x402/live.js';
import { ReservationPendingError } from './x402/sqlite-reservations.js';
import { gasCost } from './approval-chain.js';

const accountAbi = parseAbi([
  'function configureSessionWithSig(address key,uint256 perCall,uint256 daily,uint256 expiry,address[] merchants,uint256 deadline,bytes signature)',
  'function revokeSessionWithSig(uint256 deadline,bytes signature)',
  'function bootstrap(uint256 amount,uint256 deadline,bytes signature)',
  'function approvalNonce() view returns (uint256)',
  'function reservedPerDay(uint256) view returns (uint256)',
  'function sessionKey() view returns (address)',
]);
const factoryAbi = parseAbi(['function createAccount(address owner,bytes32 salt) returns (address)']);
const MAX_AGENTS_PER_OWNER = 3;
const reserveAbi = parseAbi([
  'function reserve((address spender,uint256 amount,uint256 nonce,uint256 deadline,address to,address facilitator,uint256 validAfter) payment,bytes signature) returns (bytes32)',
  'error Unauthorized()', 'error InvalidPolicy()', 'error SessionExpired()', 'error MerchantDenied()', 'error PerCallCap()', 'error DailyCap()', 'error InvalidWindow()', 'error AlreadyReserved()',
]);
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const MAX_APPROVAL = 100_000_000n;
const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v)));
const bad = (code: string, status: 400 | 403 | 404 | 409 | 429 = 400): never => { throw new IdentityError(code, status); };

type AgentRow = { id: string; owner: Address; name: string; description: string; account: Address; session_key: Address; session_secret: Hex; per_call_minor: string; daily_minor: string; expires_at: string; merchants: string; status: string; created_at: string };
type Pending = { kind: 'create' | 'limits' | 'revoke'; owner: Address; payload: Record<string, unknown> };

const domain = (account: Address) => ({ name: 'Settle X402 Account', version: '1', chainId: 1874, verifyingContract: account });
const sessionTypes = { Session: [
  { name: 'key', type: 'address' }, { name: 'perCall', type: 'uint256' }, { name: 'daily', type: 'uint256' }, { name: 'expiry', type: 'uint256' },
  { name: 'merchants', type: 'address[]' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] } as const;
const bootstrapTypes = { Bootstrap: [{ name: 'amount', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] } as const;
const revokeTypes = { Revoke: [{ name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] } as const;

/**
 * Agent accounts in live mode. The customer owns the account and signs every change (no gas); the
 * relayer sends them. The agent is software Pact runs for the customer, holding only a session key
 * whose per-call cap, daily cap and allowed merchants are enforced by the account contract.
 */
export class AgentService {
  private readonly creationCode: Hex;
  constructor(private readonly db: Db, private readonly chain: ViemChain, private readonly pub: PublicClient, private readonly factory: Address, private readonly x402: LiveX402, private readonly apiOrigin: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, owner TEXT NOT NULL, owner_user TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
        account TEXT NOT NULL UNIQUE, session_key TEXT NOT NULL, session_secret TEXT NOT NULL, per_call_minor TEXT NOT NULL, daily_minor TEXT NOT NULL,
        expires_at TEXT NOT NULL, merchants TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_pending(id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_calls(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, merchant_id TEXT NOT NULL, url TEXT NOT NULL, scheme TEXT NOT NULL,
        price_minor TEXT NOT NULL, amount_minor TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, tx_hash TEXT, response_status INTEGER NOT NULL,
        response_body TEXT, created_at TEXT NOT NULL);`);
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    this.creationCode = JSON.parse(readFileSync(`${process.env.CONTRACT_ARTIFACTS_DIR ?? `${root}/contracts/out`}/X402AgentAccount.sol/X402AgentAccount.json`, 'utf8')).bytecode.object;
  }

  // ---- relayed transactions
  private async send(objectId: string, to: Address, data: Hex, gas: bigint) {
    const price = await this.chain.gasPrice();
    const operation = this.chain.writer.operation('x402', objectId);
    const hash = await this.chain.writer.run(() => this.chain.writer.execute(operation, () => this.chain.transactionCount(), async nonce => {
      const prepared = await this.chain.prepareAgentTransaction({ to, data, gas, maxFeePerGas: price }, nonce);
      this.chain.writer.reserveSpend(operation.id, gas * price, 100_000_000_000_000_000n);
      return prepared;
    }, raw => this.chain.broadcastTransaction(raw)), operation.id).catch(error => { this.chain.writer.notSent(operation.id); throw error; });
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    this.chain.writer.resolve(hash, receipt.blockNumber, receipt.status, gasCost(receipt).gasCostWei);
    if (receipt.status !== 'success') throw new Refusal('agent_transaction_failed');
    return hash;
  }
  private hold(owner: Address, kind: Pending['kind'], payload: Record<string, unknown>) {
    const pendingId = id('agp');
    this.db.prepare('DELETE FROM agent_pending WHERE created_at<?').run(new Date(Date.now() - 15 * 60_000).toISOString());
    this.db.prepare('INSERT INTO agent_pending VALUES (?,?,?,?,?)').run(pendingId, owner.toLowerCase(), kind, JSON.stringify(json(payload)), now());
    return pendingId;
  }
  private take(owner: Address, kind: Pending['kind'], pendingId: unknown) {
    const row = this.db.prepare('SELECT * FROM agent_pending WHERE id=? AND owner=? AND kind=?').get(String(pendingId), owner.toLowerCase(), kind) as { payload: string } | undefined;
    if (!row) return bad('agent_request_expired', 409);
    this.db.prepare('DELETE FROM agent_pending WHERE id=?').run(String(pendingId));
    return JSON.parse(row.payload) as Record<string, string | string[]>;
  }
  private merchantsFor(ids: unknown) {
    const list = (Array.isArray(ids) ? ids : []).map(String).slice(0, 32);
    const rows = list.map(merchantId => this.db.prepare('SELECT id,address FROM merchants WHERE id=?').get(merchantId) as { id: string; address: Address } | undefined);
    if (!rows.length || rows.some(r => !r)) bad('invalid_merchants');
    return rows as Array<{ id: string; address: Address }>;
  }
  private limits(body: Record<string, unknown>) {
    const perCall = BigInt(String(body.perCallCapMinor ?? '10000')), daily = BigInt(String(body.dailyCapMinor ?? '100000'));
    if (perCall <= 0n || daily < perCall || daily > MAX_APPROVAL) bad('invalid_limits');
    return { perCall, daily };
  }

  /**
   * Pact's relayer pays to deploy and configure an agent account (about 0.01 WBT), and nothing pays it
   * back, so each owner may create at most three accounts, one a day.
   */
  private assertCanCreate(owner: Address) {
    const rows = this.db.prepare('SELECT created_at FROM agents WHERE owner=?').all(owner.toLowerCase()) as Array<{ created_at: string }>;
    if (rows.length >= MAX_AGENTS_PER_OWNER) bad('agent_limit', 409);
    const dayAgo = Date.now() - 86_400_000;
    if (rows.some(r => Date.parse(r.created_at) > dayAgo)) bad('agent_daily_limit', 429);
  }
  /** Step 1 of creating an agent: the account address and the two messages the owner signs. */
  async createIntent(owner: Address, body: Record<string, unknown>) {
    this.assertCanCreate(owner);
    const merchants = this.merchantsFor(body.merchantIds);
    const { perCall, daily } = this.limits(body);
    const salt = toHex(randomBytes(32));
    const account = getContractAddress({ opcode: 'CREATE2', from: this.factory, salt: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [owner, salt])),
      bytecode: `${this.creationCode}${encodeAbiParameters([{ type: 'address' }], [owner]).slice(2)}` as Hex });
    const sessionSecret = generatePrivateKey();
    const key = privateKeyToAccount(sessionSecret).address;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 540);
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 30 * 86_400);
    const session = { domain: domain(account), types: sessionTypes, primaryType: 'Session' as const, message: { key, perCall, daily, expiry, merchants: merchants.map(m => m.address), nonce: 0n, deadline } };
    const approval = { domain: domain(account), types: bootstrapTypes, primaryType: 'Bootstrap' as const, message: { amount: daily, nonce: 1n, deadline } };
    const pendingId = this.hold(owner, 'create', { name: String(body.name ?? 'My agent').slice(0, 80), description: String(body.description ?? '').slice(0, 300), salt, account, sessionSecret, key, perCall, daily, expiry, deadline, merchants: merchants.map(m => m.id) });
    return json({ pendingId, account, typedData: [session, approval] });
  }
  async create(owner: Address, ownerUser: string, body: Record<string, unknown>) {
    this.assertCanCreate(owner);
    const p = this.take(owner, 'create', body.pendingId);
    const signatures = body.signatures as Hex[] | undefined;
    if (!Array.isArray(signatures) || signatures.length !== 2) return bad('signatures_required');
    const account = p.account as Address, merchants = this.merchantsFor(p.merchants);
    const session = { domain: domain(account), types: sessionTypes, primaryType: 'Session' as const, message: { key: p.key as Address, perCall: BigInt(p.perCall as string), daily: BigInt(p.daily as string), expiry: BigInt(p.expiry as string), merchants: merchants.map(m => m.address), nonce: 0n, deadline: BigInt(p.deadline as string) } };
    const approval = { domain: domain(account), types: bootstrapTypes, primaryType: 'Bootstrap' as const, message: { amount: BigInt(p.daily as string), nonce: 1n, deadline: BigInt(p.deadline as string) } };
    for (const [typed, signature] of [[session, signatures[0]], [approval, signatures[1]]] as const)
      if ((await recoverTypedDataAddress({ ...typed, signature } as never)).toLowerCase() !== owner.toLowerCase()) return bad('invalid_signature');
    const agentId = id('agt');
    await this.send(agentId, this.factory, encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: [owner, p.salt as Hex] }), 2_500_000n);
    await this.send(agentId, account, encodeFunctionData({ abi: accountAbi, functionName: 'configureSessionWithSig', args: [session.message.key, session.message.perCall, session.message.daily, session.message.expiry, session.message.merchants, session.message.deadline, signatures[0]] }), 400_000n);
    await this.send(agentId, account, encodeFunctionData({ abi: accountAbi, functionName: 'bootstrap', args: [approval.message.amount, approval.message.deadline, signatures[1]] }), 200_000n);
    this.db.prepare('INSERT INTO agents VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(agentId, owner.toLowerCase(), ownerUser, p.name, p.description, account.toLowerCase(), (p.key as string).toLowerCase(), p.sessionSecret, p.perCall, p.daily, new Date(Number(p.expiry) * 1000).toISOString(), JSON.stringify(p.merchants), 'active', now());
    return this.view(this.row(owner, agentId));
  }

  async limitsIntent(owner: Address, agentId: string, body: Record<string, unknown>) {
    const a = this.row(owner, agentId);
    if (a.status !== 'active') return bad('agent_revoked', 409);
    const { perCall, daily } = this.limits(body);
    const nonce = await this.pub.readContract({ address: a.account, abi: accountAbi, functionName: 'approvalNonce' });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 540);
    const merchants = this.merchantsFor(JSON.parse(a.merchants));
    const typed = { domain: domain(a.account), types: sessionTypes, primaryType: 'Session' as const, message: { key: a.session_key, perCall, daily, expiry: BigInt(Math.floor(new Date(a.expires_at).getTime() / 1000)), merchants: merchants.map(m => m.address), nonce, deadline } };
    return json({ pendingId: this.hold(owner, 'limits', { agentId, perCall, daily, deadline, nonce }), typedData: typed });
  }
  async setLimits(owner: Address, agentId: string, body: Record<string, unknown>) {
    const p = this.take(owner, 'limits', body.pendingId), a = this.row(owner, agentId);
    if (p.agentId !== agentId) return bad('agent_request_mismatch');
    const merchants = this.merchantsFor(JSON.parse(a.merchants));
    const message = { key: a.session_key, perCall: BigInt(p.perCall as string), daily: BigInt(p.daily as string), expiry: BigInt(Math.floor(new Date(a.expires_at).getTime() / 1000)), merchants: merchants.map(m => m.address), nonce: BigInt(p.nonce as string), deadline: BigInt(p.deadline as string) };
    const signature = body.signature as Hex;
    if ((await recoverTypedDataAddress({ domain: domain(a.account), types: sessionTypes, primaryType: 'Session', message, signature })).toLowerCase() !== owner.toLowerCase()) return bad('invalid_signature');
    await this.send(agentId, a.account, encodeFunctionData({ abi: accountAbi, functionName: 'configureSessionWithSig', args: [message.key, message.perCall, message.daily, message.expiry, message.merchants, message.deadline, signature] }), 400_000n);
    this.db.prepare('UPDATE agents SET per_call_minor=?,daily_minor=? WHERE id=?').run(String(message.perCall), String(message.daily), agentId);
    return this.view(this.row(owner, agentId));
  }
  async revokeIntent(owner: Address, agentId: string) {
    const a = this.row(owner, agentId);
    const nonce = await this.pub.readContract({ address: a.account, abi: accountAbi, functionName: 'approvalNonce' });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 540);
    return json({ pendingId: this.hold(owner, 'revoke', { agentId, nonce, deadline }), typedData: { domain: domain(a.account), types: revokeTypes, primaryType: 'Revoke', message: { nonce, deadline } } });
  }
  async revoke(owner: Address, agentId: string, body: Record<string, unknown>) {
    const p = this.take(owner, 'revoke', body.pendingId), a = this.row(owner, agentId);
    const message = { nonce: BigInt(p.nonce as string), deadline: BigInt(p.deadline as string) };
    const signature = body.signature as Hex;
    if ((await recoverTypedDataAddress({ domain: domain(a.account), types: revokeTypes, primaryType: 'Revoke', message, signature })).toLowerCase() !== owner.toLowerCase()) return bad('invalid_signature');
    await this.send(agentId, a.account, encodeFunctionData({ abi: accountAbi, functionName: 'revokeSessionWithSig', args: [message.deadline, signature] }), 150_000n);
    this.db.prepare("UPDATE agents SET status='revoked' WHERE id=?").run(agentId);
    return this.view(this.row(owner, agentId));
  }

  /** Runs `count` paid calls with the official @x402/fetch client and the agent's session key. */
  async run(owner: Address, agentId: string, count: number, merchantId?: string) {
    const a = this.row(owner, agentId);
    const merchants = JSON.parse(a.merchants) as string[];
    const target = merchantId && merchants.includes(merchantId) ? merchantId : merchants[0];
    const session = privateKeyToAccount(a.session_secret);
    const reservations = this.x402.reservations, journal = this.x402.journal;
    const pub = this.pub, relayer = this.chain.writer.relayer as Address;
    const signer = createX402AccountSigner(a.account, this.pub, session, { async reserve(account, payment, signature) {
      // Simulate first (layer 6): a refused reservation costs no gas and carries the contract's reason.
      await pub.simulateContract({ address: account, abi: reserveAbi, functionName: 'reserve', args: [payment, signature], account: relayer });
      // The reservation must confirm before the payment signature is released.
      for (let i = 0; ; i++) {
        try { return await reservations.reserve(account, payment, signature); }
        catch (error) {
          if (!(error instanceof ReservationPendingError) || error.reason !== 'settlement_pending' || i > 40) throw error;
          await new Promise(r => setTimeout(r, 500));
          await journal.reconcile();
        }
      }
    } });
    const client = x402Client.fromConfig({ schemes: [{ network: NETWORK, client: new ExactClient(signer) }], spendControls: { allowedAssets: [{ network: NETWORK, asset: USDT, maxAmountPerPayment: '1000000' }] } });
    const paying = wrapFetchWithPayment(fetch, client);
    const calls = [];
    for (let i = 0; i < Math.max(1, Math.min(20, count)); i++) {
      const url = `${this.apiOrigin}${paidPath(target)}?invoice=inv_${1000 + i}`;
      let status: 'settled' | 'refused' = 'refused', reason: string | null = null, txHash: Hex | null = null, responseStatus: 200 | 402 = 402, responseBody: string | null = null, amount = '0';
      try {
        const response = await paying(url);
        responseBody = (await response.text()).slice(0, 500);
        responseStatus = response.status === 200 ? 200 : 402;
        const header = response.headers.get('payment-response');
        if (response.status === 200 && header) {
          const settlement = decodePaymentResponseHeader(header);
          status = settlement.success ? 'settled' : 'refused';
          txHash = (settlement.transaction ?? null) as Hex | null;
          amount = PAID_ENDPOINT.priceMinor;
          reason = settlement.success ? null : settlement.errorReason ?? 'settlement_failed';
        } else reason = 'payment_required';
      } catch (error) {
        // Refusals from the account contract surface as simulation reverts with their custom error name.
        const message = error instanceof Error ? `${error.message} ${(error as { cause?: { message?: string } }).cause?.message ?? ''}` : String(error);
        const named = (error as { cause?: { data?: { errorName?: string } } })?.cause?.data?.errorName;
        reason = named ?? ['DailyCap', 'PerCallCap', 'MerchantDenied', 'SessionExpired', 'InvalidWindow', 'AlreadyReserved', 'Unauthorized', 'merchant_daily_sponsorship_cap'].find(code => message.includes(code)) ?? (/insufficient|balance|exceeds/i.test(message) ? 'InsufficientFunds' : 'payment_failed');
        // A revoked session has no key, which the account reports as expired.
        if (reason === 'SessionExpired' && a.status === 'revoked') reason = 'SessionRevoked';
        if (reason === 'Unauthorized') reason = 'SessionRevoked';
      }
      const callId = id('call');
      this.db.prepare('INSERT INTO agent_calls VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(callId, agentId, target, url, 'exact', PAID_ENDPOINT.priceMinor, amount, status, reason, txHash, responseStatus, responseBody, now());
      calls.push(this.callView(this.db.prepare('SELECT * FROM agent_calls WHERE id=?').get(callId) as Record<string, string>));
    }
    return { calls, session: await this.view(this.row(owner, agentId)) };
  }

  // ---- reads
  private row(owner: Address, agentId: string) {
    const row = this.db.prepare('SELECT * FROM agents WHERE id=? AND owner=?').get(agentId, owner.toLowerCase()) as AgentRow | undefined;
    return row ?? bad('agent_not_found', 404);
  }
  callView(c: Record<string, string>) {
    const agent = this.db.prepare('SELECT name FROM agents WHERE id=?').get(c.agent_id) as { name: string } | undefined;
    const merchantName = (this.db.prepare('SELECT brand_name FROM merchant_settings WHERE merchant_id=?').get(c.merchant_id) as { brand_name: string } | undefined)?.brand_name || 'This business';
    return { id: c.id, agentId: c.agent_id, agentName: agent?.name ?? 'Agent', merchantName, method: 'GET' as const, url: c.url, scheme: c.scheme as 'exact', priceMinor: c.price_minor, amountMinor: c.amount_minor, status: c.status as 'settled' | 'refused', reason: c.reason, txHash: c.tx_hash as Hex | null, responseStatus: Number(c.response_status) as 200 | 402, responseBody: c.response_body, createdAt: c.created_at };
  }
  async view(a: AgentRow) {
    const day = BigInt(Math.floor(Date.now() / 86_400_000));
    const reserved = await this.pub.readContract({ address: a.account, abi: accountAbi, functionName: 'reservedPerDay', args: [day] }).catch(() => 0n);
    const balance = await this.pub.readContract({ address: USDT, abi: erc20, functionName: 'balanceOf', args: [a.account] }).catch(() => 0n);
    const today = new Date().toISOString().slice(0, 10);
    const callsToday = (this.db.prepare("SELECT count(*) n FROM agent_calls WHERE agent_id=? AND status='settled' AND created_at>=?").get(a.id, today) as { n: number }).n;
    const merchants = (JSON.parse(a.merchants) as string[]).map(merchantId => {
      const m = this.db.prepare('SELECT m.address,s.brand_name FROM merchants m LEFT JOIN merchant_settings s ON s.merchant_id=m.id WHERE m.id=?').get(merchantId) as { address: Address; brand_name: string | null } | undefined;
      return { id: merchantId, address: m?.address ?? ('0x' as Address), name: m?.brand_name || 'This business' };
    });
    const expired = new Date(a.expires_at).getTime() <= Date.now();
    return { id: a.id, name: a.name, description: a.description, account: a.account, sessionKey: a.session_key, perCallCapMinor: a.per_call_minor, dailyCapMinor: a.daily_minor,
      allowedMerchants: merchants, expiresAt: a.expires_at, status: a.status === 'revoked' ? 'revoked' as const : expired ? 'expired' as const : 'active' as const,
      spentTodayMinor: reserved.toString(), callsToday, balanceMinor: balance.toString(), createdAt: a.created_at };
  }
  async list(owner: Address) {
    const rows = this.db.prepare('SELECT * FROM agents WHERE owner=? ORDER BY created_at DESC').all(owner.toLowerCase()) as AgentRow[];
    return Promise.all(rows.map(r => this.view(r)));
  }
  async detail(owner: Address, agentId: string) {
    const a = this.row(owner, agentId);
    const calls = (this.db.prepare('SELECT * FROM agent_calls WHERE agent_id=? ORDER BY created_at DESC LIMIT 100').all(agentId) as Array<Record<string, string>>).map(c => this.callView(c));
    return { session: await this.view(a), calls };
  }
  /** Agents allowed to pay this merchant, with their owner, balance and today's activity here. */
  async merchantOverview(merchantId: string) {
    const rows = (this.db.prepare('SELECT * FROM agents ORDER BY created_at DESC').all() as AgentRow[]).filter(a => (JSON.parse(a.merchants) as string[]).includes(merchantId));
    const today = new Date().toISOString().slice(0, 10);
    const merchant = this.db.prepare('SELECT m.address,s.brand_name FROM merchants m LEFT JOIN merchant_settings s ON s.merchant_id=m.id WHERE m.id=?').get(merchantId) as { address: string; brand_name: string | null };
    const agents = await Promise.all(rows.map(async a => {
      const calls = (this.db.prepare('SELECT * FROM agent_calls WHERE agent_id=? AND merchant_id=? ORDER BY created_at DESC LIMIT 20').all(a.id, merchantId) as Array<Record<string, string>>).map(c => this.callView(c));
      const todays = calls.filter(c => c.createdAt >= today);
      const owner = this.db.prepare('SELECT id,name,email FROM commerce_customers WHERE merchant_id=? AND lower(wallet)=lower(?) LIMIT 1').get(merchantId, a.owner) as { id: string; name: string | null; email: string | null } | undefined;
      const session = await this.view(a);
      return { session, owner: { id: owner?.id ?? '', name: owner?.name ?? owner?.email ?? `${a.owner.slice(0, 6)}…${a.owner.slice(-4)}`, company: null }, balanceMinor: session.balanceMinor,
        paidToYouTodayMinor: todays.filter(c => c.status === 'settled').reduce((t, c) => t + BigInt(c.amountMinor), 0n).toString(),
        settledToday: todays.filter(c => c.status === 'settled').length, refusedToday: todays.filter(c => c.status !== 'settled').length, recent: calls.slice(0, 5) };
    }));
    const endpoints = this.paidEndpoints(merchantId).map(({ id, method, path, description, priceMinor, scheme }) => ({ id, method, path, description, priceMinor, scheme }));
    return { agents, endpoints, recent: this.merchantCalls(merchantId, 20), scenarios: [], merchant: { name: merchant.brand_name || 'This business', address: merchant.address } };
  }
  /** One paid request, step by step, for the merchant it paid (or tried to pay). */
  async trace(merchantId: string, callId: string) {
    const c = this.db.prepare('SELECT * FROM agent_calls WHERE id=? AND merchant_id=?').get(callId, merchantId) as Record<string, string> | undefined;
    if (!c) return bad('agent_call_not_found', 404);
    const overview = await this.merchantOverview(merchantId);
    const agent = overview.agents.find(a => a.session.id === c.agent_id) ?? overview.agents[0];
    const call = this.callView(c);
    const stage = ['DailyCap', 'PerCallCap', 'MerchantDenied', 'SessionExpired', 'SessionRevoked', 'InsufficientFunds'].includes(String(call.reason)) ? 'authorise' as const : 'settle' as const;
    return { call, agent, endpoint: overview.endpoints[0] ?? null, merchant: overview.merchant, network: 'eip155:1874', feeMinor: '0',
      refusal: call.status === 'refused' ? { reason: call.reason ?? 'refused', detail: call.reason ?? 'The request was refused.', stage } : null };
  }
  merchantCalls(merchantId: string, limit = 50) {
    return (this.db.prepare('SELECT * FROM agent_calls WHERE merchant_id=? ORDER BY created_at DESC LIMIT ?').all(merchantId, Math.max(1, Math.min(500, limit))) as Array<Record<string, string>>).map(c => this.callView(c));
  }
  paidEndpoints(merchantId: string) {
    const today = new Date().toISOString().slice(0, 10);
    const rows = this.db.prepare('SELECT status,amount_minor FROM agent_calls WHERE merchant_id=? AND created_at>=?').all(merchantId, today) as Array<{ status: string; amount_minor: string }>;
    return [{ id: 'ep_risk_score', method: 'GET' as const, path: paidPath(merchantId), description: PAID_ENDPOINT.description, priceMinor: PAID_ENDPOINT.priceMinor, scheme: PAID_ENDPOINT.scheme,
      callsToday: rows.filter(r => r.status === 'settled').length, refusedToday: rows.filter(r => r.status !== 'settled').length,
      revenueTodayMinor: rows.filter(r => r.status === 'settled').reduce((t, r) => t + BigInt(r.amount_minor), 0n).toString() }];
  }
}
