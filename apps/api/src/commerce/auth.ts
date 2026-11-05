import type { Context } from 'hono';
import type { Address } from 'viem';
import { keyHash, type Db } from '../db.js';
import { IdentityError, type Identity } from '../identity.js';
export const bearer = (c: Context) => c.req.header('authorization')?.match(/^Bearer (.+)$/)?.[1] ?? '';
export async function merchantAuth(c: Context, db: Db, identity?: Identity) {
  const token = bearer(c);
  const key = token ? db.prepare('SELECT k.merchant_id,k.kind,m.address FROM api_keys k JOIN merchants m ON m.id=k.merchant_id WHERE k.hash=? AND k.revoked_at IS NULL').get(keyHash(token)) as { merchant_id: string; kind: string; address: Address } | undefined : undefined;
  if (key) {
    if (key.kind !== 'secret') throw new IdentityError('secret_key_required', 403);
    return { merchantId: key.merchant_id, address: key.address };
  }
  if (!token) throw new IdentityError('login_required', 401);
  if (!identity) throw new IdentityError('identity_unavailable', 503);
  return identity.merchantFor(token);
}
export async function payerAuth(c: Context, identity?: Identity) {
  const token = bearer(c);
  if (!token) throw new IdentityError('login_required', 401);
  if (!identity) throw new IdentityError('identity_unavailable', 503);
  // Verify only; viewing/buying never registers this user as a merchant.
  return identity.authenticate(token);
}
