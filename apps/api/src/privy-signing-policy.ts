import { createPublicKey } from 'node:crypto';
import type { Policy } from '@privy-io/node';
import { isAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { intentTypedData, intentTypes } from './typed-data.js';
import type { Intent } from './types.js';

export interface MerchantIntentScope {
  merchant: Address; router: Address; target: Address; dataHash: Hex; amount: bigint;
  maxFeeUSDT: bigint; maxGas: number; validFrom: bigint; validUntil: bigint;
}
export function canonicalJson(value: unknown): string {
  function sorted(v: unknown): unknown {
    if (typeof v === 'bigint') return v.toString();
    if (Array.isArray(v)) return v.map(sorted);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, sorted(value)]));
    return v;
  }
  return JSON.stringify(sorted(value));
}
export function authorizationPublicKey(value: string): string {
  const key = createPublicKey({ key: Buffer.from(value, 'base64'), type: 'spki', format: 'der' });
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('P-256 authorization public key required');
  return key.export({ type: 'spki', format: 'der' }).toString('base64');
}
function validateScope(s: MerchantIntentScope) {
  if (![s.merchant, s.router, s.target].every(a => isAddress(a) && BigInt(a) !== 0n) || !/^0x[\da-f]{64}$/i.test(s.dataHash)
    || s.amount <= 0n || s.amount >= 2n ** 256n || s.maxFeeUSDT <= 0n || s.maxFeeUSDT >= 2n ** 256n
    || !Number.isSafeInteger(s.maxGas) || s.maxGas <= 0 || s.maxGas > 1_000_000 || s.validFrom < 0n
    || s.validUntil <= s.validFrom || s.validUntil >= 2n ** 64n) throw new Error('Invalid merchant signing scope');
}
type PolicyDefinition = Pick<Policy, 'chain_type' | 'version'> & { rules: Array<Omit<Policy['rules'][number], 'id'>> };
function scopeRule(scope: MerchantIntentScope): PolicyDefinition['rules'][number] {
  validateScope(scope);
  type Condition = Policy['rules'][number]['conditions'][number];
  const typed_data = { primary_type: 'Intent', types: { Intent: intentTypes.Intent.map(field => ({ ...field })) } };
  const message = (field: string, operator: 'eq' | 'lte' | 'gte', value: string): Condition => ({ field_source: 'ethereum_typed_data_message', field, operator, value, typed_data });
  return { name: 'Bound merchant Router intent', action: 'ALLOW', method: 'eth_signTypedData_v4', conditions: [
    { field_source: 'ethereum_typed_data_domain', field: 'chainId', operator: 'eq', value: '1874' },
    { field_source: 'ethereum_typed_data_domain', field: 'verifyingContract', operator: 'eq', value: scope.router.toLowerCase() },
    message('signer', 'eq', scope.merchant.toLowerCase()), message('merchant', 'eq', scope.merchant.toLowerCase()),
    message('target', 'eq', scope.target.toLowerCase()), message('dataHash', 'eq', scope.dataHash.toLowerCase()),
    message('amount', 'eq', scope.amount.toString()), message('feeUSDT', 'gte', '1'), message('feeUSDT', 'lte', scope.maxFeeUSDT.toString()),
    message('maxGas', 'gte', '1'), message('maxGas', 'lte', String(scope.maxGas)),
    message('deadline', 'gte', scope.validFrom.toString()), message('deadline', 'lte', scope.validUntil.toString()),
  ] };
}
/** One exact ALLOW per approved subscription in the signer's single policy.
 * Provider policy cannot replace the scheduler's due-time and durable budgets. */
export function merchantIntentPolicy(input: MerchantIntentScope | readonly MerchantIntentScope[]): PolicyDefinition {
  const scopes = Array.isArray(input) ? input : [input as MerchantIntentScope];
  if (!scopes.length || scopes.length > 100) throw new Error('Invalid merchant policy scope count');
  const actions = new Set<string>();
  for (const scope of scopes) {
    validateScope(scope);
    const action = `${scope.target.toLowerCase()}:${scope.dataHash.toLowerCase()}`;
    if (actions.has(action) || scope.merchant.toLowerCase() !== scopes[0].merchant.toLowerCase() || scope.router.toLowerCase() !== scopes[0].router.toLowerCase()) throw new Error('Conflicting merchant policy scope');
    actions.add(action);
  }
  return { version: '1.0', chain_type: 'ethereum', rules: scopes.map(scopeRule) };
}
function semantics(policy: PolicyDefinition) {
  // AND conditions and OR rules are unordered; EIP-712 field order is preserved.
  const compare = (a: unknown, b: unknown) => canonicalJson(a).localeCompare(canonicalJson(b));
  return { chain_type: policy.chain_type, version: policy.version, rules: policy.rules.map(({ action, method, conditions }) => ({ action, method, conditions: [...conditions].sort(compare) })).sort(compare) };
}
export function merchantPolicyHash(policy: Policy): Hex {
  return keccak256(toHex(canonicalJson({ owner_id: policy.owner_id, ...semantics(policy) })));
}
export function assertMerchantPolicy(policy: Policy, scopes: MerchantIntentScope | readonly MerchantIntentScope[], ownerId: string, expectedHash: Hex) {
  if (policy.owner_id !== ownerId || canonicalJson(semantics(policy)) !== canonicalJson(semantics(merchantIntentPolicy(scopes))) || merchantPolicyHash(policy) !== expectedHash) throw new Error('merchant_policy_mismatch');
}
export function assertScopedIntent(scope: MerchantIntentScope, typed: ReturnType<typeof intentTypedData>, at: bigint) {
  validateScope(scope);
  const i: Intent = typed.message;
  if (canonicalJson(typed) !== canonicalJson(intentTypedData(i, scope.router))
    || i.signer.toLowerCase() !== scope.merchant.toLowerCase() || i.merchant.toLowerCase() !== scope.merchant.toLowerCase()
    || i.target.toLowerCase() !== scope.target.toLowerCase() || i.dataHash.toLowerCase() !== scope.dataHash.toLowerCase()
    || BigInt(i.amount) !== scope.amount || BigInt(i.feeUSDT) <= 0n || BigInt(i.feeUSDT) > scope.maxFeeUSDT
    || !Number.isSafeInteger(i.maxGas) || i.maxGas <= 0 || i.maxGas > scope.maxGas || BigInt(i.nonce) < 0n || BigInt(i.nonce) >= 2n ** 256n
    || at < scope.validFrom || at >= scope.validUntil || BigInt(i.deadline) <= at + 5n || BigInt(i.deadline) > at + 120n || BigInt(i.deadline) > scope.validUntil) throw new Error('merchant_intent_scope_mismatch');
}
