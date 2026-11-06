// Isolated Playwright API. Never imported by production. Uses the real commerce
// routes/SQLite/indexer; only Privy's network boundary and chain are fixtures.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { openDb, seedMerchant } from '../src/db.js';
import { createApp } from '../src/app.js';
import { FakeChain } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { IdentityError, type PrivyIdentity } from '../src/identity.js';
import { updateMerchantSettings } from '../src/merchant-settings.js';
import { Indexer } from '../src/indexer.js';
import type { Address, Hex } from 'viem';
const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
function fixture() {
  const db = openDb(), chain = new FakeChain();
  const owners = { merchant_a: seedMerchant(db, address(10)), merchant_b: seedMerchant(db, address(11)) };
  for (const [name, owner] of Object.entries(owners)) updateMerchantSettings(db, owner.merchantId, { brandName: name === 'merchant_a' ? 'Merchant A' : 'Merchant B' });
  const identity = {
    async authenticate(token: string) {
      const subject = /^fixture\.(merchant_a|merchant_b|payer|other)\.signature$/.exec(token)?.[1];
      if (!subject) throw new IdentityError('invalid_identity_token', 401);
      return { userId: `did:privy:${subject}`, sessionId: subject, expiresAt: Math.floor(Date.now() / 1000) + 3600, email: `${subject}@example.test`, wallet: { address: address(subject === 'merchant_a' ? 10 : subject === 'merchant_b' ? 11 : subject === 'payer' ? 12 : 13), id: subject } };
    },
    async merchantFor(token: string) { const user = await this.authenticate(token), owner = owners[user.sessionId as keyof typeof owners]; if (!owner) throw new IdentityError('merchant_not_registered', 403); return { ...owner, address: user.wallet.address, kind: 'secret' as const }; },
    async register(token: string) { return this.merchantFor(token); },
  };
  const app = createApp({ db, chain, identity: identity as unknown as PrivyIdentity, baseUrl: 'http://127.0.0.1:3150', relayer: new Relayer(chain, address(1), allowedTargets({ escrow: address(2), subscription: address(3) })) });
  return { db, chain, app };
}
let current = fixture(), sequence = 0;
const server = new Hono();
server.get('/__commerce/state', c => c.json({ hasOrders: Boolean(current.db.prepare('SELECT 1 FROM commerce_orders LIMIT 1').get()) }));
server.get('/health', c => c.json({ ok: true }));
server.post('/__commerce/reset', c => { current.db.close(); current = fixture(); sequence = 0; return c.json({ ok: true }); });
server.post('/__commerce/confirm', async c => {
  const { orderId, refundMinor } = await c.req.json();
  const row = current.db.prepare('SELECT * FROM commerce_orders WHERE id=?').get(orderId) as { payment_id: string; amount_minor: string };
  if (!row) return c.json({ error: 'missing fixture order' }, 404);
  const txHash = `0x${(++sequence).toString(16).padStart(64, '0')}` as Hex;
  current.chain.emit({ id: `fixture-${sequence}`, txHash, contract: 'escrow', name: refundMinor ? 'Refunded' : 'Charged', args: { id: row.payment_id, amount: BigInt(refundMinor ?? row.amount_minor), payer: address(12) } });
  current.chain.block += 2n; await new Indexer(current.db, current.chain).poll();
  return c.json({ ok: true });
});
server.all('*', c => current.app.fetch(c.req.raw));
serve({ fetch: server.fetch, port: 3152, hostname: '127.0.0.1' });
