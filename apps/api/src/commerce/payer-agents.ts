import type { Context, Hono } from 'hono';
import type { Address } from 'viem';
import type { AgentService } from '../agents.js';
import type { Db } from '../db.js';
import { IdentityError, type VerifiedIdentity } from '../identity.js';

/** The customer's agents: create, change limits, revoke (all signed, relayed) and run paid calls. */
export function mountPayerAgents(app: Hono, db: Db, agents: AgentService, payer: (c: Context) => Promise<VerifiedIdentity>) {
  const body = async (c: Context) => { try { const b = await c.req.json(); if (b && typeof b === 'object' && !Array.isArray(b)) return b as Record<string, unknown>; } catch { /* fallthrough */ } throw new IdentityError('invalid_json', 400); };
  const owner = (user: VerifiedIdentity) => user.wallet.address as Address;
  // Merchants this customer has bought from or subscribed to: the ones an agent can be allowed to pay.
  app.get('/me/agent-merchants', async c => {
    const user = await payer(c);
    const rows = db.prepare(`SELECT DISTINCT m.id,m.address,s.brand_name FROM merchants m LEFT JOIN merchant_settings s ON s.merchant_id=m.id
      WHERE m.id IN (SELECT merchant_id FROM commerce_customers WHERE subject_id=? OR lower(wallet)=lower(?))`).all(user.userId, user.wallet.address) as Array<{ id: string; address: string; brand_name: string | null }>;
    return c.json({ data: rows.map(r => ({ id: r.id, address: r.address, name: r.brand_name || 'This business' })) });
  });
  app.get('/me/agents', async c => c.json({ data: await agents.list(owner(await payer(c))) }));
  app.get('/me/agents/:id', async c => c.json(await agents.detail(owner(await payer(c)), c.req.param('id'))));
  app.post('/me/agents/intent', async c => { const user = await payer(c); return c.json(await agents.createIntent(owner(user), await body(c))); });
  app.post('/me/agents', async c => { const user = await payer(c); return c.json(await agents.create(owner(user), user.userId, await body(c)), 201); });
  app.post('/me/agents/:id/limits-intent', async c => c.json(await agents.limitsIntent(owner(await payer(c)), c.req.param('id'), await body(c))));
  app.post('/me/agents/:id/limits', async c => c.json(await agents.setLimits(owner(await payer(c)), c.req.param('id'), await body(c))));
  app.post('/me/agents/:id/revoke-intent', async c => c.json(await agents.revokeIntent(owner(await payer(c)), c.req.param('id'))));
  app.post('/me/agents/:id/revoke', async c => c.json(await agents.revoke(owner(await payer(c)), c.req.param('id'), await body(c))));
  app.post('/me/agents/:id/run', async c => {
    const user = await payer(c), b = await body(c);
    return c.json(await agents.run(owner(user), c.req.param('id'), Number(b.count ?? 1), typeof b.merchantId === 'string' ? b.merchantId : undefined));
  });
}
