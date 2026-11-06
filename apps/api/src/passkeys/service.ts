import { randomBytes } from 'node:crypto';
import { encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from 'viem';
import type { ApprovalService } from '../approval.js';
import { escrowAbi, MULTICALL3 } from '../chain.js';
import { termsTuple, type ChargeTerms } from '../collector.js';
import { id, now, type Db } from '../db.js';
import { Indexer } from '../indexer.js';
import { paymentRefundWindow } from '../merchant-settings.js';
import { pendingPaymentIntent } from '../payment-state.js';
import { CHECKOUT, INVOICE, feeFor, gasInUsdt } from '../pricing.js';
import { callKey, expectedGas, type Relayer } from '../relayer.js';
import { ROUTER_LIMITS } from '../suite.js';
import { USDT } from '../token.js';
import { Refusal, type ChainAdapter, type IntentRequest } from '../types.js';
import { reserveIntent } from '../write-reservations.js';
import { permit2Digest, permit2Nonce, permit2WitnessTypedData, replaySafeHash } from './digests.js';
import { base64url, encodeAuth, fromBase64url, keyFromSpki, verifyAssertion, verifyRegistration, type Assertion, type PasskeyKey } from './webauthn.js';

/** Where passkey accounts live: the factory's counterfactual address, and whether the account exists yet. */
export interface PasskeyChain {
  accountAddress(x: Hex, y: Hex, salt: bigint): Promise<Address>;
  isDeployed(account: Address): Promise<boolean>;
}
export interface PasskeyConfig {
  factory: Address; escrow: Address; permit2: Address;
  /** The web origin passkeys are registered on (`PACT_WEB_ORIGIN`), and its host as the WebAuthn RP ID. */
  origin: string; rpId: string;
}
/** Charging the gas of a first payment's account deployment to the merchant's sponsorship budget. */
export interface PasskeySponsorship {
  merchantFor(address: Address): string | null;
  assert(merchantId: string, costWei: bigint, usdtPerWbt: bigint): void;
  record(operationId: string, merchantId: string, costWei: bigint, kind: string): void;
}
/** Gas limits (Whitechain: P-256 runs on the precompile; a bad signature falls back to ~350k, so simulate first). */
export const PASSKEY_CHARGE_GAS = 600_000n;
export const PASSKEY_DEPLOY_GAS = 350_000n;
const CHALLENGE_MS = 5 * 60_000;
const SIGN_SECONDS = 300n;

const factoryAbi = parseAbi(['function createAccount(bytes32 x, bytes32 y, uint256 salt) returns (address)']);
const multicallAbi = parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])']);

export function initPasskeys(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS passkey_accounts(
      subject_id TEXT PRIMARY KEY, credential_id TEXT NOT NULL UNIQUE, x TEXT NOT NULL, y TEXT NOT NULL, salt TEXT NOT NULL,
      account TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS passkey_challenges(id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, challenge TEXT NOT NULL, expires_at TEXT NOT NULL);`);
}
type AccountRow = { subject_id: string; credential_id: string; x: Hex; y: Hex; salt: string; account: Address; created_at: string };
/** The signed-in customer: their passkey account may pay a payment opened for their wallet. */
export interface PasskeyUser { userId: string; email: string | null; wallet: Address }
/** The payment's payer may be empty, the customer's wallet (checkout opens payments for it) or the account. */
const mayPay = (payer: string | null | undefined, account: Address, user: PasskeyUser) => !payer || [account, user.wallet].some(a => a.toLowerCase() === payer.toLowerCase());
/** What a passkey charge offer carries back with the assertion: the payment it is for and when it expires. */
export interface PasskeyIntent { kind: 'passkey'; terms: { id: Hex }; nonce: string; deadline: string; account: Address }

/**
 * Customer passkey accounts: a P-256 key (Face ID, Touch ID, a security key) controls a smart account
 * (`PasskeyAccount`, an ERC-1167 clone from `PasskeyAccountFactory`) that holds the customer's USDT. The
 * account exists at its address before it is deployed, so it can be funded first; Pact deploys it with the
 * first payment. A payment is one passkey confirmation: the assertion is the account's ERC-1271 signature
 * of a Permit2 witness transfer that names this exact payment (`PaymentEscrow.chargeWithPermit2`).
 */
export class PasskeyService {
  constructor(private db: Db, private chain: ChainAdapter, private accounts: PasskeyChain, private relayer: Relayer, private approval: ApprovalService,
    private config: PasskeyConfig, private sponsorship?: PasskeySponsorship) { initPasskeys(db); }

  /** Options for `navigator.credentials.create`: ES256 only, user verification required. */
  registrationOptions(user: PasskeyUser) {
    const challenge = randomBytes(32);
    this.db.prepare('DELETE FROM passkey_challenges WHERE expires_at<?').run(now());
    this.db.prepare('INSERT INTO passkey_challenges VALUES (?,?,?,?)').run(id('pkc'), user.userId, base64url(challenge), new Date(Date.now() + CHALLENGE_MS).toISOString());
    return {
      challenge: base64url(challenge),
      rp: { name: 'Pact', id: this.config.rpId },
      user: { id: base64url(new TextEncoder().encode(user.userId).slice(0, 64)), name: user.email ?? user.userId, displayName: user.email ?? 'Pact customer' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      attestation: 'none', timeout: 60_000,
    };
  }
  /** Stores the passkey and its account address. One passkey account per customer. */
  async register(user: PasskeyUser, body: Record<string, unknown>) {
    if (this.row(user.userId)) throw new Refusal('passkey_exists', 'This account already has a passkey');
    const { credentialId, publicKey, clientDataJSON } = body as Record<string, unknown>;
    if (typeof credentialId !== 'string' || typeof publicKey !== 'string' || typeof clientDataJSON !== 'string' || credentialId.length > 1024) throw new Refusal('invalid_passkey');
    let client: { challenge?: string };
    try { client = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')); } catch { throw new Refusal('invalid_passkey'); }
    const issued = this.db.prepare('SELECT id,challenge FROM passkey_challenges WHERE subject_id=? AND challenge=? AND expires_at>=?').get(user.userId, String(client.challenge ?? ''), now()) as { id: string; challenge: string } | undefined;
    if (!issued) throw new Refusal('challenge_mismatch');
    verifyRegistration({ clientDataJSON, challenge: fromBase64url(issued.challenge), origin: this.config.origin });
    const key = keyFromSpki(fromBase64url(publicKey));
    const account = await this.accounts.accountAddress(key.x, key.y, 0n);
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM passkey_challenges WHERE id=?').run(issued.id);
      this.db.prepare('INSERT INTO passkey_accounts VALUES (?,?,?,?,?,?,?)').run(user.userId, credentialId, key.x, key.y, '0', account.toLowerCase(), now());
    })();
    return this.view(user.userId);
  }
  /** The customer's passkey account, with its USDT balance, or null. */
  async view(subjectId: string) {
    const row = this.row(subjectId);
    if (!row) return null;
    const [deployed, balance] = await Promise.all([this.accounts.isDeployed(row.account).catch(() => null), this.chain.merchantBalance(row.account).catch(() => null)]);
    return { account: row.account, credentialId: row.credential_id, deployed, balanceMinor: balance ? balance.balanceMinor.toString() : null, createdAt: row.created_at };
  }
  /** The charge for this payment the customer's passkey confirms, and the WebAuthn request for it. */
  async offer(paymentId: string, merchantId: string, user: PasskeyUser) {
    const { row, terms } = await this.prepare(paymentId, merchantId, user);
    const deadline = BigInt(Math.floor(Date.now() / 1000)) + SIGN_SECONDS;
    const nonce = permit2Nonce(terms.id, row.account);
    const permit = { token: USDT, amount: terms.amount, nonce, deadline };
    const challenge = replaySafeHash(row.account, permit2Digest(terms, permit, this.config.escrow, this.config.permit2));
    const intent: PasskeyIntent = { kind: 'passkey', terms: { id: terms.id }, nonce: nonce.toString(), deadline: deadline.toString(), account: row.account };
    const plain = (value: unknown) => JSON.parse(JSON.stringify(value, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v));
    return plain({ data: '0x', intent, typedData: permit2WitnessTypedData(terms, permit, this.config.escrow, this.config.permit2),
      passkey: { challenge: base64url(Buffer.from(challenge.slice(2), 'hex')), rpId: this.config.rpId, allowCredentials: [row.credential_id], userVerification: 'required' } });
  }
  /**
   * Submits a passkey-confirmed payment: the terms are rebuilt from the payment record, the assertion is
   * verified locally against the stored key, the payment and journal are reserved together, and the charge
   * (with the account's deployment first, when it does not exist yet, in one Multicall3 transaction) is
   * simulated, then signed and sent by the payer's relayer lane.
   */
  async submit(paymentId: string, merchantId: string, merchant: Address, user: PasskeyUser, body: Record<string, unknown>) {
    const held = body.intent as Partial<PasskeyIntent> | undefined;
    if (held?.kind !== 'passkey' || String(held.terms?.id).toLowerCase() !== paymentId.toLowerCase() || typeof body.signature !== 'string') throw new Refusal('intent_mismatch');
    // A repeat of a submission already made (even one that has since settled) returns it; nothing is sent.
    const own = this.row(user.userId);
    if (own) {
      const prior = this.db.prepare('SELECT id,status,tx_hash FROM intents WHERE signer=? AND nonce=?').get(own.account.toLowerCase(), permit2Nonce(paymentId as Hex, own.account).toString()) as { id: string; status: string; tx_hash: string | null } | undefined;
      if (prior && !(prior.status === 'failed' && !prior.tx_hash)) return { id: prior.id, status: prior.status, txHash: prior.tx_hash };
    }
    const { row, terms } = await this.prepare(paymentId, merchantId, user);
    const deadline = /^\d{1,12}$/.test(String(held.deadline)) ? BigInt(String(held.deadline)) : 0n;
    const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
    if (deadline <= nowSeconds + 10n || deadline > nowSeconds + SIGN_SECONDS + 60n) throw new Refusal('deadline');
    const nonce = permit2Nonce(terms.id, row.account);
    if (String(held.nonce) !== nonce.toString()) throw new Refusal('intent_mismatch');
    const permit = { token: USDT, amount: terms.amount, nonce, deadline };
    const challenge = replaySafeHash(row.account, permit2Digest(terms, permit, this.config.escrow, this.config.permit2));
    let assertion: Assertion;
    try { assertion = JSON.parse(body.signature) as Assertion; } catch { throw new Refusal('invalid_signature'); }
    if (assertion.credentialId !== row.credential_id) throw new Refusal('invalid_signature', 'A different passkey signed this');
    const auth = verifyAssertion(assertion, fromBase64url(base64url(Buffer.from(challenge.slice(2), 'hex'))), { x: row.x, y: row.y } as PasskeyKey, { origin: this.config.origin, rpId: this.config.rpId });
    const existing = this.db.prepare('SELECT id,status,tx_hash FROM intents WHERE signer=? AND nonce=?').get(row.account.toLowerCase(), nonce.toString()) as { id: string; status: string; tx_hash: string | null } | undefined;
    if (existing && !(existing.status === 'failed' && !existing.tx_hash)) return { id: existing.id, status: existing.status, txHash: existing.tx_hash };
    if (existing) this.db.prepare("DELETE FROM intents WHERE id=? AND status='failed' AND tx_hash IS NULL").run(existing.id);

    // Admission, as for any sponsored payment: the minimum, the merchant's signed fee terms, the fee covering
    // the gas, the payer's daily count and its balance.
    if (terms.amount < this.relayer.minimumAmount) throw new Refusal('dust');
    const fees = await this.chain.merchantFees(merchant);
    if (!fees.acceptedVersion || !fees.accepted) throw new Refusal('fee_terms_required');
    const today = new Date().toISOString().slice(0, 10);
    const count = (this.db.prepare("SELECT COUNT(*) AS n FROM intents WHERE signer=? AND substr(created_at,1,10)=?").get(row.account.toLowerCase(), today) as { n: number }).n;
    if (count >= ROUTER_LIMITS.maxPayerCallsPerDay) throw new Refusal('payer_daily_cap');
    const balance = await this.chain.merchantBalance(row.account);
    if (balance.balanceMinor < terms.amount) throw new Refusal('insufficient_funds');

    const charge = encodeFunctionData({ abi: escrowAbi, functionName: 'chargeWithPermit2', args: [termsTuple(terms), { permitted: { token: USDT, amount: terms.amount }, nonce, deadline }, encodeAuth(auth), '0x'] });
    const deployed = await this.accounts.isDeployed(row.account);
    const to = deployed ? this.config.escrow : MULTICALL3;
    const data = deployed ? charge : encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3', args: [[
      { target: this.config.factory, allowFailure: false, callData: encodeFunctionData({ abi: factoryAbi, functionName: 'createAccount', args: [row.x, row.y, BigInt(row.salt)] }) },
      { target: this.config.escrow, allowFailure: false, callData: charge },
    ]] });
    const gas = deployed ? PASSKEY_CHARGE_GAS : PASSKEY_CHARGE_GAS + PASSKEY_DEPLOY_GAS;
    const lane = this.relayer.laneForPayer(row.account);
    const quote = await this.relayer.quote(Number(PASSKEY_CHARGE_GAS));
    const price = BigInt(quote.gasPriceWei), usdtPerWbt = BigInt(quote.usdtPerWbtMinor);
    const chargeCost = expectedGas(lane.writer.measuredGas(callKey(this.config.escrow, charge)), PASSKEY_CHARGE_GAS) * price;
    const fee = feeFor(fees.accepted, terms.product === 1 ? INVOICE : CHECKOUT, terms.amount);
    if (fee * 10n < gasInUsdt(chargeCost, usdtPerWbt) * 12n) throw new Refusal('fee_below_gas');
    // The fee pays for the charge; creating the account moves no money, so it is sponsored gas.
    const deployCost = deployed ? 0n : PASSKEY_DEPLOY_GAS * price;
    const sponsorMerchant = deployed ? null : this.sponsorship?.merchantFor(merchant) ?? null;
    if (sponsorMerchant) this.sponsorship!.assert(sponsorMerchant, deployCost, usdtPerWbt);

    // Journaled like a one-signature charge: the indexer settles it from the escrow's Charged event.
    const request = { kind: 'collector', passkey: true, data: charge, signature: body.signature,
      intent: { signer: row.account, merchant, target: this.config.escrow, dataHash: keccak256(charge), amount: terms.amount, nonce, deadline, maxGas: Number(gas) } } as unknown as IntentRequest;
    const operation = reserveIntent(this.db, lane, merchantId, request, 'intent', paymentId, {}, () => {
      const latest = this.db.prepare('SELECT * FROM payments WHERE id=? AND merchant_id=?').get(paymentId, merchantId) as Record<string, string>;
      if (!['open', 'failed'].includes(latest.status)) throw new Refusal('payment_not_open');
      if (latest.expires_at && new Date(latest.expires_at).getTime() <= Date.now()) throw new Refusal('payment_expired');
      if (!mayPay(latest.payer, row.account, user)) throw new Refusal('payer_mismatch');
      if (pendingPaymentIntent(this.db, paymentId, this.config.escrow)) throw new Refusal('payment_pending');
      this.db.prepare('UPDATE payments SET payer=? WHERE id=?').run(row.account.toLowerCase(), paymentId);
    });
    lane.writer.label(operation.id, callKey(to, data));
    let hash: Hex;
    try { hash = await lane.relay(operation, to, data, gas, chargeCost + deployCost); }
    catch (error) { lane.writer.notSent(operation.id); throw error; }
    if (sponsorMerchant) this.sponsorship!.record(operation.id, sponsorMerchant, deployCost, 'passkey_account');
    if ((this.chain as { autoSettle?: boolean }).autoSettle) await new Indexer(this.db, this.chain).poll();
    return { id: operation.id, status: 'submitted', txHash: hash };
  }
  private row(subjectId: string) { return this.db.prepare('SELECT * FROM passkey_accounts WHERE subject_id=?').get(subjectId) as AccountRow | undefined; }
  /** The payment's terms with the customer's passkey account as payer; refuses what the account cannot pay. */
  private async prepare(paymentId: string, merchantId: string, user: PasskeyUser): Promise<{ row: AccountRow; terms: ChargeTerms }> {
    const row = this.row(user.userId);
    if (!row) throw new Refusal('passkey_required', 'Create a passkey account first');
    const p = this.db.prepare('SELECT * FROM payments WHERE id=? AND merchant_id=?').get(paymentId, merchantId) as Record<string, string> | undefined;
    if (!p) throw new Refusal('payment_mismatch');
    if (!['open', 'failed'].includes(p.status)) throw new Refusal('payment_not_open');
    if (!mayPay(p.payer, row.account, user)) throw new Refusal('payer_mismatch');
    // Only payments the escrow collects (not a financed invoice) and only with the v3 escrow.
    if (!this.approval.collectorFor || !(await this.approval.collectorFor(paymentId))) throw new Refusal('passkey_unavailable');
    const window = paymentRefundWindow(this.db, paymentId);
    if (window === null) throw new Refusal('refund_window_unavailable');
    const merchant = (this.db.prepare('SELECT address FROM merchants WHERE id=?').get(merchantId) as { address: Address }).address;
    const invoice = !!(JSON.parse(p.metadata ?? '{}') as { invoiceId?: string }).invoiceId;
    return { row, terms: { id: p.id as Hex, payer: row.account, merchant, amount: BigInt(p.amount_minor), refundWindow: Number(window), product: invoice ? 1 : 0 } };
  }
}
