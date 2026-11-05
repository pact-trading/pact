import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { PrivyClient, formatRequestForAuthorizationSignature, type Policy, type WalletApiRequestSignatureInput } from '@privy-io/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeFunctionData, hashTypedData, keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { openDb, seedMerchant, type Db } from '../src/db.js';
import { FakeChain, subscriptionV2Abi } from '../src/chain.js';
import { FundedRenewals, type RenewalStateReader } from '../src/funded-renewals.js';
import type { RenewalGrant } from '../src/funded-renewal-store.js';
import { mandateTypedData } from '../src/typed-data.js';
import { PrivyIdentity } from '../src/identity.js';
import { PrivyRenewalSigner } from '../src/privy-merchant-signer.js';
import { assertMerchantPolicy, assertScopedIntent, merchantIntentPolicy, merchantPolicyHash, type MerchantIntentScope } from '../src/privy-signing-policy.js';

const merchant = privateKeyToAccount(`0x${'3'.repeat(64)}`), payer = privateKeyToAccount(`0x${'2'.repeat(64)}`);
const router = '0x0000000000000000000000000000000000000001', manager = '0x0000000000000000000000000000000000000002';
const databases: Db[] = [];
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = openDb(); databases.push(db); const keys = seedMerchant(db, merchant.address);
  const chain = new FakeChain(false, 2); chain.writer.bind(db);
  chain.tank.set(merchant.address.toLowerCase(), { balanceWei: 10n ** 18n, dailyCapWei: 10n ** 18n, spentTodayWei: 0n });
  const at = BigInt(Math.floor(Date.now() / 1000));
  const mandate = { payer: payer.address, merchant: merchant.address, planId: keccak256(toHex('plan')), amountCap: 2_000_000n, periodSeconds: 86400n, maxPeriods: 12, endTime: at + 86400n * 13n, nonce: 0n };
  const chainId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'address' }], [payer.address, 0n, manager]));
  db.prepare('INSERT INTO plans(id,merchant_id,name,amount_minor,period_seconds,max_periods,created_at) VALUES (?,?,?,?,?,?,?)').run('plan', keys.merchantId, 'Daily', '2000000', 86400, 12, new Date().toISOString());
  db.prepare('INSERT INTO subscriptions(id,merchant_id,plan_id,chain_id,payer,status,next_charge_at,retry_count,pending_tx_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('sub', keys.merchantId, 'plan', chainId, payer.address, 'active', new Date(Number(at) * 1000).toISOString(), 0, null, new Date().toISOString());
  const scope: MerchantIntentScope = { merchant: merchant.address, router, target: manager, dataHash: keccak256(encodeFunctionData({ abi: subscriptionV2Abi, functionName: 'charge', args: [chainId, 2_000_000n] })), amount: 2_000_000n, maxFeeUSDT: 10000n, maxGas: 400000, validFrom: at - 1n, validUntil: at + 86400n };
  const template = merchantIntentPolicy(scope);
  const policy: Policy = { id: 'policy', owner_id: 'owner', name: 'Renewal', created_at: 1, ...template, rules: template.rules.map((rule, i) => ({ id: `rule-${i}`, ...rule })) };
  const authKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = authKey.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const wallet = { id: 'wallet', chain_type: 'ethereum', address: merchant.address, owner_id: 'owner', archived_at: null, additional_signers: [{ signer_id: 'signer', override_policy_ids: ['policy'] }], policy_ids: [] };
  const primary = { id: 'wallet', type: 'wallet', chain_type: 'ethereum', address: merchant.address, wallet_client_type: 'privy', connector_type: 'embedded', wallet_index: 0, user_can_sign: true };
  const user = { id: 'did:privy:test', linked_accounts: [primary] };
  const owner = { id: 'owner', authorization_keys: [] as { public_key: string }[], authorization_threshold: 1, user_ids: [user.id], key_quorum_ids: [] as string[] };
  const quorum = { id: 'signer', authorization_keys: [{ public_key: pub }], authorization_threshold: 1, user_ids: [] as string[], key_quorum_ids: [] as string[] };
  const calls: Array<{ method: string; path: string; body?: Record<string, any>; headers: Headers }> = [];
  let onPost: (() => void) | undefined, fail = false, returnedSigner = merchant;
  const fetcher: typeof fetch = async (url, init) => {
    const u = new URL(String(url)); if (u.origin !== 'https://api.privy.io') throw new Error('Synthetic provider only');
    const path = decodeURIComponent(u.pathname), method = init?.method ?? 'GET', headers = new Headers(init?.headers), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, headers });
    if (fail) return Response.json({ error: 'sensitive-provider-detail' }, { status: 503 });
    if (method === 'GET') {
      const data = path === `/v1/users/${user.id}` ? user : path === '/v1/wallets/wallet' ? wallet : path === '/v1/policies/policy' ? policy : path === '/v1/key_quorums/signer' ? quorum : path === '/v1/key_quorums/owner' ? owner : undefined;
      if (!data) throw new Error(`Unexpected synthetic provider read ${path}`);
      return Response.json(data);
    }
    if (path !== '/v1/wallets/wallet/rpc' || body.method !== 'eth_signTypedData_v4') throw new Error('Unexpected provider write');
    const authorization: WalletApiRequestSignatureInput = { version: 1, method: 'POST', url: u.href, body, headers: {
      'privy-app-id': 'test-app', 'privy-idempotency-key': headers.get('privy-idempotency-key')!, 'privy-request-expiry': headers.get('privy-request-expiry')!,
    } };
    expect(verify('sha256', formatRequestForAuthorizationSignature(authorization), authKey.publicKey, Buffer.from(headers.get('privy-authorization-signature')!, 'base64'))).toBe(true);
    expect(body.params.typed_data.message.amount).toBe('2000000');
    expect(typeof body.params.typed_data.message.nonce).toBe('string');
    expect(db.prepare('SELECT digest FROM privy_signing_requests').get()).toBeDefined();
    const typed = body.params.typed_data;
    const signature = await returnedSigner.signTypedData({ domain: typed.domain, types: typed.types, primaryType: typed.primary_type, message: typed.message });
    onPost?.();
    return Response.json({ method: 'eth_signTypedData_v4', data: { encoding: 'hex', signature } });
  };
  const config = { appId: 'test-app', appSecret: 'synthetic-test-secret', signerId: 'signer', authorizationPublicKey: pub, authorize: vi.fn(async (payload: Uint8Array) => sign('sha256', payload, authKey.privateKey).toString('base64')) };
  const client = new PrivyClient({ appId: config.appId, appSecret: config.appSecret, fetch: fetcher, maxRetries: 0, logLevel: 'off' });
  new PrivyIdentity(db, config, client);
  db.prepare('INSERT INTO privy_merchants VALUES (?,?,?,?,?)').run(config.appId, user.id, keys.merchantId, merchant.address.toLowerCase(), new Date().toISOString());
  const signer = new PrivyRenewalSigner(db, config, client);
  const grant: RenewalGrant = { version: 1, merchantId: keys.merchantId, merchant: merchant.address, subscriptionId: 'sub', chainId: 1874, router, manager, token: '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7', chainSubscriptionId: chainId,
    binding: { appId: config.appId, userId: user.id, walletId: 'wallet', signerId: 'signer', policyId: policy.id, policyHash: merchantPolicyHash(policy) },
    mandate, mandateHash: hashTypedData(mandateTypedData(mandate, manager, '2')), dataHash: scope.dataHash, amount: scope.amount, maxFeeUSDT: scope.maxFeeUSDT, maxGas: scope.maxGas, validFrom: scope.validFrom, validUntil: scope.validUntil, maxGasPriceWei: 2_000_000_000n, maxTransactionCostWei: 2n * 10n ** 15n, maxTotalGasWei: 10n ** 17n,
    maxCalls: 12, maxCallsPerDay: 2, maxFeesPerDay: 20000n, maxFeesTotal: 120000n, maxSigningRevisions: 3, acceptance: { kind: 'synthetic-local', reference: 'HTTP fixture, no real Privy delegation' } };
  const reader: RenewalStateReader = { read: async () => ({ chainId: 1874, manager, router, token: grant.token, subscriptionId: chainId, blockNumber: 20n, blockHash: keccak256(toHex('block')), timestamp: at,
    subscription: { ...mandate, chargedPeriods: 0, nextChargeAt: at, cancelled: false }, chargeAllowed: true, mustReturnTrue: true }) };
  const service = new FundedRenewals(db, chain, { mode: 'synthetic-test', signer, reader, localGasBudgetWei: 10n ** 17n });
  const hash = service.installSyntheticGrant(grant);
  return { db, chain, config, service, signer, grant, hash, scope, calls, policy, wallet, primary, owner, quorum, at,
    postHook(fn: () => void) { onPost = fn; }, fail() { fail = true; }, wrongSigner() { returnedSigner = payer; } };
}

describe('Privy exact merchant signing through the official SDK', () => {
  it('checks provider authority, signs only the persisted intent with P-256 request authorization and broadcasts via the shared writer', async () => {
    const f = fixture(); const result = await f.service.renew('sub');
    expect(result).toMatchObject({ state: 'pending' }); expect(f.chain.sent).toHaveLength(1);
    const posts = f.calls.filter(c => c.method === 'POST'); expect(posts).toHaveLength(1);
    expect(f.config.authorize).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(c => c.path === '/v1/wallets/wallet')).toHaveLength(2);
    expect(f.db.prepare('SELECT signature,reference FROM privy_signing_responses').get()).toMatchObject({ reference: expect.stringMatching(/^privy-idempotency:/) });
    expect(() => f.db.prepare("UPDATE privy_signing_requests SET digest='changed'").run()).toThrow('immutable');
  });
  it.each(['removed', 'no-policy', 'wider-policy', 'server-owned-policy', 'wrong-user', 'other-key', 'wallet-changed', 'owner-key-added'] as const)('refuses %s before a signature or transaction', async change => {
    const f = fixture();
    if (change === 'removed') f.wallet.additional_signers = [];
    if (change === 'no-policy') f.wallet.additional_signers[0].override_policy_ids = [];
    if (change === 'wider-policy') f.policy.rules[0].conditions = [];
    if (change === 'server-owned-policy') f.policy.owner_id = 'signer';
    if (change === 'wrong-user') f.owner.user_ids = ['did:privy:other'];
    if (change === 'other-key') f.quorum.authorization_keys[0].public_key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    if (change === 'wallet-changed') f.primary.address = payer.address;
    if (change === 'owner-key-added') f.owner.authorization_keys = [{ public_key: f.config.authorizationPublicKey }];
    await expect(f.service.renew('sub')).rejects.toThrow('merchant_signing_unavailable');
    expect(f.calls.filter(c => c.method === 'POST')).toHaveLength(0); expect(f.chain.sent).toHaveLength(0);
    expect(f.config.authorize).not.toHaveBeenCalled();
  });
  it.each(['provider-revoke', 'local-revoke', 'wrong-signature', 'provider-error'] as const)('withholds signature on %s and preserves the signing audit without broadcasting', async change => {
    const f = fixture();
    if (change === 'provider-revoke') f.postHook(() => { f.wallet.additional_signers = []; });
    if (change === 'local-revoke') f.postHook(() => f.service.store.revoke(f.hash, 'owner revoked'));
    if (change === 'wrong-signature') f.wrongSigner();
    if (change === 'provider-error') f.fail();
    await expect(f.service.renew('sub')).rejects.toThrow('merchant_signing_unavailable');
    expect(f.chain.sent).toHaveLength(0); expect(f.calls.filter(c => c.method === 'POST')).toHaveLength(change === 'provider-error' ? 0 : 1);
    expect(f.db.prepare('SELECT * FROM renewal_signatures').all()).toHaveLength(0);
    if (change.endsWith('revoke')) expect(f.db.prepare('SELECT * FROM privy_signing_responses').all()).toHaveLength(1);
  });
  it('rejects a substituted persisted request before contacting Privy', async () => {
    const f = fixture();
    const capture = vi.spyOn(f.signer, 'signExactIntent');
    await f.service.renew('sub'); const request = capture.mock.calls[0][0];
    const before = f.calls.length;
    await expect(f.signer.signExactIntent({ ...request, operationId: 'another-operation' })).rejects.toThrow('unpersisted');
    expect(f.calls).toHaveLength(before);
  });
  it('matches every enrolled subscription scope in one provider policy without allowing extra rules', async () => {
    const f = fixture();
    f.service.store.revoke(f.hash, 'Replace with jointly approved policy');
    const mandate = { ...f.grant.mandate, planId: keccak256(toHex('plan2')), nonce: 1n };
    const chainId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'address' }], [payer.address, 1n, manager]));
    const secondScope = { ...f.scope, dataHash: keccak256(encodeFunctionData({ abi: subscriptionV2Abi, functionName: 'charge', args: [chainId, f.scope.amount] })) };
    f.policy.rules = merchantIntentPolicy([f.scope, secondScope]).rules.map((rule, i) => ({ ...rule, id: `batch-${i}`, conditions: [...rule.conditions].reverse() })).reverse();
    const policyHash = merchantPolicyHash(f.policy), binding = { ...f.grant.binding, policyHash };
    f.db.prepare('INSERT INTO plans(id,merchant_id,name,amount_minor,period_seconds,max_periods,created_at) VALUES (?,?,?,?,?,?,?)').run('plan2', f.grant.merchantId, 'Other', '2000000', 86400, 12, new Date().toISOString());
    f.db.prepare('INSERT INTO subscriptions(id,merchant_id,plan_id,chain_id,payer,status,next_charge_at,retry_count,pending_tx_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('sub2', f.grant.merchantId, 'plan2', chainId, payer.address, 'active', new Date().toISOString(), 0, null, new Date().toISOString());
    f.service.installSyntheticGrant({ ...f.grant, binding });
    f.service.installSyntheticGrant({ ...f.grant, binding, subscriptionId: 'sub2', chainSubscriptionId: chainId, mandate, mandateHash: hashTypedData(mandateTypedData(mandate, manager, '2')), dataHash: secondScope.dataHash });
    await expect(f.service.renew('sub')).resolves.toMatchObject({ state: 'pending' });
    expect(f.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    expect(() => assertMerchantPolicy(f.policy, f.scope, 'owner', policyHash)).toThrow('policy_mismatch');
    expect(() => merchantIntentPolicy([f.scope, f.scope])).toThrow('Conflicting');
    expect(() => merchantIntentPolicy([f.scope, { ...secondScope, merchant: payer.address }])).toThrow('Conflicting');
  });
  it('does not automatically retry a lost provider signing response or expose provider error text', async () => {
    const f = fixture(); f.postHook(() => { throw new Error('sensitive-provider-detail'); });
    await expect(f.service.renew('sub')).rejects.toThrow(/^merchant_signing_unavailable$/);
    expect(f.calls.filter(c => c.method === 'POST')).toHaveLength(1);
    expect(f.db.prepare('SELECT * FROM privy_signing_requests').all()).toHaveLength(1);
    expect(f.db.prepare('SELECT * FROM privy_signing_responses').all()).toHaveLength(0);
    expect(f.chain.sent).toHaveLength(0);
  });
  it('checks exact type/domain and current absolute/relative limits independently of provider policy', async () => {
    // The service computes its 120-second deadline after asynchronous reads.
    // Keep its clock equal to the fixture's explicit assertion timestamp.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T12:00:00Z'));
    const f = fixture(), capture = vi.spyOn(f.signer, 'signExactIntent'); await f.service.renew('sub');
    const typed = capture.mock.calls[0][0].typedData;
    expect(() => assertScopedIntent(f.scope, typed, f.at)).not.toThrow();
    for (const altered of [
      { ...typed, domain: { ...typed.domain, name: 'Other' } },
      { ...typed, message: { ...typed.message, deadline: f.at + 121n } },
      { ...typed, message: { ...typed.message, feeUSDT: f.scope.maxFeeUSDT + 1n } },
      { ...typed, message: { ...typed.message, dataHash: keccak256(toHex('other')) } },
    ]) expect(() => assertScopedIntent(f.scope, altered, f.at)).toThrow('scope_mismatch');
    const changed = structuredClone(f.policy); changed.rules.push({ ...changed.rules[0], id: 'allow-all', conditions: [] });
    expect(() => assertMerchantPolicy(changed, f.scope, 'owner', f.grant.binding.policyHash)).toThrow('policy_mismatch');
  });
});
