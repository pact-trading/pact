import { Hono, type Context } from 'hono';
import type { Address } from 'viem';
import type { Db } from '../db.js';
import { IdentityError, type Identity } from '../identity.js';
import { payerAuth } from '../commerce/auth.js';
import type { PasskeyService } from './service.js';

/**
 * Passkey routes, beside the commerce routes under /v1/commerce:
 * - GET/POST `/me/passkey-account`, POST `/me/passkey-account/options`: the customer's passkey account.
 * - GET/POST `/checkout-sessions/:id/passkey-intent`: the same request/response shape as `/intent`
 *   (`{ data, intent, typedData }` to prepare, `{ data, intent, signature }` to submit), with
 *   `intent.kind: 'passkey'`, a `passkey` WebAuthn request, and the assertion (JSON) as the signature.
 */
export function passkeyRoutes(db: Db, passkeys: PasskeyService, identity?: Identity) {
  const app = new Hono();
  app.use('*', async (c, next) => { c.header('Cache-Control', 'no-store'); await next(); });
  const payer = async (c: Context) => { const user = await payerAuth(c, identity); return { userId: user.userId, email: user.email, wallet: user.wallet.address }; };
  const body = async (c: Context) => {
    try { const b = await c.req.json(); if (b && typeof b === 'object' && !Array.isArray(b)) return b as Record<string, unknown>; } catch { /* fallthrough */ }
    throw new IdentityError('invalid_json', 400);
  };
  const session = async (c: Context) => {
    const user = await payer(c);
    const row = db.prepare(`SELECT o.payment_id,o.merchant_id,m.address FROM commerce_checkout_sessions s JOIN commerce_orders o ON o.id=s.order_id
      JOIN merchants m ON m.id=o.merchant_id WHERE s.id=? AND s.subject_id=?`).get(c.req.param('id'), user.userId) as { payment_id: string | null; merchant_id: string; address: Address } | undefined;
    if (!row?.payment_id) throw new IdentityError('not_found', 404);
    return { user, row: row as { payment_id: string; merchant_id: string; address: Address } };
  };
  app.get('/me/passkey-account', async c => c.json({ account: await passkeys.view((await payer(c)).userId) }));
  app.post('/me/passkey-account/options', async c => c.json(passkeys.registrationOptions(await payer(c))));
  app.post('/me/passkey-account', async c => { const user = await payer(c); return c.json({ account: await passkeys.register(user, await body(c)) }, 201); });
  app.get('/checkout-sessions/:id/passkey-intent', async c => { const { user, row } = await session(c); return c.json(await passkeys.offer(row.payment_id, row.merchant_id, user)); });
  app.post('/checkout-sessions/:id/passkey-intent', async c => {
    const { user, row } = await session(c);
    return c.json(await passkeys.submit(row.payment_id, row.merchant_id, row.address, user, await body(c)));
  });
  return app;
}
