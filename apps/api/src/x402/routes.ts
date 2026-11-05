import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Permit2Facilitator } from './facilitator.js';

export interface X402Service {
  facilitator: Permit2Facilitator;
  /** Merchant secret authentication bound to requirements.payTo, using root's API key store. */
  authorize(request: Request, payTo: string): Promise<boolean>;
}
export function x402Routes(service?: X402Service) {
  const app = new Hono();
  app.use('/verify', bodyLimit({ maxSize: 32_768 }));
  app.use('/settle', bodyLimit({ maxSize: 32_768 }));
  app.get('/supported', c => c.json(service?.facilitator.getSupported() ?? { kinds: [], networks: [], extensions: [], signers: {} }));
  app.get('/metrics', c => c.json(service?.facilitator.counters ?? { status: 'unconfigured' }));
  app.get('/health', c => c.json(service?.facilitator.health() ?? { ready: false }, service?.facilitator.health().ready ? 200 : 503));
  for (const method of ['verify', 'settle'] as const) app.post(`/${method}`, async c => {
    if (!service) return c.json({ error: 'x402_not_activated' }, 501);
    let body;
    try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
    if (!body?.paymentPayload || !body?.paymentRequirements || typeof body.paymentRequirements.payTo !== 'string') return c.json({ error: 'invalid_request' }, 400);
    if (!await service.authorize(c.req.raw, body.paymentRequirements.payTo)) return c.json({ error: 'unauthorized' }, 401);
    return c.json(await service.facilitator[method](body.paymentPayload, body.paymentRequirements));
  });
  return app;
}
