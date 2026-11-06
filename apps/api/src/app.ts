import { availableTrialDays } from './subscription-trials.js';
import { splitPaymentMetadata, storedMetadata, validateCheckoutFields } from './metadata.js';
import { mountMerchantNotifications } from './notifications.js';
import { mountMerchantTelegram, type TelegramConfig } from './telegram.js';
import { initDiscounts, mountDiscounts, priceWithDiscount, redeemDiscount, discountView } from './discounts.js';
import { prepareRefund } from './refund-preparation.js';
import { merchantIdForAddress, recordRefusal } from './refusals.js';
import { acceptanceOffer, acceptTerms, feeLedger, feesDetail, isMerchantSpender, MERCHANT_SPENDERS, merchantPermitTarget, type MerchantSpender } from './fees.js';
import { SponsorshipBudget } from './sponsorship.js';
import { drainRuns, initSecurity, refusalsFeed, runDrain, securityLayers } from './security.js';
import { commerceRoutes } from './commerce/routes.js';
import { initLinksOrders, mountMerchantLinksOrders } from './commerce/links-orders.js';
import { createOpenPayment } from './payment-creation.js';
import { IdentityError, type Identity } from './identity.js';
import type { WalletIdentity } from './wallet-identity.js';
import type { LocalFaucet } from './local-faucet.js';
import type { FinancingService } from './financing/service.js';
import { mountFinancingMerchant, mountFinancingWallets } from './financing/routes.js';
import type { AgentService } from './agents.js';
import type { LiveX402 } from './x402/live.js';
import { checkoutSettings, merchantSettings, updateMerchantSettings, paymentRefundWindow, confirmedPaymentTerms } from './merchant-settings.js';
import { assertSubscriptionAvailable, reserveIntent } from './write-reservations.js';
import { initLivePlans, KeeperRenewals, planRow, planRows, planSummary, subscriptionDetail, subscriptionRows, type Renewals } from './subscriptions-live.js';
import { ApprovalService, USDT } from './approval.js';
import { pendingPaymentIntent } from './payment-state.js';
import { x402Routes, type X402Service } from './x402/routes.js';
import { bindSubscriptions } from './subscription-binding.js';
import { initSubscriptionMandates, readSubscriptionMandate, snapshotSubscriptionMandate } from './subscription-mandates.js';
import { cancellationTypedData, mandateTypedData } from './typed-data.js';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { createHash, randomBytes } from 'node:crypto';
import { decodeFunctionData, encodeAbiParameters, isAddress, keccak256, recoverTypedDataAddress, toHex, type Address, type Hex } from 'viem';
import { escrowAbi, receivablesAbi, subscriptionAbi, FakeChain } from './chain.js';
import type { Db } from './db.js';
import { amountMinor, amountString, id, keyHash, now } from './db.js';
import type { ChainAdapter, IntentRequest, Mandate } from './types.js';
import { Refusal } from './types.js';
import { Relayer } from './relayer.js';
import { enqueueWebhook, replayWebhook } from './webhooks.js';
import { Indexer } from './indexer.js';
import { getDashboardSummary } from './dashboard.js';
import { accountantExport } from './export.js';
import { createInvoice, createInvoiceCheckout, invoiceRow, invoiceView, sendInvoice, validateInvoicePayment } from './invoices.js';
import { cancelReminder, initLiveInvoices, invoiceDetail, manualReminders, scheduleReminder, setCustomerName } from './invoices-live.js';

type Auth = { merchantId: string; kind: 'secret' | 'publishable'; address: Address };
/** Gas Pact budgets for the subscription writes it sends directly and absorbs. */
const SUBSCRIBE_GAS = 300_000n;
const CANCEL_GAS = 150_000n;
type Env = { Variables: { auth: Auth } };
const json = (value: unknown) => JSON.stringify(value, (_, v: unknown) => typeof v === 'bigint' ? v.toString() : v);
const bad = (code: string, message = code, status = 400) => new Response(json({ error: { code, message } }), { status, headers: { 'content-type': 'application/json' } });
const validEmail = (x: unknown) => typeof x === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
const csv = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
export interface AppServices { telegram?: TelegramConfig; renewals?: Renewals; identity?: Identity; wallet?: WalletIdentity; faucet?: LocalFaucet; agents?: AgentService; x402Live?: LiveX402; x402?: X402Service; approval?: ApprovalService; sponsorship?: SponsorshipBudget; db: Db; chain: ChainAdapter; relayer: Relayer; baseUrl?: string; router?: Address; escrow?: Address; subscription?: Address; /** The FeeSchedule merchants sign their terms with. */ fees?: Address; financing?: FinancingService; /** Local fork only: the registry owner the faucet impersonates to appoint test officers. */ registryOwner?: Address }
export function createApp({ telegram, renewals, identity, wallet, faucet, agents, x402Live, x402, db, chain, relayer, approval, sponsorship, financing, registryOwner, baseUrl = 'http://localhost:3001', router = '0x0000000000000000000000000000000000000001', escrow = '0x0000000000000000000000000000000000000002', subscription = '0x0000000000000000000000000000000000000003', fees = '0x0000000000000000000000000000000000000005' }: AppServices) {
  if (renewals && (renewals.chain !== chain || renewals.store.db !== db)) throw new Error('Renewals must share the API database and ChainAdapter/AccountWriter');
  bindSubscriptions(db, subscription);
  initSubscriptionMandates(db);
  chain.writer.bind(db);
  renewals ??= new KeeperRenewals(db, chain);
  initLivePlans(db);
  initLiveInvoices(db);
  initLinksOrders(db);
  initDiscounts(db);
  approval ??= new ApprovalService(db, chain, { enabled: true, escrow, minimumAmount: relayer.minimumAmount > 1_000_000n ? relayer.minimumAmount : 1_000_000n });
  // Pact absorbs the gas of calls that move no money to the merchant, within a budget per merchant.
  sponsorship ??= new SponsorshipBudget(db);
  const budget = sponsorship;
  const usdtPerWbt = async () => (await chain.routerPolicy()).usdtPerWbt;
  relayer.sponsorship = {
    assert: (merchant, costWei, price) => { const merchantId = budget.merchantFor(merchant); if (merchantId) budget.assert(merchantId, costWei, price); },
    record: (merchant, operationId, costWei) => { const merchantId = budget.merchantFor(merchant); if (merchantId) budget.record(operationId, merchantId, costWei, 'intent'); },
  };
  approval.budget = {
    assert: async (merchantId, costWei) => budget.assert(merchantId, costWei, await usdtPerWbt()),
    record: (merchantId, operationId, costWei) => budget.record(operationId, merchantId, costWei, 'approval'),
  };
  /** Budgets a direct write Pact absorbs (subscribe, signed cancel): refuses it when the merchant's budget is spent. */
  const absorbed = async (merchantId: string, gas: bigint) => {
    const cost = gas * await chain.gasPrice();
    budget.assert(merchantId, cost, await usdtPerWbt());
    return (operationId: string, kind: string) => budget.record(operationId, merchantId, cost, kind);
  };
  const merchantSpenders: Record<MerchantSpender, Address> = { escrow, router };
  /** A financed invoice's payment: the claim it pays, or null when it goes to the escrow as usual. */
  const financedRoute = async (paymentId: string) => {
    if (!financing) return null;
    const p = db.prepare('SELECT p.metadata,m.address FROM payments p JOIN merchants m ON m.id=p.merchant_id WHERE p.id=?').get(paymentId) as { metadata: string | null; address: Address } | undefined;
    const invoiceId = p && (JSON.parse(p.metadata ?? '{}') as { invoiceId?: string }).invoiceId;
    return invoiceId ? financing.route(invoiceId, p.address) : null;
  };
  if (financing) {
    approval.receivables = financing.addresses.receivables;
    approval.spenderFor = async paymentId => (await financedRoute(paymentId)) ? financing.addresses.receivables : null;
    // A buy-back is a merchant-signed Router intent: the merchant pays its holders and its gas, in USDT.
    financing.attachSponsorship(absorbed);
    financing.attachIntents({
      router,
      quote: maxGas => relayer.quote(maxGas),
      submit: (request, merchantId) => relayer.submit(request, reserveIntent(db, chain, merchantId, request, 'intent', request.intent.target)),
    });
  }
  relayer.onRefusal = (request, refusal) => {
    const merchantId = merchantIdForAddress(db, request.intent.merchant);
    if (merchantId) recordRefusal(db, { merchantId, objectId: `intent:${request.intent.signer.toLowerCase()}:${request.intent.nonce}`, reason: refusal.code, source: 'relayer', signer: request.intent.signer });
  };
  relayer.isUsed = (signer, nonce) => !!db.prepare('SELECT 1 FROM intents WHERE signer=? AND nonce=? AND tx_hash IS NOT NULL').get(signer.toLowerCase(), nonce.toString());
  initSecurity(db);
  const app = new Hono<Env>();
  app.use('*', cors({ origin: (o) => o ?? '*', allowHeaders: ['authorization', 'content-type', 'idempotency-key'], allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'] }));
  app.onError((e, c) => e instanceof IdentityError ? bad(e.code, e.code, e.status) : c.json({ error: { code: e instanceof Refusal ? e.code : 'internal_error', message: e.message } }, e instanceof Refusal ? 422 : 500));
  app.get('/health', c => c.json({ ok: true, chain_id: 1874, x402: (x402 ?? x402Live?.service)?.facilitator.health() ?? { ready: false } }));
  app.route('/', x402Routes(x402 ?? x402Live?.service));
  // Each merchant's paid API for agents, behind the official x402 middleware (live mode).
  x402Live?.mountPaidApi(app as unknown as Hono);
  const identityToken = (c: Context<Env>) => { const header = c.req.header('authorization'); return header?.startsWith('Bearer ') ? header.slice(7) : ''; };
  app.get('/v1/auth/session', async c => {
    c.header('Cache-Control', 'no-store');
    if (!identity) throw new IdentityError('identity_unavailable', 503);
    return c.json(await identity.authenticate(identityToken(c)));
  });
  app.post('/v1/auth/merchant', async c => {
    c.header('Cache-Control', 'no-store');
    if (!identity) throw new IdentityError('identity_unavailable', 503);
    let body;
    try { body = await c.req.json(); } catch { throw new IdentityError('invalid_identity_request', 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw new IdentityError('invalid_identity_request', 400);
    return c.json(await identity.register(identityToken(c)));
  });
  // Wallet sign-in (EIP-4361): a one-time nonce, then the signed message returns a session token.
  app.post('/v1/auth/wallet/nonce', c => {
    c.header('Cache-Control', 'no-store');
    if (!wallet) throw new IdentityError('identity_unavailable', 503);
    return c.json(wallet.challenge());
  });
  app.post('/v1/auth/wallet/verify', async c => {
    c.header('Cache-Control', 'no-store');
    if (!wallet) throw new IdentityError('identity_unavailable', 503);
    let body;
    try { body = await c.req.json(); } catch { throw new IdentityError('invalid_identity_request', 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new IdentityError('invalid_identity_request', 400);
    const { message, signature, email } = body as Record<string, unknown>;
    return c.json(await wallet.verify(message, signature, { email }));
  });
  app.post('/v1/auth/logout', c => {
    c.header('Cache-Control', 'no-store');
    wallet?.revoke(identityToken(c));
    return c.json({ ok: true });
  });
  // Public: the contracts a browser wallet signs for. Merchants and customers only sign; Pact's relayer sends.
  app.get('/v1/network', c => {
    return c.json({
      chainId: 1874, name: 'Whitechain Sepolia', localFork: !!faucet,
      contracts: { router, escrow, subscription, fees, usdt: USDT,
        receivables: financing?.addresses.receivables ?? null, investorRegistry: financing?.addresses.registry ?? null },
      // Whitechain testnet DEX (Uniswap v3): swap WBT for USDT, paid straight to a recipient.
      dex: { swapRouter: '0xe208cC685cD95D56E8ec6DEC9816476567fc6962', wrappedNative: '0x4200000000000000000000000000000000000006', fee: 3000 },
      faucetUrl: 'https://faucet.testnet.whitechain.io', explorerUrl: 'https://explorer.testnet.whitechain.io',
    });
  });
  // Local fork only: test WBT and USDT for any signed-in user, standing in for the faucet and a DEX swap.
  app.get('/v1/dev/faucet', c => c.json({ available: !!faucet }));
  app.post('/v1/dev/faucet', async c => {
    c.header('Cache-Control', 'no-store');
    if (!faucet) return bad('faucet_unavailable', 'The test faucet only runs on a local fork', 404);
    if (!identity) throw new IdentityError('identity_unavailable', 503);
    await identity.authenticate(identityToken(c));
    let body: Record<string, unknown>;
    try { body = await c.req.json(); } catch { return bad('invalid_request'); }
    return c.json(await faucet.fund(body.address, { wbt: body.wbt, usdt: body.usdt }));
  });
  // Local fork only: make the signed-in wallet a compliance officer of the investor registry, so the
  // compliance screens can be tried. On the testnet the registry owner appoints officers.
  app.post('/v1/dev/compliance-officer', async c => {
    c.header('Cache-Control', 'no-store');
    if (!faucet || !financing || !registryOwner) return bad('faucet_unavailable', 'Test officers only exist on a local fork', 404);
    if (!identity) throw new IdentityError('identity_unavailable', 503);
    const user = await identity.authenticate(identityToken(c));
    const hash = await faucet.appointOfficer(financing.addresses.registry, registryOwner, user.wallet.address as Address);
    await financing.settle([hash]);
    return c.json({ officer: user.wallet.address.toLowerCase(), txHash: hash });
  });
  if (financing) mountFinancingWallets(app as unknown as Hono, financing, identity);
  else {
    // Not deployed on this network: say so (the web shows the demo), rather than an unknown route.
    const unavailable = () => bad('financing_unavailable', 'Invoice financing is not deployed on this network', 501);
    for (const path of ['/v1/financing', '/v1/financing/*', '/v1/investor/*', '/v1/compliance/*']) app.all(path, unavailable);
  }
  app.route('/v1/commerce', commerceRoutes({ telegram, db, identity, chain, approval, relayer, router, escrow, minimumAmount: relayer.minimumAmount, baseUrl, submitIntent,
    agents, financing,
    subscriptions: { subscription, register: (b, auth, customerSubjectId) => registerSubscription(b, auth, customerSubjectId), cancel: (row, b, auth) => cancelBySignature(row, b, auth), replace: (oldId, b, auth) => relayReplace(oldId, b, { ...auth, kind: 'secret' }) } }));
  app.use('/v1/*', async (c, next) => {
    const header = c.req.header('authorization');
    const key = header?.startsWith('Bearer ') ? header.slice(7) : '';
    const row = key && db.prepare('SELECT k.merchant_id,k.kind,m.address FROM api_keys k JOIN merchants m ON m.id=k.merchant_id WHERE k.hash=? AND k.revoked_at IS NULL').get(keyHash(key)) as { merchant_id: string; kind: 'secret' | 'publishable'; address: Address } | undefined;
    if (!row) {
      if (identity && key && identity.handles(key)) {
        c.header('Cache-Control', 'no-store');
        c.set('auth', await identity.merchantFor(key));
        return next();
      }
      return c.json({ error: { code: 'unauthorized' } }, 401);
    }
    const allowedPublic = (c.req.method === 'POST' && (/^\/v1\/(payments|intents|subscriptions)$/.test(c.req.path) || /^\/v1\/subscriptions\/[\w-]+\/(cancel|replace)$/.test(c.req.path))) || (c.req.method === 'GET' && (/^\/v1\/(payments|payment-links)\/[\w-]+$/.test(c.req.path) || c.req.path === '/v1/config' || c.req.path === '/v1/fees/preview' || /^\/v1\/subscriptions\/(plans(?:\/[\w-]+)?|nonce\/0x[0-9a-fA-F]{40})$/.test(c.req.path)));
    if (row.kind === 'publishable' && !allowedPublic) return c.json({ error: { code: 'secret_key_required' } }, 403);
    c.set('auth', { merchantId: row.merchant_id, kind: row.kind, address: row.address });
    await next();
  });
  mountDiscounts(app as unknown as Hono, db, c => (c as unknown as Context<Env>).get('auth').merchantId);
  mountMerchantNotifications(app as unknown as Hono, db, c => (c as unknown as Context<Env>).get('auth').merchantId, !!telegram);
  mountMerchantTelegram(app as unknown as Hono, db, telegram, c => (c as unknown as Context<Env>).get('auth').merchantId);
  app.get('/v1/dashboard', async c => c.json(await getDashboardSummary(db, chain, c.get('auth'))));
  app.get('/v1/fees/preview', async c => {
    c.header('Cache-Control', 'no-store');
    const value = c.req.query('maxGas') ?? '300000';
    if (!/^[1-9]\d{0,6}$/.test(value)) return bad('gas_limit', 'Invalid target gas', 422);
    try { return c.json(await relayer.quote(Number(value))); }
    catch (error) { return error instanceof Refusal ? bad(error.code, error.code, 422) : bad('fee_preview_unavailable', 'Fee preview is unavailable', 503); }
  });
  async function mutation(c: Context<Env>, handler: (body: Record<string, unknown>, auth: Auth) => Promise<unknown> | unknown) {
    const auth = c.get('auth');
    let body: Record<string, unknown>;
    try { body = await c.req.json(); if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error(); }
    catch { return bad('invalid_json'); }
    const route = c.req.path;
    const key = c.req.header('idempotency-key');
    const hash = createHash('sha256').update(json(body)).digest('hex');
    if (key) {
      if (key.length > 255) return bad('invalid_idempotency_key');
      const old = db.prepare('SELECT * FROM idempotency WHERE merchant_id=? AND route=? AND key=?').get(auth.merchantId, route, key) as { request_hash: string; response_json: string } | undefined;
      if (old) return old.request_hash === hash ? c.json(JSON.parse(old.response_json)) : bad('idempotency_conflict', 'Key reused with different request', 409);
    }
    try {
      const result = handler(body, auth);
      // Synchronous DB mutations must publish their idempotency response before yielding.
      const response = result instanceof Promise ? await result : result;
      if (key) db.prepare('INSERT INTO idempotency VALUES (?,?,?,?,?)').run(auth.merchantId, route, key, hash, json(response));
      return c.json(response);
    } catch (e) { return bad(e instanceof Refusal ? e.code : 'invalid_request', e instanceof Error ? e.message : String(e), e instanceof Refusal ? 422 : 400); }
  }
  app.post('/v1/payments', c => mutation(c, (b, auth) => {
    const amount = amountMinor(b.amount);
    const { control, custom } = splitPaymentMetadata(b.metadata);
    const linkId = control.paymentLinkId;
    if (linkId !== undefined) {
      const link = db.prepare('SELECT status FROM payment_links WHERE id=? AND merchant_id=?').get(linkId, auth.merchantId) as { status: string } | undefined;
      if (!link || link.status !== 'active') throw new Refusal('payment_link_inactive');
    }
    const paymentId = `0x${randomBytes(32).toString('hex')}`;
    const expiry = b.expires_in === undefined ? null : new Date(Date.now() + Number(b.expires_in) * 1000).toISOString();
    if (b.expires_in !== undefined && (!Number.isInteger(b.expires_in) || Number(b.expires_in) <= 0)) throw new Error('Invalid expiry');
    db.transaction(() => {
      const invoiceId = control.invoiceId;
      if (invoiceId !== undefined) {
        if (auth.kind !== 'secret') throw new Refusal('secret_key_required');
        validateInvoicePayment(db, auth.merchantId, invoiceId, amount);
      }
      createOpenPayment(db, { id: paymentId, merchantId: auth.merchantId, amount, description: b.description as string | undefined, email: b.email as string | undefined, metadata: control, customMetadata: custom, expiresAt: expiry });
    })();
    return { id: paymentId, amount: amountString(amount), currency: 'USDT', status: 'pending', financialStatus: 'open', checkoutUrl: `${baseUrl}/pay/${paymentId}`, refundWindowSeconds: paymentRefundWindow(db, paymentId) };
  }));
  app.get('/v1/payments/:id/approval', async c => c.json(await approval!.get(c.req.param('id'), c.get('auth').merchantId, c.req.query('payer') as Address)));
  // Approval deduplication is durable and stateful; generic idempotency response
  // caching would hide receipt progress, so use the attempt's identity instead.
  app.post('/v1/payments/:id/approval', async c => {
    let body: Record<string, unknown>;
    try { body = await c.req.json(); if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('invalid_json'); }
    catch { return bad('invalid_json'); }
    try { return c.json(await approval!.submit(c.req.param('id'), c.get('auth').merchantId, body)); }
    catch (e) { return bad(e instanceof Refusal ? e.code : 'approval_unavailable', e instanceof Refusal ? e.code : 'Approval is unavailable', e instanceof Refusal ? 422 : 503); }
  });
  app.get('/v1/settings', c => c.json(merchantSettings(db, c.get('auth').merchantId)));
  app.post('/v1/settings', c => mutation(c, (b, auth) => updateMerchantSettings(db, auth.merchantId, b)));
  app.get('/v1/config', c => c.json({ chainId: 1874, merchant: c.get('auth').address, router, escrow, subscription, fees, checkout: checkoutSettings(db, c.get('auth').merchantId) }));
  const paymentLink = (row: Record<string, string | number | null>) => ({ id: row.id, kind: row.kind, name: row.name, amount: row.amount_minor === null ? null : amountString(row.amount_minor), periodSeconds: row.period_seconds === null ? null : Number(row.period_seconds), status: row.status, visits: Number(row.visits), createdAt: row.created_at, url: `${baseUrl}/l/${row.id}` });
  app.post('/v1/payment-links', c => mutation(c, (b, auth) => {
    if (b.kind !== 'product' && b.kind !== 'tip') throw new Error('Only product and tip payment links are supported; use a plan subscribe URL for subscriptions');
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (!name || name.length > 200) throw new Error('Enter a name under 200 characters');
    const amount = b.kind === 'tip' ? null : amountMinor(b.amount).toString();
    const checkoutFields = validateCheckoutFields(b.checkoutFields);
    const linkId = id('link');
    const description = typeof b.description === 'string' && b.description.trim() ? b.description.trim().slice(0, 500) : null;
    const expires = typeof b.expiresOn === 'string' && b.expiresOn ? new Date(`${b.expiresOn}T23:59:59Z`) : null;
    if (expires && !Number.isFinite(expires.getTime())) throw new Error('Invalid expiry date');
    db.prepare('INSERT INTO payment_links(id,merchant_id,kind,name,amount_minor,period_seconds,status,visits,created_at,description,single_use,expires_at,checkout_fields) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(linkId, auth.merchantId, b.kind, name, amount, null, 'active', 0, now(), description, b.singleUse ? 1 : 0, expires?.toISOString() ?? null, JSON.stringify(checkoutFields));
    return paymentLink(db.prepare('SELECT * FROM payment_links WHERE id=?').get(linkId) as Record<string, string | number | null>);
  }));
  mountMerchantLinksOrders(app as unknown as Hono, db, baseUrl, c => (c as unknown as Context<Env>).get('auth'));
  app.get('/v1/payment-links', c => c.json({ data: (db.prepare("SELECT * FROM payment_links WHERE merchant_id=? AND kind IN ('product','tip') ORDER BY created_at DESC").all(c.get('auth').merchantId) as Array<Record<string, string | number | null>>).map(paymentLink) }));
  app.get('/v1/payment-links/:id', c => {
    const row = db.prepare('SELECT * FROM payment_links WHERE id=? AND merchant_id=?').get(c.req.param('id'), c.get('auth').merchantId) as Record<string, string | number | null> | undefined;
    if (!row) return bad('payment_link_not_found', 'Payment link not found', 404);
    if (row.kind === 'subscription' || row.status !== 'active') return bad('payment_link_inactive', 'Payment link is inactive', 410);
    db.prepare('UPDATE payment_links SET visits=visits+1 WHERE id=?').run(row.id);
    return c.json(paymentLink({ ...row, visits: Number(row.visits) + 1 }));
  });
  app.post('/v1/payment-links/:id/deactivate', c => {
    const result = db.prepare("UPDATE payment_links SET status='inactive' WHERE id=? AND merchant_id=?").run(c.req.param('id'), c.get('auth').merchantId);
    if (!result.changes) return bad('payment_link_not_found', 'Payment link not found', 404);
    return c.json({ id: c.req.param('id'), status: 'inactive' });
  });
  app.get('/v1/payments', c => {
    const rows = db.prepare('SELECT * FROM payments WHERE merchant_id=? ORDER BY created_at DESC LIMIT 100').all(c.get('auth').merchantId) as Array<Record<string, string>>;
    return c.json({ data: rows.map(p => ({ id: p.id, amount: amountString(p.amount_minor), currency: 'USDT', description: p.description, customer: p.customer, payer: p.payer, status: p.status, txHash: p.tx_hash, createdAt: p.created_at, metadata: storedMetadata(p.custom_metadata) })) });
  });
  app.get('/v1/payments/:id', c => {
    const p = db.prepare('SELECT * FROM payments WHERE id=? AND merchant_id=?').get(c.req.param('id'), c.get('auth').merchantId) as Record<string, string> | undefined;
    if (!p) return bad('not_found', 'Payment not found', 404);
    return c.json({ id: p.id, amount: amountString(p.amount_minor), currency: 'USDT', description: p.description, customer: p.customer, payer: p.payer, createdAt: p.created_at, merchant: c.get('auth').address, ...(c.get('auth').kind === 'publishable' ? {} : { metadata: storedMetadata(p.custom_metadata) }), status: p.status === 'captured' || p.status === 'partially_refunded' ? 'succeeded' : p.status === 'refunded' ? 'refunded' : p.status === 'failed' || p.status === 'voided' || p.status === 'expired' ? 'failed' : 'pending', financialStatus: p.status, captured: amountString(p.captured_minor), refunded: amountString(p.refunded_minor), txHash: p.tx_hash, refundWindowSeconds: paymentRefundWindow(db, p.id), refundDeadline: p.refund_deadline, ...confirmedPaymentTerms(db, p.id), checkout: checkoutSettings(db, c.get('auth').merchantId) });
  });
  app.get('/v1/refunds', c => c.json({ data: (db.prepare('SELECT r.*,p.customer FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.merchant_id=? ORDER BY r.created_at DESC LIMIT 100').all(c.get('auth').merchantId) as Array<Record<string, string>>).map(r => ({ id: r.id, paymentId: r.payment_id, amount: amountString(r.amount_minor), customer: r.customer, reason: r.reason, status: r.status, txHash: r.tx_hash, createdAt: r.created_at })) }));
  app.get('/v1/refusals', (c, next) => c.req.query('expand') !== 'detail' ? next() : c.json({ data: refusalsFeed(db, c.get('auth').merchantId, Number(c.req.query('limit') ?? '100') || 100) }));
  app.get('/v1/agents/paid-endpoints', c => c.json({ data: agents ? agents.paidEndpoints(c.get('auth').merchantId) : [] }));
  app.get('/v1/agents/overview', async c => agents ? c.json(await agents.merchantOverview(c.get('auth').merchantId)) : bad('agents_unavailable', 'Agents are not configured', 404));
  app.get('/v1/agents/calls/:id', async c => agents ? c.json(await agents.trace(c.get('auth').merchantId, c.req.param('id'))) : bad('agents_unavailable', 'Agents are not configured', 404));
  app.get('/v1/agents/calls', c => c.json({ data: agents ? agents.merchantCalls(c.get('auth').merchantId, Number(c.req.query('limit') ?? '50') || 50) : [] }));
  app.get('/v1/agents/facilitator', c => {
    const f = x402Live?.facilitator;
    return c.json({ url: `${new URL(baseUrl).protocol}//${c.req.header('host') ?? 'localhost:3001'}`, network: 'eip155:1874', asset: USDT, schemes: ['exact', 'upto'], status: f?.health().ready ? 'online' : 'unconfigured', ...(f?.counters ?? { verified: 0, settled: 0, refused: 0, failed: 0 }) });
  });
  app.get('/v1/security/layers', c => c.json({ data: securityLayers(db, c.get('auth').merchantId) }));
  app.get('/v1/security/drain-runs', c => c.json({ data: drainRuns(db, c.get('auth').merchantId) }));
  app.post('/v1/security/drain-runs', c => mutation(c, (_b, auth) => runDrain(db, chain, relayer, auth, { router, escrow })));
  app.get('/v1/refusals', c => c.json({ data: db.prepare("SELECT id,object_id AS objectId,reason,tx_hash AS txHash,created_at AS createdAt FROM refusal_attempts WHERE merchant_id=? UNION ALL SELECT id,signer AS objectId,reason,tx_hash AS txHash,created_at AS createdAt FROM intents WHERE merchant_id=? AND status='refused' AND NOT EXISTS (SELECT 1 FROM refusal_attempts r WHERE lower(r.tx_hash)=lower(intents.tx_hash)) ORDER BY createdAt DESC LIMIT 100").all(c.get('auth').merchantId, c.get('auth').merchantId) }));
  app.post('/v1/payments/:id/refund-intent', async c => {
    let body; try { body = await c.req.json(); } catch { throw new IdentityError('invalid_json', 400); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new IdentityError('invalid_json', 400);
    return c.json(await prepareRefund(db, relayer, router, escrow, c.req.param('id'), c.get('auth'), body));
  });
  app.post('/v1/payments/:id/refund', c => mutation(c, async (b, auth) => {
    const p = db.prepare('SELECT * FROM payments WHERE id=? AND merchant_id=?').get(c.req.param('id'), auth.merchantId) as Record<string, string> | undefined;
    if (!p) throw new Error('Payment not found');
    const remaining = BigInt(p.captured_minor) - BigInt(p.refunded_minor) - (db.prepare("SELECT amount_minor FROM refunds WHERE payment_id=? AND status='pending'").all(p.id) as Array<{ amount_minor: string }>).reduce((n, r) => n + BigInt(r.amount_minor), 0n);
    const amount = b.amount === undefined ? remaining : amountMinor(b.amount);
    if (amount <= 0n || amount > remaining) { db.prepare('INSERT INTO refusal_attempts (id,merchant_id,object_id,reason,tx_hash,created_at) VALUES (?,?,?,?,?,?)').run(id('refusal'), auth.merchantId, p.id, 'refund_limit', null, now()); throw new Refusal('refund_limit'); }
    const { refundDeadlineUnix } = confirmedPaymentTerms(db, p.id);
    const closed = refundDeadlineUnix !== null ? BigInt(refundDeadlineUnix) === 0n || BigInt(refundDeadlineUnix) < BigInt(Math.floor(Date.now() / 1000)) : p.refund_deadline && new Date(p.refund_deadline).getTime() < Date.now();
    if (closed) { db.prepare('INSERT INTO refusal_attempts (id,merchant_id,object_id,reason,tx_hash,created_at) VALUES (?,?,?,?,?,?)').run(id('refusal'), auth.merchantId, p.id, 'refund_window_closed', null, now()); throw new Refusal('refund_window_closed'); }
    if (!b.intent || !b.signature || !b.data) throw new Refusal('signed_intent_required');
    const request = normalizeIntent(b as unknown as IntentRequest);
    if (request.intent.merchant.toLowerCase() !== auth.address.toLowerCase()) throw new Refusal('merchant_mismatch');
    let decoded: { functionName: string; args?: readonly unknown[] };
    try { decoded = decodeFunctionData({ abi: escrowAbi, data: request.data }); } catch { throw new Refusal('invalid_refund_call'); }
    if (request.intent.target.toLowerCase() !== escrow.toLowerCase() || request.intent.signer.toLowerCase() !== auth.address.toLowerCase() || request.intent.amount !== amount || decoded.functionName !== 'refund' || String(decoded.args?.[0]).toLowerCase() !== p.id.toLowerCase() || BigInt(String(decoded.args?.[1])) !== amount) throw new Refusal('refund_call_mismatch');
    if (db.prepare('SELECT 1 FROM intents WHERE signer=? AND nonce=?').get(request.intent.signer.toLowerCase(), request.intent.nonce.toString())) throw new Refusal('replay');
    const refundId = id('ref');
    // No await between computing remaining funds and atomically reserving them.
    const operation = reserveIntent(db, chain, auth.merchantId, request, 'refund', p.id, { refundId }, () => {
      db.prepare('INSERT INTO refunds VALUES (?,?,?,?,?,?,?)').run(refundId, p.id, amount.toString(), b.reason ?? null, 'pending', null, now());
    });
    const hash = await relayer.submit(request, operation);
    if (chain instanceof FakeChain && chain.autoSettle) await new Indexer(db, chain).poll();
    return { id: refundId, paymentId: p.id, status: 'pending', txHash: hash };
  }));
  app.post('/v1/invoices', c => mutation(c, (b, auth) => {
    const { customerName, ...input } = b;
    const created = createInvoice(db, auth.merchantId, input, baseUrl);
    setCustomerName(db, created.id as string, customerName);
    return c.req.query('expand') === 'detail' ? invoiceDetail(db, invoiceRow(db, auth.merchantId, created.id as string), baseUrl) : created;
  }));
  // Live mode: number, customer name, acknowledgement, reminder schedule and activity.
  app.get('/v1/invoices', (c, next) => c.req.query('expand') !== 'detail' ? next() : c.json({ data: (db.prepare('SELECT * FROM invoices WHERE merchant_id=? ORDER BY created_at DESC LIMIT 200').all(c.get('auth').merchantId) as Array<Record<string, string | number | null>>).map(row => invoiceDetail(db, row, baseUrl)) }));
  app.get('/v1/invoices/:id', (c, next) => c.req.query('expand') !== 'detail' ? next() : c.json(invoiceDetail(db, invoiceRow(db, c.get('auth').merchantId, c.req.param('id')), baseUrl)));
  app.post('/v1/invoices/:id/remind', c => mutation(c, (b, auth) => {
    scheduleReminder(db, auth.merchantId, c.req.param('id'), { message: b.message, sendAt: null });
    return invoiceDetail(db, invoiceRow(db, auth.merchantId, c.req.param('id')), baseUrl);
  }));
  app.get('/v1/invoices/:id/reminders', c => c.json({ data: manualReminders(db, c.get('auth').merchantId, c.req.param('id')) }));
  app.post('/v1/invoices/:id/reminders', c => mutation(c, (b, auth) => scheduleReminder(db, auth.merchantId, c.req.param('id'), b)));
  app.post('/v1/invoices/:id/reminders/:reminderId/cancel', c => mutation(c, (_b, auth) => cancelReminder(db, auth.merchantId, c.req.param('id'), c.req.param('reminderId'))));
  app.get('/v1/invoices', c => c.json({ data: (db.prepare('SELECT * FROM invoices WHERE merchant_id=? ORDER BY created_at DESC LIMIT 100').all(c.get('auth').merchantId) as Array<Record<string, string | number | null>>).map(row => invoiceView(db, row, baseUrl)) }));
  app.get('/v1/invoices/:id', c => {
    try { return c.json(invoiceView(db, invoiceRow(db, c.get('auth').merchantId, c.req.param('id')), baseUrl)); }
    catch (error) { if (error instanceof Refusal && error.code === 'invoice_not_found') return bad(error.code, 'Invoice not found', 404); throw error; }
  });
  app.post('/v1/invoices/:id/send', c => mutation(c, (_b, auth) => sendInvoice(db, auth.merchantId, c.req.param('id'), baseUrl)));
  app.post('/v1/invoices/:id/payments', c => mutation(c, (b, auth) => createInvoiceCheckout(db, auth.merchantId, c.req.param('id'), b, baseUrl)));
  if (financing) {
    mountFinancingMerchant(app as unknown as Hono, financing);
    // The original listing route: the listing the merchant signs, relayed by /v1/financing/invoices/:id/list/relay.
    app.post('/v1/invoices/:id/list', async c => c.json(await financing.prepareList(c.get('auth'), c.req.param('id'))));
  } else app.post('/v1/invoices/:id/list', c => bad('financing_unavailable', 'Invoice financing is not connected to the separate receivables contract', 501));
  app.post('/v1/subscriptions/plans', c => mutation(c, (b, auth) => {
    const amount = amountMinor(b.amount);
    const period = Number(b.periodSeconds ?? (Number(b.period_days) * 86400));
    if (!Number.isSafeInteger(period) || period <= 0) throw new Error('Invalid period');
    const max = b.maxPeriods ?? b.max_periods ?? null;
    if (max !== null && (!Number.isSafeInteger(max) || Number(max) <= 0)) throw new Error('Invalid max periods');
    const trialDays = b.trialDays === undefined || b.trialDays === '' ? 0 : b.trialDays;
    if (typeof trialDays !== 'number' || !Number.isInteger(trialDays) || trialDays < 0 || trialDays > 365) throw new Refusal('invalid_trial_days', 'Free trial must be 0 to 365 days');
    const planId = id('plan');
    const name = String(b.name ?? 'Plan');
    const description = typeof b.description === 'string' ? b.description.slice(0, 2000) : '';
    db.prepare('INSERT INTO plans(id,merchant_id,name,amount_minor,period_seconds,max_periods,created_at,description,trial_days) VALUES (?,?,?,?,?,?,?,?,?)').run(planId, auth.merchantId, name, amount.toString(), period, max, now(), description, trialDays);
    return planSummary(db, planRow(db, planId)!);
  }));
  app.get('/v1/subscriptions/plans', c => c.json({ data: planRows(db, c.get('auth').merchantId).map(p => planSummary(db, p)) }));
  for (const [action, status] of [['archive', 'archived'], ['restore', 'active']] as const)
    app.post(`/v1/subscriptions/plans/:id/${action}`, c => mutation(c, (_b, auth) => {
      // Archived plans keep their subscribers and renewals; they take no new signups.
      const changed = db.prepare('UPDATE plans SET status=?,archived_at=? WHERE id=? AND merchant_id=?').run(status, status === 'archived' ? now() : null, c.req.param('id'), auth.merchantId);
      if (!changed.changes) throw new Refusal('plan_not_found');
      return planSummary(db, planRow(db, c.req.param('id'), auth.merchantId)!);
    }));
  app.get('/v1/subscriptions/plans/:id', c => {
    const plan = planRow(db, c.req.param('id'), c.get('auth').merchantId);
    if (!plan) return bad('plan_not_found', 'Plan not found', 404);
    return c.json(planSummary(db, plan));
  });
  app.get('/v1/subscriptions/nonce/:payer', async c => isAddress(c.req.param('payer')) ? c.json({ nonce: (await chain.mandateNonce(c.req.param('payer') as Address)).toString() }) : bad('invalid_address'));
  app.get('/v1/subscriptions/:id', (c, next) => {
    if (['plans', 'nonce'].includes(c.req.param('id'))) return next();
    const row = subscriptionRows(db, 'id=? AND merchant_id=?', c.req.param('id'), c.get('auth').merchantId)[0];
    return row ? c.json(subscriptionDetail(db, row)) : bad('subscription_not_found', 'Subscription not found', 404);
  });
  app.get('/v1/subscriptions', (c, next) => c.req.query('expand') === 'detail'
    ? c.json({ data: subscriptionRows(db, 'merchant_id=?', c.get('auth').merchantId).map(r => subscriptionDetail(db, r)) })
    : next());
  app.get('/v1/subscriptions', c => c.json({ data: (db.prepare('SELECT s.*,p.name,p.amount_minor,p.period_seconds,p.max_periods FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.merchant_id=? ORDER BY s.created_at DESC LIMIT 100').all(c.get('auth').merchantId) as Array<Record<string, string>>).map(s => ({ id: s.id, chainId: s.chain_id, payer: s.payer, planId: s.plan_id, plan: s.name, amount: amountString(s.amount_minor), periodSeconds: Number(s.period_seconds), maxPeriods: s.max_periods, status: s.status, trialEndsAt: s.trial_ends_at ?? null, nextChargeAt: s.next_charge_at, createdAt: s.created_at })) }));
  app.get('/v1/subscriptions/:id/mandate', c => {
    c.header('Cache-Control', 'no-store');
    const subscriptionId = c.req.param('id');
    const sub = db.prepare('SELECT status FROM subscriptions WHERE id=? AND merchant_id=?').get(subscriptionId, c.get('auth').merchantId) as { status: string } | undefined;
    if (!sub) return bad('subscription_not_found', 'Subscription not found', 404);
    const snapshot = readSubscriptionMandate(db, subscriptionId);
    if (!snapshot) return bad('mandate_snapshot_unavailable', 'Original signed terms are unavailable', 409);
    // Signatures remain in the private audit store. The terms endpoint does not
    // confer background authority or mark an unconfirmed registration active.
    const { payerSignature: _payerSignature, ...terms } = snapshot;
    return new Response(json({ subscriptionId, status: sub.status, ...terms }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  });
  async function validateSubscription(b: Record<string, unknown>, auth: Auth) {
    const plan = db.prepare('SELECT * FROM plans WHERE id=? AND merchant_id=?').get(b.planId, auth.merchantId) as Record<string, string> | undefined;
    if (!plan) throw new Refusal('plan_not_found');
    const raw = b.mandate as Record<string, unknown> | undefined;
    if (!raw || typeof b.signature !== 'string') throw new Refusal('signed_mandate_required');
    let mandate: Mandate;
    try { mandate = { payer: raw.payer as Address, merchant: raw.merchant as Address, planId: raw.planId as Hex, amountCap: BigInt(String(raw.amountCap)), periodSeconds: BigInt(String(raw.periodSeconds)), maxPeriods: Number(raw.maxPeriods), endTime: BigInt(String(raw.endTime)), nonce: BigInt(String(raw.nonce)) }; }
    catch { throw new Refusal('invalid_mandate'); }
    const expectedPlan = keccak256(toHex(plan.id));
    if (!isAddress(mandate.payer) || mandate.merchant.toLowerCase() !== auth.address.toLowerCase() || mandate.planId !== expectedPlan || mandate.amountCap !== BigInt(plan.amount_minor) || mandate.periodSeconds !== BigInt(plan.period_seconds) || mandate.maxPeriods <= 0 || (plan.max_periods && mandate.maxPeriods > Number(plan.max_periods)) || mandate.endTime <= BigInt(Math.floor(Date.now() / 1000))) throw new Refusal('mandate_mismatch');
    let signer: Address;
    try { signer = await recoverTypedDataAddress({ ...mandateTypedData(mandate, subscription), signature: b.signature as Hex }); }
    catch { throw new Refusal('invalid_signature'); }
    if (signer.toLowerCase() !== mandate.payer.toLowerCase()) throw new Refusal('invalid_signature');
    return { plan, mandate };
  }
  app.post('/v1/subscriptions', c => mutation(c, (b, auth) => registerSubscription(b, auth)));
  async function registerSubscription(b: Record<string, unknown>, auth: Auth, customerSubjectId?: string) {
    const { plan, mandate } = await validateSubscription(b, auth);
    const price = priceWithDiscount(db, auth.merchantId, b.discountCode, BigInt(plan.amount_minor), plan.id);
    const chainId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'address' }], [mandate.payer, mandate.nonce, subscription]));
    if (db.prepare('SELECT 1 FROM subscriptions WHERE chain_id=?').get(chainId)) throw new Refusal('mandate_replay');
    const subId = id('sub');
    let trialEndsAt: string | null = null;
    const operation = { id: subId, kind: 'subscribe' as const, objectId: subId, links: { subscriptionId: subId, merchantId: auth.merchantId } };
    // Registering moves no money: Pact pays its gas, within the merchant's sponsorship budget.
    const spend = await absorbed(auth.merchantId, SUBSCRIBE_GAS);
    chain.writer.reserve(operation, () => {
      if (db.prepare('SELECT 1 FROM subscriptions WHERE chain_id=?').get(chainId)) throw new Refusal('mandate_replay');
      const trialDays = availableTrialDays(db, plan.id, auth.merchantId, mandate.payer, Number(plan.trial_days), customerSubjectId);
      trialEndsAt = trialDays > 0 ? new Date(Date.now() + trialDays * 86_400_000).toISOString() : null;
      db.prepare('INSERT INTO subscriptions(id,merchant_id,plan_id,chain_id,payer,status,next_charge_at,retry_count,pending_tx_hash,created_at,trial_ends_at,trial_customer_subject_id,discount_code,amount_gross_minor,amount_discount_minor,discount_duration,discount_periods) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(subId, auth.merchantId, plan.id, chainId, mandate.payer.toLowerCase(), 'pending', trialEndsAt ?? now(), 0, null, now(), trialEndsAt, customerSubjectId ?? (db.prepare('SELECT subject_id FROM commerce_customers WHERE merchant_id=? AND lower(wallet)=lower(?) LIMIT 1').get(auth.merchantId, mandate.payer) as { subject_id: string } | undefined)?.subject_id ?? null, price.code, price.gross.toString(), price.discount.toString(), price.duration, price.periods);
      redeemDiscount(db, auth.merchantId, price.code);
      snapshotSubscriptionMandate(db, subId, { manager: subscription, mandate, payerSignature: b.signature as Hex });
    });
    const txHash = await chain.subscribe(mandate, b.signature as Hex, operation);
    spend(operation.id, 'subscribe');
    if (chain instanceof FakeChain && chain.autoSettle) { chain.emit({ id: `${txHash}:subscribe`, txHash, contract: 'subscription', name: 'Subscribed', args: { id: chainId, payer: mandate.payer, merchant: auth.address, planId: mandate.planId } }); chain.block += 2n; await new Indexer(db, chain).poll(); }
    return { id: subId, chainId, status: chain instanceof FakeChain && chain.autoSettle ? (trialEndsAt ? 'trialing' : 'active') : 'pending', trialEndsAt, txHash, ...discountView(price.gross.toString(), price.discount.toString(), price.code), amountFirstMinor: price.net.toString() };
  }
  app.post('/v1/subscriptions/:id/replace', c => mutation(c, (b, auth) => relayReplace(c.req.param('id'), b, auth)));
  /** Relays a payer-signed replace intent: the new mandate and the old one's cancellation, atomically. */
  async function relayReplace(oldId: string, b: Record<string, unknown>, auth: Auth) {
    const old = db.prepare('SELECT * FROM subscriptions WHERE id=? AND merchant_id=?').get(oldId, auth.merchantId) as Record<string, string> | undefined;
    if (!old) throw new Refusal('subscription_not_found');
    const request = normalizeIntent(b as unknown as IntentRequest);
    const existing = db.prepare(`SELECT i.*,r.old_id,r.new_id,s.plan_id FROM intents i
      JOIN subscription_replacements r ON r.intent_id=i.id JOIN subscriptions s ON s.id=r.new_id
      WHERE i.signer=? AND i.nonce=?`).get(request.intent.signer.toLowerCase(), request.intent.nonce.toString()) as Record<string, string> | undefined;
    if (existing) {
      if (existing.merchant_id !== auth.merchantId || existing.old_id !== old.id || existing.plan_id !== b.planId || canonicalIntent(JSON.parse(existing.request_json)) !== canonicalIntent(request)) throw new Refusal('replay');
      const replacement = db.prepare('SELECT * FROM subscriptions WHERE id=?').get(existing.new_id) as Record<string, string>;
      return { id: replacement.id, chainId: replacement.chain_id, replaces: old.id, status: existing.status, txHash: existing.tx_hash };
    }
    if (!['trialing', 'active', 'past_due', 'paused'].includes(old.status)) throw new Refusal('subscription_unavailable');
    assertSubscriptionAvailable(db, old.id);
    let call: { functionName: string; args?: readonly unknown[] };
    try { call = decodeFunctionData({ abi: subscriptionAbi, data: request.data }); } catch { throw new Refusal('replace_mismatch'); }
    if (call.functionName !== 'replace' || String(call.args![0]).toLowerCase() !== old.chain_id.toLowerCase() || request.intent.signer.toLowerCase() !== old.payer.toLowerCase() || request.intent.target.toLowerCase() !== subscription.toLowerCase() || request.intent.merchant.toLowerCase() !== auth.address.toLowerCase()) throw new Refusal('replace_mismatch');
    const { plan, mandate } = await validateSubscription({ planId: b.planId, mandate: call.args![1], signature: call.args![2] }, auth);
    if (mandate.payer.toLowerCase() !== old.payer.toLowerCase() || request.intent.amount !== mandate.amountCap) throw new Refusal('replace_mismatch');
    const chainId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'address' }], [mandate.payer, mandate.nonce, subscription]));
    const subId = id('sub');
    const current = db.prepare('SELECT status FROM subscriptions WHERE id=?').get(old.id) as { status: string };
    if (!['trialing', 'active', 'past_due', 'paused'].includes(current.status)) throw new Refusal('subscription_unavailable');
    const operation = reserveIntent(db, chain, auth.merchantId, request, 'replace', old.id, { subscriptionId: old.id, replacementSubscriptionId: subId, previousSubscriptionStatus: current.status }, intentId => {
      assertSubscriptionAvailable(db, old.id);
      if (db.prepare('SELECT 1 FROM subscriptions WHERE chain_id=?').get(chainId)) throw new Refusal('mandate_replay');
      db.prepare('INSERT INTO subscriptions(id,merchant_id,plan_id,chain_id,payer,status,next_charge_at,created_at,trial_ends_at,trial_customer_subject_id) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(subId, auth.merchantId, plan.id, chainId, mandate.payer.toLowerCase(), 'pending', old.status === 'trialing' ? old.trial_ends_at : now(), now(), old.status === 'trialing' ? old.trial_ends_at : null, old.trial_customer_subject_id ?? null);
      snapshotSubscriptionMandate(db, subId, { manager: subscription, mandate, payerSignature: call.args![2] as Hex });
      db.prepare('INSERT INTO subscription_replacements VALUES (?,?,?)').run(intentId, old.id, subId);
      if (old.status === 'trialing') db.prepare("INSERT OR IGNORE INTO reminders(invoice_id,stage,created_at) SELECT ?,stage,created_at FROM reminders WHERE invoice_id=? AND stage='trial_will_end'").run(subId, old.id);
    });
    const txHash = await relayer.submit(request, operation);
    if (chain instanceof FakeChain && chain.autoSettle) {
      chain.mandateNonces.set(mandate.payer.toLowerCase(), mandate.nonce + 1n);
      chain.emit({ id: `${txHash}:subscribe`, txHash, contract: 'subscription', name: 'Subscribed', args: { id: chainId, payer: mandate.payer, merchant: auth.address, planId: mandate.planId } });
      chain.emit({ id: `${txHash}:cancel`, txHash, contract: 'subscription', name: 'Cancelled', args: { id: old.chain_id } });
      chain.emit({ id: `${txHash}:replace`, txHash, contract: 'subscription', name: 'Replaced', args: { oldId: old.chain_id, newId: chainId } });
      chain.block += 2n; await new Indexer(db, chain).poll();
    }
    return { id: subId, chainId, replaces: old.id, status: 'submitted', txHash };
  }
  app.get('/v1/subscriptions/:id/renewal', c => {
    c.header('Cache-Control', 'no-store');
    const sub = db.prepare('SELECT id FROM subscriptions WHERE id=? AND merchant_id=?').get(c.req.param('id'), c.get('auth').merchantId) as { id: string } | undefined;
    if (!sub) return bad('subscription_not_found', 'subscription_not_found', 404);
    return c.json({ id: sub.id, ...renewals.status(sub.id) });
  });
  app.post('/v1/subscriptions/:id/renew', c => mutation(c, async (_b, auth) => {
    const s = db.prepare('SELECT s.*,p.amount_minor FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.id=? AND s.merchant_id=?').get(c.req.param('id'), auth.merchantId) as Record<string, string> | undefined;
    if (!s) throw new Refusal('subscription_not_found');
    // The contract decides: an early, cancelled or over-cap pull is refused on chain with its reason.
    const result = await renewals.renew(s.id, { force: true });
    const outcome = await renewalOutcome(s.id, result.txHash!);
    return { id: s.id, status: outcome.refusal ? 'refused' : outcome.charged ? 'charged' : 'submitted', txHash: result.txHash, refusal: outcome.refusal, subscription: subscriptionDetail(db, subscriptionRows(db, 'id=?', s.id)[0]) };
  }));
  app.post('/v1/subscriptions/:id/cancel', c => mutation(c, async (b, auth) => {
    const s = db.prepare('SELECT * FROM subscriptions WHERE id=? AND merchant_id=?').get(c.req.param('id'), auth.merchantId) as Record<string, string> | undefined;
    if (!s) throw new Refusal('subscription_not_found');
    if (b.by === 'merchant' && auth.kind !== 'secret') throw new Refusal('secret_key_required');
    if (s.status === 'cancelled') throw new Refusal('cancelled');
    if (b.by === 'merchant') {
      db.transaction(() => {
        assertSubscriptionAvailable(db, s.id);
        db.prepare("UPDATE subscriptions SET status='cancelled',cancelled_at=?,cancelled_by='merchant' WHERE id=?").run(now(), s.id);
        enqueueWebhook(db, auth.merchantId, 'subscription.cancelled', s.id, { cancelled_by: 'merchant' });
      })();
      return { id: s.id, status: 'cancelled', cancelledAt: (db.prepare('SELECT cancelled_at FROM subscriptions WHERE id=?').get(s.id) as { cancelled_at: string }).cancelled_at, cancelledBy: 'merchant' };
    }
    return cancelBySignature(s, b, auth);
  }));
  /**
   * The payer's signed cancellation (EIP-712 `Cancel`), submitted by Pact's relayer: the payer needs no
   * gas and the merchant pays nothing. Used by the merchant API and the customer portal.
   */
  async function cancelBySignature(s: Record<string, string>, b: Record<string, unknown>, auth: { merchantId: string; address: Address }) {
    if (!s.chain_id || s.status === 'cancelled') throw new Refusal('subscription_unavailable');
    let deadline: bigint;
    try { deadline = BigInt(String(b.deadline)); } catch { throw new Refusal('invalid_cancellation'); }
    const current = BigInt(Math.floor(Date.now() / 1000));
    if (deadline < current || deadline > current + 300n || typeof b.signature !== 'string') throw new Refusal('invalid_cancellation');
    let signer: Address;
    try { signer = await recoverTypedDataAddress({ ...cancellationTypedData(s.chain_id as Hex, deadline, subscription), signature: b.signature as Hex }); }
    catch { throw new Refusal('invalid_signature'); }
    if (signer.toLowerCase() !== s.payer.toLowerCase()) throw new Refusal('invalid_signature');
    const spend = await absorbed(auth.merchantId, CANCEL_GAS);
    const operation = { id: id('cancel'), kind: 'cancel' as const, objectId: s.id, links: { subscriptionId: s.id, merchantId: auth.merchantId } };
    chain.writer.reserve(operation, () => assertSubscriptionAvailable(db, s.id));
    const txHash = await chain.cancelSigned(s.chain_id as Hex, deadline, b.signature as Hex, operation);
    spend(operation.id, 'cancel');
    if (chain instanceof FakeChain && chain.autoSettle) await new Indexer(db, chain).poll();
    return { id: s.id, status: 'submitted', txHash };
  }
  /** Waits (1-second blocks) until the indexer has seen the renewal transaction's charge or refusal. */
  async function renewalOutcome(subscriptionId: string, txHash: Hex, seconds = 30) {
    for (let i = 0; i < seconds * 2; i++) {
      if (chain instanceof FakeChain && chain.autoSettle) await new Indexer(db, chain).poll();
      const refusal = db.prepare('SELECT reason FROM refusal_attempts WHERE object_id=? AND lower(tx_hash)=lower(?)').get(subscriptionId, txHash) as { reason: string } | undefined;
      if (refusal) return { refusal: refusal.reason, charged: false };
      if (db.prepare("SELECT 1 FROM accounting_entries WHERE lower(tx_hash)=lower(?) AND kind='Subscription'").get(txHash)) return { refusal: null, charged: true };
      await new Promise(r => setTimeout(r, 500));
    }
    return { refusal: null, charged: false };
  }
  app.post('/v1/intents', c => mutation(c, submitIntent));
  async function submitIntent(b: Record<string, unknown>, auth: { merchantId: string; address: Address }) {
    const request = normalizeIntent(b as unknown as IntentRequest);
    if (request.intent.merchant.toLowerCase() !== auth.address.toLowerCase()) throw new Refusal('merchant_mismatch');
    if (request.intent.amount < relayer.minimumAmount) throw new Refusal('dust');
    const existing = db.prepare('SELECT id,merchant_id,request_json,status,tx_hash FROM intents WHERE signer=? AND nonce=?').get(request.intent.signer.toLowerCase(), request.intent.nonce.toString()) as { id: string; merchant_id: string; request_json: string; status: string; tx_hash: string | null } | undefined;
    if (existing) {
      // A Router nonce is global to the payer. It is not a merchant-scoped
      // idempotency key: only the same merchant and exact signed request may
      // recover its result, including after the payment has been captured.
      if (existing.merchant_id !== auth.merchantId || canonicalIntent(JSON.parse(existing.request_json)) !== canonicalIntent(request)) throw new Refusal('replay');
      return { id: existing.id, status: existing.status, txHash: existing.tx_hash };
    }
    let chargePaymentId: string | undefined;
    let chargeSubscription: Record<string, string> | undefined;
    if (request.intent.target.toLowerCase() === escrow.toLowerCase()) {
      let call: { functionName: string; args?: readonly unknown[] };
      try { call = decodeFunctionData({ abi: escrowAbi, data: request.data }); } catch { throw new Refusal('wrong_selector'); }
      if (call.functionName === 'refund') throw new Refusal('use_refund_endpoint');
      if (['charge', 'chargeInvoice', 'authorize'].includes(call.functionName)) {
        chargePaymentId = String(call.args![0]);
        const p = db.prepare('SELECT * FROM payments WHERE id=? AND merchant_id=?').get(String(call.args![0]), auth.merchantId) as Record<string, string> | undefined;
        if (!p || !['open', 'failed'].includes(p.status) || BigInt(String(call.args![2])) !== BigInt(p.amount_minor) || String(call.args![1]).toLowerCase() !== auth.address.toLowerCase() || request.intent.amount !== BigInt(p.amount_minor)) throw new Refusal('payment_mismatch');
        // The invoice rate is for invoices the merchant sent, and every invoice pays at it.
        const invoice = !!(JSON.parse(p.metadata ?? '{}') as { invoiceId?: string }).invoiceId;
        if ((call.functionName === 'chargeInvoice') !== invoice) throw new Refusal('payment_mismatch', invoice ? 'Invoice payments use chargeInvoice' : 'Only invoice payments use chargeInvoice');
        const window = paymentRefundWindow(db, p.id);
        if (window !== null && BigInt(String(call.args![call.functionName === 'authorize' ? 4 : 3])) !== BigInt(window)) throw new Refusal('refund_window_mismatch');
        // A financed invoice is paid to the receivables contract, which pays the investors: never the escrow.
        if (await financedRoute(p.id)) throw new Refusal('invoice_financed');
      }
    }
    if (financing && request.intent.target.toLowerCase() === financing.addresses.receivables.toLowerCase()) {
      let call: { functionName: string; args?: readonly unknown[] };
      try { call = decodeFunctionData({ abi: receivablesAbi, data: request.data }); } catch { throw new Refusal('wrong_selector'); }
      if (call.functionName !== 'pay') throw new Refusal('wrong_selector');
      chargePaymentId = String(call.args![1]);
      const p = db.prepare('SELECT * FROM payments WHERE id=? AND merchant_id=?').get(chargePaymentId, auth.merchantId) as Record<string, string> | undefined;
      if (!p || !['open', 'failed'].includes(p.status) || BigInt(String(call.args![2])) !== BigInt(p.amount_minor) || request.intent.amount !== BigInt(p.amount_minor)) throw new Refusal('payment_mismatch');
      const route = await financedRoute(p.id);
      if (!route || route.claimId !== BigInt(String(call.args![0]))) throw new Refusal('claim_mismatch');
      financing.checkPayment(route.claimId, BigInt(String(call.args![2])), request.intent.signer);
    }
    if (request.intent.target.toLowerCase() === subscription.toLowerCase()) {
      const call = decodeFunctionData({ abi: subscriptionAbi, data: request.data });
      if (call.functionName === 'cancel') throw new Refusal('use_cancel_endpoint');
      if (call.functionName === 'replace') throw new Refusal('use_replace_endpoint');
      if (call.functionName === 'charge') {
        chargeSubscription = db.prepare('SELECT * FROM subscriptions WHERE chain_id=? AND merchant_id=?').get(String(call.args![0]), auth.merchantId) as Record<string, string> | undefined;
        if (!chargeSubscription) throw new Refusal('subscription_not_found');
        if (chargeSubscription.status === 'cancelled') throw new Refusal('cancelled');
        if (chargeSubscription.trial_ends_at && Date.parse(chargeSubscription.trial_ends_at) > Date.now()) throw new Refusal('too_early');
      }
    }
    const operation = reserveIntent(db, chain, auth.merchantId, request, 'intent', chargeSubscription?.id ?? chargePaymentId ?? request.intent.target, chargeSubscription ? { subscriptionId: chargeSubscription.id, previousSubscriptionStatus: chargeSubscription.status } : {}, () => {
      if (chargeSubscription) assertSubscriptionAvailable(db, chargeSubscription.id);
      if (chargePaymentId) {
        const p = db.prepare('SELECT * FROM payments WHERE id=? AND merchant_id=?').get(chargePaymentId, auth.merchantId) as Record<string, string> | undefined;
        if (!p || !['open', 'failed'].includes(p.status)) throw new Refusal('payment_not_open');
        if (p.expires_at && new Date(p.expires_at).getTime() <= Date.now()) throw new Refusal('payment_expired');
        if (p.payer && p.payer.toLowerCase() !== request.intent.signer.toLowerCase()) throw new Refusal('payer_mismatch');
        if (pendingPaymentIntent(db, chargePaymentId, escrow, financing?.addresses.receivables)) throw new Refusal('payment_pending');
        db.prepare('UPDATE payments SET payer=? WHERE id=?').run(request.intent.signer.toLowerCase(), chargePaymentId);
      }
    });
    const intentId = operation.id;
    const hash = await relayer.submit(request, operation);
    if (chain instanceof FakeChain && chain.autoSettle) await new Indexer(db, chain).poll();
    return { id: intentId, status: 'submitted', txHash: hash };
  }
  // Fees: the terms the merchant signed, its standing permits, and every fee Pact took.
  app.get('/v1/fees', async c => c.json(await feesDetail(db, chain, approval!, c.get('auth'), merchantSpenders)));
  app.get('/v1/fees/ledger', c => {
    const limit = Number(c.req.query('limit') ?? '50');
    return c.json({ data: feeLedger(db, c.get('auth').merchantId, Number.isInteger(limit) ? limit : 50) });
  });
  app.get('/v1/fees/terms', async c => { c.header('Cache-Control', 'no-store'); return c.json(await acceptanceOffer(chain, fees, c.get('auth'))); });
  app.post('/v1/fees/terms/accept', c => mutation(c, (b, auth) => {
    if (auth.kind !== 'secret') throw new Refusal('secret_key_required');
    return acceptTerms(chain, fees, auth, b, budget);
  }));
  app.get('/v1/fees/permits/:spender', async c => {
    c.header('Cache-Control', 'no-store');
    const spender = c.req.param('spender');
    if (!isMerchantSpender(spender)) return bad('unknown_spender', `Expected one of ${MERCHANT_SPENDERS.join(', ')}`, 404);
    return c.json(await approval!.getFor(merchantPermitTarget(c.get('auth'), spender, merchantSpenders)));
  });
  // Permit progress is durable per spender; the attempt identity, not idempotency caching, dedupes it.
  app.post('/v1/fees/permits/:spender', async c => {
    const spender = c.req.param('spender'), auth = c.get('auth');
    if (!isMerchantSpender(spender)) return bad('unknown_spender', `Expected one of ${MERCHANT_SPENDERS.join(', ')}`, 404);
    if (auth.kind !== 'secret') return bad('secret_key_required', 'secret_key_required', 403);
    let body: Record<string, unknown>;
    try { body = await c.req.json(); if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('invalid_json'); }
    catch { return bad('invalid_json'); }
    try { return c.json(await approval!.submitFor(merchantPermitTarget(auth, spender, merchantSpenders), body)); }
    catch (e) { return bad(e instanceof Refusal ? e.code : 'approval_unavailable', e instanceof Refusal ? e.message : 'Approval is unavailable', e instanceof Refusal ? 422 : 503); }
  });
  app.get('/v1/export', c => {
    try {
      const report = accountantExport(db, c.get('auth').merchantId, { from: c.req.query('from'), to: c.req.query('to'), format: c.req.query('format') });
      if (c.req.query('format') === 'csv') return c.body(report.csv, 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="settle-export.csv"' });
      const { csv: _csv, ...data } = report;
      return c.json(data);
    } catch (error) {
      if (error instanceof Refusal) return bad(error.code, error.message, error.code === 'accounting_backfill_required' ? 409 : 400);
      throw error;
    }
  });
  app.post('/v1/webhooks/config', c => mutation(c, b => {
    if (typeof b.url !== 'string') throw new Error('Webhook URL required');
    const url = new URL(b.url);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Webhook URL must use HTTPS');
    const secret = `whsec_${randomBytes(24).toString('hex')}`;
    db.prepare('UPDATE merchants SET webhook_url=?,webhook_secret=? WHERE id=?').run(url.toString(), secret, c.get('auth').merchantId);
    return { url: url.toString(), signingSecret: secret };
  }));
  app.post('/v1/webhooks/test', c => c.json({ eventId: enqueueWebhook(db, c.get('auth').merchantId, 'webhook.test', id('test')) }));
  app.get('/v1/webhooks/events', c => c.json({ data: db.prepare('SELECT id,type,object_id,created_at FROM webhook_events WHERE merchant_id=? ORDER BY created_at DESC LIMIT 100').all(c.get('auth').merchantId) }));
  app.get('/v1/webhooks/deliveries', c => c.json({ data: db.prepare('SELECT id,event_id,attempt,status,next_at,last_http_status,last_error,delivered_at FROM webhook_deliveries WHERE merchant_id=? ORDER BY next_at DESC LIMIT 100').all(c.get('auth').merchantId) }));
  app.post('/v1/webhooks/events/:id/replay', c => replayWebhook(db, c.get('auth').merchantId, c.req.param('id')) ? c.json({ queued: true }) : bad('not_found', 'Event not found', 404));
  app.post('/v1/api-keys', c => mutation(c, b => {
    if (b.kind !== 'publishable' && b.kind !== 'secret') throw new Error('Invalid key kind');
    const key = `${b.kind === 'secret' ? 'sk' : 'pk'}_test_${randomBytes(24).toString('hex')}`;
    const keyId = id('key');
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, 80) : '';
    db.prepare('INSERT INTO api_keys(id,merchant_id,kind,hash,created_at,revoked_at,name) VALUES (?,?,?,?,?,NULL,?)').run(keyId, c.get('auth').merchantId, b.kind, keyHash(key), now(), name);
    return { id: keyId, kind: b.kind, key, name };
  }));
  // The key itself is never stored; the list shows its kind and name only.
  app.get('/v1/api-keys', c => c.json({ data: db.prepare('SELECT id,name,kind,created_at AS createdAt,revoked_at AS revokedAt FROM api_keys WHERE merchant_id=? ORDER BY created_at DESC').all(c.get('auth').merchantId) }));
  app.get('/v1/preferences', c => {
    const row = db.prepare('SELECT brand_color FROM merchant_preferences WHERE merchant_id=?').get(c.get('auth').merchantId) as { brand_color: string } | undefined;
    return c.json({ brandColor: row?.brand_color ?? '#c8f169' });
  });
  app.post('/v1/preferences', c => mutation(c, (b, auth) => {
    if (Object.keys(b).some(k => k !== 'brandColor')) throw new Refusal('unexpected_field', 'Only brandColor can be set');
    const current = db.prepare('SELECT brand_color FROM merchant_preferences WHERE merchant_id=?').get(auth.merchantId) as { brand_color: string } | undefined;
    const brandColor = b.brandColor === undefined ? current?.brand_color ?? '#c8f169' : String(b.brandColor);
    if (!/^#[0-9a-f]{6}$/i.test(brandColor)) throw new Refusal('invalid_brand_color');
    db.prepare('INSERT INTO merchant_preferences VALUES (?,?,?) ON CONFLICT(merchant_id) DO UPDATE SET brand_color=excluded.brand_color,updated_at=excluded.updated_at').run(auth.merchantId, brandColor.toLowerCase(), now());
    return { brandColor: brandColor.toLowerCase() };
  }));
  app.post('/v1/api-keys/:id/revoke', c => { db.prepare('UPDATE api_keys SET revoked_at=? WHERE id=? AND merchant_id=?').run(now(), c.req.param('id'), c.get('auth').merchantId); return c.json({ revoked: true }); });
  return app;
}
function normalizeIntent(input: IntentRequest): IntentRequest {
  if (!input || !input.intent || !input.signature || !input.data) throw new Refusal('invalid_intent');
  const i = input.intent;
  try { return { signature: input.signature, data: input.data, intent: { signer: i.signer, merchant: i.merchant, target: i.target, dataHash: i.dataHash, amount: BigInt(i.amount), nonce: BigInt(i.nonce), deadline: BigInt(i.deadline), maxGas: Number(i.maxGas) } }; }
  catch { throw new Refusal('invalid_intent'); }
}
function canonicalIntent(input: IntentRequest): string {
  return JSON.stringify(normalizeIntent(input), (_, value: unknown) => typeof value === 'bigint' ? value.toString() : typeof value === 'string' && value.startsWith('0x') ? value.toLowerCase() : value);
}
