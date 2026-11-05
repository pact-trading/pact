import { describe, expect, it, vi } from 'vitest';
import { keccak256, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { APPROVER, ApprovalService } from '../src/approval.js';
import { runKeeper } from '../src/keeper.js';
import { Identities } from '../src/identity.js';
import { WalletIdentity } from '../src/wallet-identity.js';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { createApp } from '../src/app.js';
import { priceWithDiscount, renewalDiscountAmount } from '../src/discounts.js';
import { renewalService } from '../src/renewal-service.js';
import { KeeperRenewals } from '../src/subscriptions-live.js';
import { FundedRenewals } from '../src/funded-renewals.js';
import { IdentityError, type PrivyIdentity } from '../src/identity.js';
import { Indexer } from '../src/indexer.js';
import { accountantExport } from '../src/export.js';

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
function fixture() {
  const db = openDb(), chain = new FakeChain(true), keys = seedMerchant(db, address(11));
  const identity = { async authenticate(token: string) {
    if (token !== 'payer') throw new IdentityError('invalid_identity_token', 401);
    return { userId: 'person-1', sessionId: 'session', expiresAt: Math.floor(Date.now() / 1000) + 300, email: 'buyer@example.test', wallet: { address: address(22), id: null } };
  }, async merchantFor() { throw new IdentityError('merchant_not_registered', 403); } } as unknown as PrivyIdentity;
  const app = createApp({ db, chain, identity, relayer: new Relayer(chain, address(1), allowedTargets(address(2), address(3))) });
  const request = async (path: string, token: string, body?: unknown, key = 'unique') => {
    const result = await app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json() as any };
  };
  const discount = async (data: Record<string, unknown>) => request('/v1/discounts', keys.secretKey, { code: 'SAVE', kind: 'percent', value: '2500', duration: 'once', ...data });
  return { db, chain, keys, request, discount };
}

describe('discounts', () => {
  it('validates codes, prices and limits, including case insensitive uniqueness', async () => {
    const f = fixture();
    expect((await f.discount({})).status).toBe(201);
    expect((await f.discount({ code: 'save' })).body.error.code).toBe('discount_invalid');
    const price = priceWithDiscount(f.db, f.keys.merchantId, 'save', 4_000_000n);
    expect(price).toMatchObject({ net: 3_000_000n, discount: 1_000_000n });
    expect((await f.request('/v1/discounts', f.keys.secretKey)).body.data[0].redemptions).toBe(0);
    expect(() => priceWithDiscount(f.db, f.keys.merchantId, 'missing', 4_000_000n)).toThrowError(/discount_invalid/);
    expect(() => priceWithDiscount(f.db, f.keys.merchantId, 'save', 1_000_000n)).toThrowError(/discount_below_minimum/);
    expect((await f.discount({ code: 'EXPIRED', expiresAt: '2026-11-06T00:00:00Z' })).status).toBe(201);
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-07T00:00:00Z'));
    expect(() => priceWithDiscount(f.db, f.keys.merchantId, 'EXPIRED', 4_000_000n)).toThrowError(/discount_expired/);
    vi.useRealTimers();
    await f.discount({ code: 'FIX', kind: 'fixed', value: '1000001', maxRedemptions: 1 });
    expect(priceWithDiscount(f.db, f.keys.merchantId, 'FIX', 3_000_000n).net).toBe(1_999_999n);
    f.db.prepare("UPDATE discounts SET redemptions=1 WHERE code='FIX'").run();
    expect(() => priceWithDiscount(f.db, f.keys.merchantId, 'FIX', 3_000_000n)).toThrowError(/discount_exhausted/);
    f.db.close();
  });
  it('scopes a code to a chosen mix of products and plans', async () => {
    const f = fixture();
    expect((await f.discount({ code: 'MIX', productIds: ['prod_a', 'plan_b'] })).status).toBe(201);
    expect(priceWithDiscount(f.db, f.keys.merchantId, 'MIX', 4_000_000n, 'prod_a').net).toBe(3_000_000n);
    expect(priceWithDiscount(f.db, f.keys.merchantId, 'MIX', 4_000_000n, 'plan_b').net).toBe(3_000_000n);
    expect(() => priceWithDiscount(f.db, f.keys.merchantId, 'MIX', 4_000_000n, 'plan_other')).toThrowError(/discount_invalid/);
    expect(() => priceWithDiscount(f.db, f.keys.merchantId, 'MIX', 4_000_000n)).toThrowError(/discount_invalid/);
    f.db.close();
  });
  it('uses the discounted amount in checkout and the paid webhook', async () => {
    const f = fixture();
    await f.discount({});
    const product = (await f.request('/v1/commerce/products', f.keys.secretKey, { name: 'Widget', description: '', status: 'active', prices: [{ currency: 'USDT', amountMinor: '4000000' }] })).body;
    const checkout = await f.request('/v1/commerce/checkout-sessions', 'payer', { productId: product.id, rail: 'whitechain', discountCode: 'save' });
    expect(checkout.status).toBe(201);
    expect(checkout.body.order).toMatchObject({ total: { amountMinor: '3000000' }, discountCode: 'SAVE', amountGross: '4.000000', amountDiscount: '1.000000' });
    const paymentId = checkout.body.order.paymentId;
    f.chain.emit({ id: 'paid', txHash: keccak256('0x1234'), contract: 'escrow', name: 'Charged', args: { id: paymentId, amount: 3_000_000n, merchant: address(11), payer: address(22) } });
    f.chain.block += 2n; await new Indexer(f.db, f.chain).poll();
    const event = f.db.prepare("SELECT payload FROM webhook_events WHERE type='order.paid'").get() as { payload: string };
    expect(JSON.parse(event.payload).order).toMatchObject({ discountCode: 'SAVE', amountGross: '4.000000', amountDiscount: '1.000000' });
    expect((await f.request('/v1/discounts', f.keys.secretKey)).body.data[0].redemptions).toBe(1);
    const exported = accountantExport(f.db, f.keys.merchantId, {});
    expect(exported.rows.find(row => row['Payment or Invoice ID'] === paymentId)).toMatchObject({ 'Gross USDT': '4.000000', 'Discount USDT': '1.000000', 'Discount Code': 'SAVE', 'Net USDT': '3.000000' });
    f.db.close();
  });
  it('uses first-period, repeated and full renewal amounts while keeping the full plan cap', async () => {
    const f = fixture();
    f.db.prepare('INSERT INTO plans(id,merchant_id,name,amount_minor,period_seconds,created_at) VALUES (?,?,?,?,?,?)').run('plan', f.keys.merchantId, 'Plan', '5000000', 86400, new Date().toISOString());
    f.db.prepare('INSERT INTO subscriptions(id,merchant_id,plan_id,status,next_charge_at,created_at,amount_discount_minor,discount_duration,discount_periods) VALUES (?,?,?,?,?,?,?,?,?)').run('sub', f.keys.merchantId, 'plan', 'active', new Date().toISOString(), new Date().toISOString(), '1000000', 'repeating', '2');
    expect([1, 2, 3].map(n => renewalDiscountAmount(f.db, 'sub', n))).toEqual([4_000_000n, 4_000_000n, 5_000_000n]);
    f.db.prepare("UPDATE subscriptions SET discount_duration='once' WHERE id='sub'").run();
    expect([1, 2].map(n => renewalDiscountAmount(f.db, 'sub', n))).toEqual([4_000_000n, 5_000_000n]);
    expect(renewalService(f.db, f.chain)).toBeInstanceOf(KeeperRenewals);
    expect(renewalService(f.db, new FakeChain(false, 2))).toBeInstanceOf(FundedRenewals);
    f.db.close();
  });
  it('prices a payment link on the server and records the code with its payment', async () => {
    const f = fixture();
    await f.discount({ code: 'LINK', kind: 'fixed', value: '1000000' });
    const link = await f.request('/v1/payment-links', f.keys.secretKey, { kind: 'product', name: 'Consultation', amount: '4' });
    expect(link.status).toBe(200);
    const payment = await f.request(`/v1/commerce/me/links/${link.body.id}/payments`, 'payer', { discountCode: 'link' });
    expect(payment).toMatchObject({ status: 201, body: { amountMinor: '3000000', discountCode: 'LINK' } });
    const row = f.db.prepare('SELECT amount_minor,metadata FROM payments WHERE id=?').get(payment.body.paymentId) as { amount_minor: string; metadata: string };
    expect(row.amount_minor).toBe('3000000');
    expect(JSON.parse(row.metadata)).toMatchObject({ discountCode: 'LINK', amountGrossMinor: '4000000', amountDiscountMinor: '1000000' });
    expect((await f.request(`/v1/commerce/me/payments/${payment.body.paymentId}`, 'payer')).body).toMatchObject({ discountCode: 'LINK', amountGross: '4.000000', amountDiscount: '1.000000' });
    f.db.close();
  });
  it('refuses each invalid code over HTTP without creating or redeeming anything', async () => {
    const f = fixture();
    await f.discount({ code: 'OLD', expiresAt: '2026-11-06T00:00:00Z' });
    await f.discount({ code: 'SOON', startsAt: '2099-01-01T00:00:00Z' });
    await f.discount({ code: 'USED', maxRedemptions: 1 });
    await f.discount({ code: 'ALL', value: '10000' });
    f.db.prepare("UPDATE discounts SET redemptions=1 WHERE code='USED'").run();
    const product = (await f.request('/v1/commerce/products', f.keys.secretKey, { name: 'Widget', description: '', status: 'active', prices: [{ currency: 'USDT', amountMinor: '4000000' }] })).body;
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-07T00:00:00Z'));
    for (const [code, expected] of [['NOPE', 'discount_invalid'], ['OLD', 'discount_expired'], ['SOON', 'discount_expired'], ['USED', 'discount_exhausted'], ['ALL', 'discount_below_minimum']]) {
      const refused = await f.request('/v1/commerce/checkout-sessions', 'payer', { productId: product.id, rail: 'whitechain', discountCode: code }, `key-${code}`);
      expect(refused.status).toBe(422); expect(refused.body.error.code).toBe(expected);
    }
    vi.useRealTimers();
    expect(f.db.prepare('SELECT count(*) n FROM commerce_orders').get()).toEqual({ n: 0 });
    expect(f.db.prepare("SELECT sum(redemptions) n FROM discounts").get()).toEqual({ n: 1 });
    const malformed = await f.request('/v1/discounts', f.keys.secretKey, []);
    expect(malformed.status).toBe(422);
    expect((await f.request('/v1/discounts', f.keys.publishableKey)).status).toBe(403);
    f.db.close();
  });
  it('charges discounted renewals through the keeper, then the full price, under the full cap', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      for (const [terms, expected, left] of [
        [{ duration: 'repeating', periods: 2 }, [4_000_000n, 4_000_000n, 5_000_000n], 0],
        [{ duration: 'once' }, [4_000_000n, 5_000_000n, 5_000_000n], 0],
        [{ duration: 'forever' }, [4_000_000n, 4_000_000n, 4_000_000n], null],
      ] as const) {
        const start = new Date('2026-11-06T00:00:00.000Z').getTime(), period = 30 * 86_400_000;
        vi.setSystemTime(start);
        const db = openDb(), chain = new FakeChain(true), merchant = privateKeyToAccount(generatePrivateKey()), customer = privateKeyToAccount(generatePrivateKey());
        const keys = seedMerchant(db, merchant.address.toLowerCase());
        const wallet = new WalletIdentity(db, { origin: 'http://localhost:3000' });
        const approval = new ApprovalService(db, chain, { enabled: true, delegate: APPROVER, runtimeHash: keccak256('0x60006000'), escrow: address(2), minimumAmount: 1_000_000n, confirmations: 1n });
        const renewals = new KeeperRenewals(db, chain);
        const app = createApp({ db, chain, relayer: new Relayer(chain, address(1), allowedTargets(address(2), address(3))), approval, renewals, wallet, identity: new Identities(wallet), router: address(1), escrow: address(2), subscription: address(3) });
        const call = async (path: string, token: string, body?: unknown) => {
          const r = await app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
          return { status: r.status, body: await r.json() as any };
        };
        const challenge = (await call('/v1/auth/wallet/nonce', '', {})).body;
        const message = createSiweMessage({ ...challenge, address: customer.address, version: '1', issuedAt: new Date() });
        const token = (await call('/v1/auth/wallet/verify', '', { message, signature: await customer.signMessage({ message }) })).body.token as string;
        chain.approval.state.allowance = 100_000_000n;
        const plan = (await call('/v1/subscriptions/plans', keys.secretKey, { name: 'Plan', amount: '5', periodSeconds: 30 * 86400, maxPeriods: 6 })).body;
        expect((await call('/v1/discounts', keys.secretKey, { code: 'SAVE', kind: 'fixed', value: '1000000', ...terms })).status).toBe(201);
        const ready = (await call(`/v1/commerce/plans/${plan.id}/subscription-intent`, token, {})).body;
        expect(String(ready.mandate.amountCap)).toBe('5000000');
        const signature = await customer.signTypedData({ domain: { ...ready.typedData.domain, chainId: Number(ready.typedData.domain.chainId) }, types: { Mandate: ready.typedData.types.Mandate }, primaryType: 'Mandate', message: ready.typedData.message });
        const created = await call(`/v1/commerce/plans/${plan.id}/subscribe`, token, { mandate: ready.mandate, signature, discountCode: 'save' });
        expect(created).toMatchObject({ status: 201, body: { discountCode: 'SAVE', amountFirstMinor: '4000000' } });
        const renew = vi.spyOn(chain, 'renew');
        for (const [index, amount] of expected.entries()) {
          vi.setSystemTime(start + index * period + 1000);
          await runKeeper(db, chain, new Date(), renewals);
          expect(renew).toHaveBeenCalledTimes(index + 1);
          expect(renew.mock.calls[index][1]).toBe(amount);
          await new Indexer(db, chain).poll();
        }
        const events = (db.prepare("SELECT payload FROM webhook_events WHERE type='subscription.renewed' ORDER BY rowid").all() as { payload: string }[]).map(e => JSON.parse(e.payload));
        expect(events.map(e => e.amountChargedMinor)).toEqual(expected.map(String));
        expect(events[0]).toMatchObject({ discountCode: 'SAVE', amountGross: '5.000000', amountDiscount: '1.000000' });
        expect((await call(`/v1/subscriptions/${created.body.id}`, keys.secretKey)).body).toMatchObject({ status: 'active', periodsCharged: 3, discountCode: 'SAVE', discount: { duration: terms.duration, periods: left } });
        expect(db.prepare('SELECT redemptions FROM discounts').get()).toEqual({ redemptions: 1 });
        db.close();
      }
    } finally { vi.useRealTimers(); }
  });
});
