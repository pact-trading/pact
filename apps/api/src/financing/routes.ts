import type { Context, Hono } from 'hono';
import { isAddress, isHash, type Address, type Hex } from 'viem';
import { IdentityError, type Identity } from '../identity.js';
import { Refusal } from '../types.js';
import type { FinancingService } from './service.js';

type MerchantAuth = { merchantId: string; kind: 'secret' | 'publishable'; address: Address };
const json = (value: unknown) => JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
async function body(c: Context) {
  try {
    const value = await c.req.json();
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new Refusal('invalid_json', 'Expected a JSON object.');
}
/** Transaction hashes a wallet sent for a prepared action, in order. */
function hashes(value: unknown): Hex[] {
  if (!Array.isArray(value) || !value.length || value.length > 4 || !value.every(h => typeof h === 'string' && isHash(h))) throw new Refusal('invalid_transactions', 'Expected the transaction hashes your wallet sent.');
  return value as Hex[];
}

/**
 * Investor and compliance routes. They authenticate a wallet session (EIP-4361), not a merchant:
 * mount them before the merchant middleware.
 */
export function mountFinancingWallets(app: Hono, financing: FinancingService, identity: Identity | undefined) {
  const wallet = async (c: Context): Promise<Address> => {
    c.header('Cache-Control', 'no-store');
    if (!identity) throw new IdentityError('identity_unavailable', 503);
    const header = c.req.header('authorization');
    const user = await identity.authenticate(header?.startsWith('Bearer ') ? header.slice(7) : '');
    if (!isAddress(user.wallet.address)) throw new IdentityError('wallet_required', 403);
    return user.wallet.address as Address;
  };
  app.get('/v1/investor/me', async c => c.json(json(await financing.account(await wallet(c)))));
  app.post('/v1/investor/me/application', async c => {
    const address = await wallet(c);
    return c.json(json(await financing.apply(address, await body(c))));
  });
  app.get('/v1/investor/marketplace', async c => c.json(json(await financing.marketplace(await wallet(c)))));
  app.get('/v1/investor/portfolio', async c => c.json(json(await financing.portfolio(await wallet(c)))));
  app.get('/v1/investor/listings/:invoiceId', async c => c.json(json(await financing.listing(await wallet(c), c.req.param('invoiceId')))));
  app.post('/v1/investor/listings/:invoiceId/purchase', async c => {
    const address = await wallet(c), b = await body(c);
    return c.json(json(await financing.preparePurchase(address, c.req.param('invoiceId'), b.faceMinor)));
  });
  app.post('/v1/investor/listings/:invoiceId/transfer', async c => {
    const address = await wallet(c), b = await body(c);
    return c.json(json(await financing.prepareTransfer(address, c.req.param('invoiceId'), b.to, b.faceMinor)));
  });
  // The investor signed the prepared order (and permit): Pact's relayer submits it and pays the gas.
  app.post('/v1/investor/listings/:invoiceId/purchase/relay', async c => {
    const address = await wallet(c), b = await body(c);
    return c.json(json(await financing.relayPurchase(address, c.req.param('invoiceId'), b)));
  });
  app.post('/v1/investor/listings/:invoiceId/transfer/relay', async c => {
    const address = await wallet(c), b = await body(c);
    return c.json(json(await financing.relayTransfer(address, c.req.param('invoiceId'), b)));
  });
  // The investor's wallet sent the prepared transactions: apply their events, return the listing.
  app.post('/v1/investor/listings/:invoiceId/transactions', async c => {
    const address = await wallet(c), b = await body(c);
    await financing.settle(hashes(b.hashes), address);
    return c.json(json((await financing.listing(address, c.req.param('invoiceId'))).invoice));
  });
  // Cancels the investor's signed orders that have not run (one signature, relayed).
  app.post('/v1/investor/orders/cancel', async c => c.json(json(await financing.prepareCancelOrders(await wallet(c), 'receivables'))));
  app.post('/v1/investor/orders/cancel/relay', async c => {
    const address = await wallet(c), b = await body(c);
    return c.json(json(await financing.relayCancelOrders(address, 'receivables', b)));
  });

  // USDT the contract could not deliver to this wallet: withdrawn with a signature Pact relays.
  app.post('/v1/financing/withdraw', async c => c.json(json(await financing.prepareWithdraw(await wallet(c)))));
  app.post('/v1/financing/withdraw/relay', async c => {
    const address = await wallet(c), b = await body(c);
    return c.json(json(await financing.relayWithdraw(address, b)));
  });

  app.post('/v1/compliance/orders/cancel', async c => c.json(json(await financing.prepareCancelOrders(await wallet(c), 'registry'))));
  app.post('/v1/compliance/orders/cancel/relay', async c => {
    const officer = await wallet(c), b = await body(c);
    return c.json(json(await financing.relayCancelOrders(officer, 'registry', b)));
  });
  app.get('/v1/compliance/registry', async c => c.json(json(await financing.registry(await wallet(c)))));
  app.post('/v1/compliance/investors/:address', async c => {
    const officer = await wallet(c), b = await body(c);
    return c.json(json(await financing.prepareApproval(officer, c.req.param('address'), b.decision)));
  });
  app.post('/v1/compliance/investors/:address/relay', async c => {
    const officer = await wallet(c), b = await body(c);
    return c.json(json(await financing.relayDecision(officer, c.req.param('address'), b)));
  });
  app.post('/v1/compliance/investors/:address/transactions', async c => {
    const officer = await wallet(c), b = await body(c);
    await financing.requireOfficer(officer);
    await financing.settle(hashes(b.hashes), officer);
    return c.json(json(await financing.registryEntry(c.req.param('address'))));
  });
}

/** Merchant routes, behind the merchant middleware (`c.get('auth')`). */
export function mountFinancingMerchant(app: Hono, financing: FinancingService) {
  const auth = (c: Context) => {
    const a = (c as unknown as Context<{ Variables: { auth: MerchantAuth } }>).get('auth');
    if (a.kind !== 'secret') throw new Refusal('secret_key_required');
    return a;
  };
  app.get('/v1/financing', async c => c.json(json(await financing.overview(auth(c).merchantId))));
  app.get('/v1/financing/invoices/:id', async c => c.json(json(await financing.invoice(auth(c).merchantId, c.req.param('id')))));
  // The merchant signs; Pact's relayer submits. A listing and its cancellation cost the merchant
  // nothing; a buy-back pays its holders and its own gas, in USDT.
  app.post('/v1/financing/invoices/:id/list', async c => c.json(json(await financing.prepareList(auth(c), c.req.param('id')))));
  app.post('/v1/financing/invoices/:id/list/relay', async c => c.json(json(await financing.relayList(auth(c), c.req.param('id'), await body(c)))));
  app.post('/v1/financing/invoices/:id/cancel', async c => c.json(json(await financing.prepareCancel(auth(c), c.req.param('id')))));
  app.post('/v1/financing/invoices/:id/cancel/relay', async c => c.json(json(await financing.relayCancel(auth(c), c.req.param('id'), await body(c)))));
  app.post('/v1/financing/invoices/:id/buy-back', async c => c.json(json(await financing.prepareBuyBack(auth(c), c.req.param('id')))));
  app.post('/v1/financing/invoices/:id/buy-back/relay', async c => c.json(json(await financing.relayBuyBack(auth(c), c.req.param('id'), await body(c)))));
}
