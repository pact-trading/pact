import { createHash, randomBytes } from 'node:crypto';
import { getAddress, isAddress, verifyMessage, type Address, type Hex } from 'viem';
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import { id, now, type Db } from './db.js';
import { IdentityError, type Identity, type VerifiedIdentity } from './identity.js';

/** Session tokens issued after a signed login message. Opaque, stored only as a hash. */
export const WALLET_TOKEN_PREFIX = 'pact_ws_';
export const isWalletToken = (token: string) => token.startsWith(WALLET_TOKEN_PREFIX) && /^pact_ws_[\w-]{43}$/.test(token);

export interface WalletIdentityConfig {
  /** Exact web origin the login message must name, e.g. http://localhost:3000. */
  origin: string;
  chainId?: number;
  sessionSeconds?: number;
  nonceSeconds?: number;
  /** Local fork only: accept a self-declared, unverified email for test customers. */
  allowLocalEmail?: boolean;
  /** Signature check. Defaults to EOA recovery; the server passes an ERC-1271 aware check. */
  verify?: (address: Address, message: string, signature: Hex) => Promise<boolean>;
}
interface SessionRow { id: string; address: Address; email: string | null; created_at: string; expires_at: string; revoked_at: string | null }
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const validEmail = (x: unknown): x is string => typeof x === 'string' && x.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);

/**
 * Sign-In with Ethereum (EIP-4361). The wallet signs a one-time message naming this site,
 * chain 1874 and a server nonce; the API returns a session token. The wallet address is the
 * identity: as a merchant it owns its data and its GasTank balance.
 */
export class WalletIdentity implements Identity {
  private readonly config: Required<Omit<WalletIdentityConfig, 'verify'>> & Pick<WalletIdentityConfig, 'verify'>;
  private readonly domain: string;
  constructor(private readonly db: Db, config: WalletIdentityConfig) {
    this.config = { chainId: 1874, sessionSeconds: 12 * 3600, nonceSeconds: 600, allowLocalEmail: false, ...config };
    const origin = new URL(config.origin);
    this.domain = origin.host;
    this.config.origin = origin.origin;
    db.exec(`CREATE TABLE IF NOT EXISTS wallet_nonces(nonce TEXT PRIMARY KEY,created_at TEXT NOT NULL,used_at TEXT);
      CREATE TABLE IF NOT EXISTS wallet_sessions(id TEXT PRIMARY KEY,token_hash TEXT NOT NULL UNIQUE,address TEXT NOT NULL,email TEXT,
        created_at TEXT NOT NULL,expires_at TEXT NOT NULL,revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS wallet_merchants(address TEXT PRIMARY KEY,merchant_id TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);`);
  }
  handles(token: string) { return isWalletToken(token); }

  /** Fields the client needs to build the login message. */
  challenge() {
    const cutoff = new Date(Date.now() - this.config.nonceSeconds * 1000).toISOString();
    this.db.prepare('DELETE FROM wallet_nonces WHERE created_at<?').run(cutoff);
    const outstanding = (this.db.prepare('SELECT count(*) n FROM wallet_nonces WHERE used_at IS NULL').get() as { n: number }).n;
    if (outstanding >= 10_000) throw new IdentityError('too_many_login_attempts', 503);
    const nonce = generateSiweNonce();
    this.db.prepare('INSERT INTO wallet_nonces VALUES (?,?,NULL)').run(nonce, now());
    return { nonce, domain: this.domain, uri: this.config.origin, chainId: this.config.chainId, version: '1' as const,
      statement: 'Sign in to Pact. This request does not move funds or cost gas.', expiresInSeconds: this.config.nonceSeconds };
  }

  async verify(message: unknown, signature: unknown, options: { email?: unknown } = {}) {
    if (typeof message !== 'string' || message.length > 4096 || typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130,}$/.test(signature) || signature.length > 20_000)
      throw new IdentityError('invalid_login_message', 400);
    const parsed = parseSiweMessage(message);
    if (!parsed.address || !isAddress(parsed.address) || !parsed.nonce || !parsed.issuedAt || parsed.chainId !== this.config.chainId || parsed.uri === undefined || new URL(parsed.uri).origin !== this.config.origin)
      throw new IdentityError('invalid_login_message', 400);
    const issued = parsed.issuedAt.getTime();
    if (issued > Date.now() + 30_000 || issued < Date.now() - this.config.nonceSeconds * 1000) throw new IdentityError('login_message_expired', 401);
    if (!validateSiweMessage({ message: parsed, domain: this.domain, nonce: parsed.nonce, time: new Date() })) throw new IdentityError('invalid_login_message', 401);
    const address = getAddress(parsed.address);
    const verify = this.config.verify ?? ((a: Address, m: string, s: Hex) => verifyMessage({ address: a, message: m, signature: s }));
    let valid = false;
    try { valid = await verify(address, message, signature as Hex); } catch { valid = false; }
    if (!valid) throw new IdentityError('invalid_login_signature', 401);
    let email: string | null = null;
    if (options.email !== undefined && options.email !== null && options.email !== '') {
      if (!this.config.allowLocalEmail) throw new IdentityError('email_not_allowed', 400);
      if (!validEmail(options.email)) throw new IdentityError('invalid_email', 400);
      email = options.email.toLowerCase();
    }
    const token = `${WALLET_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const sessionId = `wss_${randomBytes(12).toString('hex')}`;
    const expiresAt = Math.floor(Date.now() / 1000) + this.config.sessionSeconds;
    this.db.transaction(() => {
      // The nonce is consumed exactly once, in the same transaction as the session.
      const used = this.db.prepare('UPDATE wallet_nonces SET used_at=? WHERE nonce=? AND used_at IS NULL').run(now(), parsed.nonce);
      if (used.changes !== 1) throw new IdentityError('login_nonce_used', 401);
      this.db.prepare('INSERT INTO wallet_sessions VALUES (?,?,?,?,?,?,NULL)').run(sessionId, hash(token), address.toLowerCase(), email, now(), new Date(expiresAt * 1000).toISOString());
    })();
    return { token, sessionId, address: address.toLowerCase() as Address, expiresAt, email };
  }

  async authenticate(token: string): Promise<VerifiedIdentity> {
    if (!isWalletToken(token)) throw new IdentityError('invalid_identity_token', 401);
    const row = this.db.prepare('SELECT * FROM wallet_sessions WHERE token_hash=?').get(hash(token)) as SessionRow | undefined;
    if (!row || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now()) throw new IdentityError('invalid_identity_token', 401);
    return { userId: `wallet:${row.address}`, sessionId: row.id, expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000),
      wallet: { address: row.address, id: null }, email: row.email, kind: 'wallet' };
  }
  revoke(token: string) {
    if (isWalletToken(token)) this.db.prepare('UPDATE wallet_sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL').run(now(), hash(token));
  }
  async merchantFor(token: string) {
    const user = await this.authenticate(token);
    const binding = this.db.prepare('SELECT merchant_id FROM wallet_merchants WHERE address=?').get(user.wallet.address) as { merchant_id: string } | undefined;
    if (!binding) throw new IdentityError('merchant_not_registered', 403);
    return { merchantId: binding.merchant_id, address: user.wallet.address, kind: 'secret' as const };
  }
  async register(token: string) {
    const user = await this.authenticate(token);
    const address = user.wallet.address;
    return this.db.transaction(() => {
      const binding = this.db.prepare('SELECT merchant_id FROM wallet_merchants WHERE address=?').get(address) as { merchant_id: string } | undefined;
      if (binding) return { merchantId: binding.merchant_id, address, created: false };
      // The signature proves control of the address, so an unbound merchant record with the same
      // address (for example a bootstrap merchant) belongs to this wallet. Privy-bound ones do not.
      const existing = this.db.prepare('SELECT id FROM merchants WHERE lower(address)=?').get(address) as { id: string } | undefined;
      const privyBound = this.tableExists('privy_merchants') && this.db.prepare('SELECT 1 FROM privy_merchants WHERE address=?').get(address);
      if (existing && privyBound) throw new IdentityError('merchant_address_already_registered', 409);
      const merchantId = existing?.id ?? id('mer');
      if (!existing) this.db.prepare('INSERT INTO merchants VALUES (?,?,?,?,?)').run(merchantId, address, null, null, now());
      this.db.prepare('INSERT INTO wallet_merchants VALUES (?,?,?)').run(address, merchantId, now());
      return { merchantId, address, created: !existing };
    })();
  }
  private tableExists(name: string) {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  }
}
