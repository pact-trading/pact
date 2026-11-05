import { PrivyClient, type AuthorizationContext, type KeyQuorum } from '@privy-io/node';
import { hashTypedData, recoverTypedDataAddress, type Hex } from 'viem';
import type { Db } from './db.js';
import { now } from './db.js';
import type { IdentityConfig } from './identity.js';
import type { MerchantRenewalSigner } from './funded-renewals.js';
import { RenewalStore, type RenewalGrant } from './funded-renewal-store.js';
import { assertMerchantPolicy, assertScopedIntent, authorizationPublicKey, canonicalJson, type MerchantIntentScope } from './privy-signing-policy.js';

export interface PrivySigningConfig extends IdentityConfig {
  signerId: string; authorizationPublicKey: string;
  /** External P-256 request authorization (e.g. KMS); never a merchant wallet key. */
  authorize: AuthorizationContext.SignFn;
}
const same = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const clock = () => BigInt(Math.floor(Date.now() / 1000));
const scopeOf = (g: RenewalGrant): MerchantIntentScope => ({ merchant: g.merchant, router: g.router, target: g.manager, dataHash: g.dataHash, amount: g.amount, maxFeeUSDT: g.maxFeeUSDT, maxGas: g.maxGas, validFrom: g.validFrom, validUntil: g.validUntil });

/** Actual Privy sign-only transport. It does not install grants or enable the
 * FundedRenewals runtime. Real grant enrollment remains a separate owner flow. */
export class PrivyRenewalSigner implements MerchantRenewalSigner {
  private readonly client: PrivyClient;
  private readonly grants: RenewalStore;
  private readonly publicKey: string;
  constructor(private readonly db: Db, private readonly config: PrivySigningConfig, client?: PrivyClient) {
    if (!config.appId.trim() || !config.appSecret || !config.signerId.trim() || typeof config.authorize !== 'function') throw new Error('Explicit Privy signing configuration required');
    this.publicKey = authorizationPublicKey(config.authorizationPublicKey);
    this.config = { ...config, authorizationPublicKey: this.publicKey };
    this.client = client ?? new PrivyClient({ appId: config.appId, appSecret: config.appSecret, apiUrl: 'https://api.privy.io', timeout: 2500, maxRetries: 0, logLevel: 'off' });
    this.grants = new RenewalStore(db);
    db.exec(`CREATE TABLE IF NOT EXISTS privy_signing_requests(operation_id TEXT PRIMARY KEY,grant_hash TEXT NOT NULL,digest TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,request_expiry INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS privy_signing_responses(operation_id TEXT PRIMARY KEY,signature TEXT NOT NULL,reference TEXT NOT NULL,created_at TEXT NOT NULL);`);
    for (const table of ['privy_signing_requests', 'privy_signing_responses']) for (const action of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable Privy signing record'); END`);
  }
  private persisted(input: Parameters<MerchantRenewalSigner['signExactIntent']>[0]) {
    const grant = this.grants.getGrant(input.grantHash);
    if (!grant || this.grants.activeGrant(grant.subscriptionId)?.hash !== input.grantHash || !same(grant.merchant, input.expectedMerchantAddress)
      || canonicalJson(grant.binding) !== canonicalJson(input.binding) || grant.binding.appId !== this.config.appId || grant.binding.signerId !== this.config.signerId) throw new Error('merchant_grant_unavailable');
    const binding = this.db.prepare('SELECT p.address,m.address AS merchant_address FROM privy_merchants p JOIN merchants m ON m.id=p.merchant_id WHERE p.app_id=? AND p.user_id=? AND p.merchant_id=?').get(this.config.appId, grant.binding.userId, grant.merchantId) as { address: string; merchant_address: string } | undefined;
    if (!binding || !same(binding.address, grant.merchant) || !same(binding.merchant_address, grant.merchant)) throw new Error('merchant_identity_mismatch');
    const revision = this.db.prepare(`SELECT r.grant_hash,r.typed_data_json,o.phase,o.kind,o.object_id FROM renewal_signing_revisions r JOIN relayer_operations o ON o.operation_id=r.operation_id WHERE r.operation_id=?`).get(input.operationId) as { grant_hash: string; typed_data_json: string; phase: string; kind: string; object_id: string } | undefined;
    if (!revision || revision.grant_hash !== input.grantHash || revision.phase !== 'preparing' || revision.kind !== 'renew' || revision.object_id !== grant.subscriptionId
      || canonicalJson(JSON.parse(revision.typed_data_json)) !== canonicalJson(input.typedData)) throw new Error('unpersisted_merchant_signing_request');
    assertScopedIntent(scopeOf(grant), input.typedData, clock());
    return grant;
  }
  private userOwner(quorum: KeyQuorum, id: string, userId: string) {
    if (quorum.id !== id || quorum.authorization_threshold !== 1 || quorum.authorization_keys.length || quorum.key_quorum_ids?.length || quorum.user_ids?.length !== 1 || quorum.user_ids[0] !== userId) throw new Error('merchant_policy_owner_mismatch');
  }
  private async attest(grant: RenewalGrant) {
    const b = grant.binding;
    const [user, wallet, policy, signer] = await Promise.all([
      this.client.users()._get(b.userId), this.client.wallets().get(b.walletId), this.client.policies().get(b.policyId), this.client.keyQuorums().get(b.signerId),
    ]);
    const primary = user.linked_accounts.filter(a => a.type === 'wallet' && a.chain_type === 'ethereum' && 'wallet_client_type' in a && a.wallet_client_type === 'privy' && a.connector_type === 'embedded' && 'wallet_index' in a && a.wallet_index === 0 && 'user_can_sign' in a && a.user_can_sign === true);
    if (user.id !== b.userId || primary.length !== 1 || !('id' in primary[0]) || primary[0].id !== b.walletId || !same(primary[0].address, grant.merchant)
      || wallet.id !== b.walletId || wallet.chain_type !== 'ethereum' || !same(wallet.address, grant.merchant) || wallet.archived_at != null || !wallet.owner_id || wallet.owner_id === b.signerId) throw new Error('merchant_wallet_mismatch');
    const delegated = wallet.additional_signers.filter(s => s.signer_id === b.signerId);
    if (delegated.length !== 1 || canonicalJson(delegated[0].override_policy_ids) !== canonicalJson([b.policyId])) throw new Error('merchant_delegation_revoked');
    if (signer.id !== b.signerId || signer.authorization_threshold !== 1 || signer.user_ids?.length || signer.key_quorum_ids?.length || signer.authorization_keys.length !== 1 || authorizationPublicKey(signer.authorization_keys[0].public_key) !== this.publicKey) throw new Error('merchant_signer_mismatch');
    this.userOwner(await this.client.keyQuorums().get(wallet.owner_id), wallet.owner_id, b.userId);
    if (policy.id !== b.policyId) throw new Error('merchant_policy_mismatch');
    const active = this.db.prepare('SELECT hash FROM renewal_grants g WHERE NOT EXISTS (SELECT 1 FROM renewal_grant_revocations r WHERE r.grant_hash=g.hash)').all() as { hash: Hex }[];
    const scopes = active.map(row => this.grants.getGrant(row.hash)!).filter(g => g.binding.appId === b.appId && g.binding.walletId === b.walletId && g.binding.signerId === b.signerId && g.binding.policyId === b.policyId).map(g => {
      if (g.binding.policyHash !== b.policyHash || g.binding.userId !== b.userId || g.merchantId !== grant.merchantId || !same(g.merchant, grant.merchant)) throw new Error('merchant_policy_grants_inconsistent');
      return scopeOf(g);
    });
    assertMerchantPolicy(policy, scopes, wallet.owner_id, b.policyHash);
  }
  async signExactIntent(input: Parameters<MerchantRenewalSigner['signExactIntent']>[0]) {
    // Freeze caller-controlled objects before any provider await.
    const frozen = structuredClone(input);
    const grant = this.persisted(frozen);
    try {
      await this.attest(grant);
      this.persisted(frozen);
      const digest = hashTypedData(frozen.typedData);
      const key = `settle-renewal-${frozen.operationId}-${digest.slice(2)}`;
      const expiry = Number(frozen.typedData.message.deadline) * 1000;
      this.db.prepare('INSERT OR IGNORE INTO privy_signing_requests VALUES (?,?,?,?,?,?)').run(frozen.operationId, frozen.grantHash, digest, key, expiry, now());
      const recorded = this.db.prepare('SELECT * FROM privy_signing_requests WHERE operation_id=?').get(frozen.operationId) as { grant_hash: string; digest: string; idempotency_key: string; request_expiry: number };
      if (recorded.grant_hash !== frozen.grantHash || recorded.digest !== digest || recorded.idempotency_key !== key || recorded.request_expiry !== expiry) throw new Error('merchant_signing_conflict');
      const previous = this.db.prepare('SELECT signature,reference FROM privy_signing_responses WHERE operation_id=?').get(frozen.operationId) as { signature: Hex; reference: string } | undefined;
      let signature: Hex;
      if (previous) signature = previous.signature;
      else {
        const typed = JSON.parse(canonicalJson(frozen.typedData));
        const result = await this.client.wallets().ethereum().signTypedData(grant.binding.walletId, {
          params: { typed_data: { domain: typed.domain, types: typed.types, primary_type: typed.primaryType, message: typed.message } },
          authorization_context: { sign_fns: [this.config.authorize] }, idempotency_key: key, request_expiry: expiry,
        });
        if (result.encoding !== 'hex' || !/^0x[\da-f]{130}$/i.test(result.signature)) throw new Error('merchant_signature_mismatch');
        signature = result.signature as Hex;
      }
      if (!same(await recoverTypedDataAddress({ ...frozen.typedData, signature }), grant.merchant)) throw new Error('merchant_signature_mismatch');
      // The SDK exposes a caller-chosen idempotency correlation, not a server request ID.
      const reference = `privy-idempotency:${key}`;
      this.db.prepare('INSERT OR IGNORE INTO privy_signing_responses VALUES (?,?,?,?)').run(frozen.operationId, signature, reference, now());
      await this.attest(grant);
      this.persisted(frozen);
      return { signature, providerRequestId: reference };
    } catch { throw new Error('merchant_signing_unavailable'); }
  }
}
