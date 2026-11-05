import { PrivyClient, InvalidAuthTokenError, APIError } from '@privy-io/node';
import { isAddress, type Address } from 'viem';
import { id, now, type Db } from './db.js';

export interface IdentityConfig { appId: string; appSecret: string; verificationKey?: string }
export class IdentityError extends Error {
  constructor(readonly code: string, readonly status: 400 | 401 | 403 | 404 | 409 | 503) { super(code); }
}
export function identityConfig(env: Record<string, string | undefined>): IdentityConfig | undefined {
  if (!env.PRIVY_APP_ID && !env.PRIVY_APP_SECRET && !env.PRIVY_VERIFICATION_KEY) return undefined;
  if (!env.PRIVY_APP_ID?.trim()) throw new Error('PRIVY_APP_ID is required');
  if (!env.PRIVY_APP_SECRET?.trim()) throw new Error('PRIVY_APP_SECRET is required');
  return { appId: env.PRIVY_APP_ID.trim(), appSecret: env.PRIVY_APP_SECRET, verificationKey: env.PRIVY_VERIFICATION_KEY?.replaceAll('\\n', '\n') };
}
export interface VerifiedIdentity {
  userId: string; sessionId: string; expiresAt: number;
  wallet: { address: Address; id: string | null }; email: string | null;
  /** How the user signed in: Privy email/passkey (embedded wallet) or a signed wallet login. */
  kind?: 'privy' | 'wallet';
}
export interface MerchantIdentity { merchantId: string; address: Address; kind: 'secret' }
/** One sign-in method. `handles` says whether a bearer token belongs to it. */
export interface Identity {
  handles(token: string): boolean;
  authenticate(token: string): Promise<VerifiedIdentity>;
  merchantFor(token: string): Promise<MerchantIdentity>;
  register(token: string): Promise<{ merchantId: string; address: Address; created: boolean }>;
}
const isJwt = (token: string) => token.length <= 16_384 && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(token);

/** Routes each bearer token to the sign-in method that issued it. */
export class Identities implements Identity {
  private readonly methods: Identity[];
  constructor(...methods: Array<Identity | undefined>) { this.methods = methods.filter((m): m is Identity => !!m); }
  get configured() { return this.methods.length > 0; }
  find<T extends Identity>(type: abstract new (...args: never[]) => T): T | undefined { return this.methods.find((m): m is T => m instanceof type); }
  handles(token: string) { return this.methods.some(m => m.handles(token)); }
  private method(token: string) {
    const method = this.methods.find(m => m.handles(token));
    if (!method) throw new IdentityError('invalid_identity_token', 401);
    return method;
  }
  authenticate(token: string) { return this.method(token).authenticate(token); }
  merchantFor(token: string) { return this.method(token).merchantFor(token); }
  register(token: string) { return this.method(token).register(token); }
}
interface MerchantBinding { merchant_id: string; address: Address }

/** Privy owns authentication and wallet keys. This service never generates or
 * stores private keys, raw JWTs or provider user objects. API keys remain a
 * separate server integration credential, scoped to their existing merchant. */
export class PrivyIdentity implements Identity {
  private readonly client: PrivyClient;
  constructor(private readonly db: Db, private readonly config: IdentityConfig, client?: PrivyClient) {
    this.client = client ?? new PrivyClient({ appId: config.appId, appSecret: config.appSecret, jwtVerificationKey: config.verificationKey, timeout: 2500, maxRetries: 0, logLevel: 'off' });
    db.exec(`CREATE TABLE IF NOT EXISTS privy_merchants(
      app_id TEXT NOT NULL,user_id TEXT NOT NULL,merchant_id TEXT NOT NULL UNIQUE,address TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,PRIMARY KEY(app_id,user_id));`);
  }
  handles(token: string) { return isJwt(token); }
  async authenticate(accessToken: string): Promise<VerifiedIdentity> {
    if (accessToken.length > 16_384 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(accessToken)) throw new IdentityError('invalid_identity_token', 401);
    let claims;
    try { claims = await this.client.utils().auth().verifyAccessToken(accessToken); }
    catch (error) {
      if (error instanceof InvalidAuthTokenError) throw new IdentityError('invalid_identity_token', 401);
      throw new IdentityError('identity_unavailable', 503);
    }
    const current = Math.floor(Date.now() / 1000);
    if (claims.app_id !== this.config.appId || claims.issuer !== 'privy.io' || !claims.user_id.startsWith('did:privy:') || claims.user_id.length > 255 || claims.issued_at > current + 30 || claims.expiration <= current) throw new IdentityError('invalid_identity_token', 401);
    let user;
    try { user = await this.client.users()._get(claims.user_id); }
    catch (error) {
      if (error instanceof APIError && error.status === 404) throw new IdentityError('invalid_identity_token', 401);
      throw new IdentityError('identity_unavailable', 503);
    }
    if (user.id !== claims.user_id || !Array.isArray(user.linked_accounts)) throw new IdentityError('invalid_identity_token', 401);
    // Do not accept an arbitrary linked/external wallet or choose a replacement
    // address silently. Privy's primary user-signable EVM wallet is explicit.
    const wallets = user.linked_accounts.filter(account => account.type === 'wallet' && account.chain_type === 'ethereum' && 'wallet_client_type' in account && account.wallet_client_type === 'privy' && account.connector_type === 'embedded' && 'wallet_index' in account && account.wallet_index === 0 && 'user_can_sign' in account && account.user_can_sign === true);
    if (wallets.length !== 1 || !('address' in wallets[0]) || !isAddress(wallets[0].address)) throw new IdentityError('embedded_wallet_required', 409);
    const wallet = wallets[0];
    const email = user.linked_accounts.find(account => account.type === 'email' && account.verified_at > 0);
    return { userId: user.id, sessionId: claims.session_id, expiresAt: claims.expiration,
      wallet: { address: wallet.address.toLowerCase() as Address, id: 'id' in wallet && typeof wallet.id === 'string' ? wallet.id : null },
      email: email?.type === 'email' ? email.address : null, kind: 'privy' };
  }
  private binding(user: VerifiedIdentity): MerchantBinding | undefined {
    const binding = this.db.prepare('SELECT merchant_id,address FROM privy_merchants WHERE app_id=? AND user_id=?').get(this.config.appId, user.userId) as MerchantBinding | undefined;
    if (binding) {
      const merchant = this.db.prepare('SELECT address FROM merchants WHERE id=?').get(binding.merchant_id) as { address: string } | undefined;
      if (binding.address !== user.wallet.address || merchant?.address.toLowerCase() !== binding.address) throw new IdentityError('merchant_wallet_changed', 409);
    }
    return binding;
  }
  async merchantFor(accessToken: string) {
    const user = await this.authenticate(accessToken), binding = this.binding(user);
    if (!binding) throw new IdentityError('merchant_not_registered', 403);
    return { merchantId: binding.merchant_id, address: binding.address, kind: 'secret' as const };
  }
  async register(accessToken: string) {
    const user = await this.authenticate(accessToken);
    return this.db.transaction(() => {
      const existing = this.binding(user);
      if (existing) return { merchantId: existing.merchant_id, address: existing.address, created: false };
      // A legacy treasury must be migrated explicitly. Email equality or a
      // matching address alone must never claim an existing merchant record.
      if (this.db.prepare('SELECT 1 FROM merchants WHERE lower(address)=?').get(user.wallet.address) || this.db.prepare('SELECT 1 FROM privy_merchants WHERE address=?').get(user.wallet.address)) throw new IdentityError('merchant_address_already_registered', 409);
      const merchantId = id('mer');
      this.db.prepare('INSERT INTO merchants VALUES (?,?,?,?,?)').run(merchantId, user.wallet.address, null, null, now());
      this.db.prepare('INSERT INTO privy_merchants VALUES (?,?,?,?,?)').run(this.config.appId, user.userId, merchantId, user.wallet.address, now());
      return { merchantId, address: user.wallet.address, created: true };
    })();
  }
}
