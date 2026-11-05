import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { createSiweMessage } from 'viem/siwe';
import { encodeFunctionData, type Hex } from 'viem';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain, escrowAbi } from '../src/chain.js';
import { createApp } from '../src/app.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { Identities } from '../src/identity.js';
import { WalletIdentity } from '../src/wallet-identity.js';

const router = '0x0000000000000000000000000000000000000001', escrow = '0x0000000000000000000000000000000000000002', subscription = '0x0000000000000000000000000000000000000003';
function fixture() {
  const db = openDb(), chain = new FakeChain(true);
  const keys = seedMerchant(db, '0x00000000000000000000000000000000000000aa');
  const wallet = new WalletIdentity(db, { origin: 'http://localhost:3000', allowLocalEmail: true });
  const app = createApp({ db, chain, wallet, identity: new Identities(wallet), relayer: new Relayer(chain, router, allowedTargets(escrow, subscription)), router, escrow, subscription });
  const call = async (path: string, token: string, body?: unknown) => {
    const r = await app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  const signIn = async (account: PrivateKeyAccount, email: string) => {
    const challenge = (await call('/v1/auth/wallet/nonce', '', {})).body;
    const message = createSiweMessage({ ...challenge, address: account.address, version: '1', issuedAt: new Date() });
    return (await call('/v1/auth/wallet/verify', '', { message, signature: await account.signMessage({ message }), email })).body.token as string;
  };
  return { db, keys, call, signIn };
}

describe('invoices in live mode', () => {
  it('numbers invoices, shows them only to the addressed customer, and stores a signed acknowledgement', async () => {
    const f = fixture(), payer = privateKeyToAccount(generatePrivateKey());
    const due = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const created = (await f.call('/v1/invoices?expand=detail', f.keys.secretKey, { customerEmail: 'client@acme.test', customerName: 'Jordan Lee', dueAt: due, lines: [{ description: 'Website audit', quantity: 2, unitAmount: '500' }] })).body;
    expect(created).toMatchObject({ number: 'INV-0001', customerName: 'Jordan Lee', amount: '1000.000000', status: 'sent', acknowledgement: null });
    expect(created.reminders.map((r: { stage: string }) => r.stage)).toEqual(['seven_days', 'one_day', 'overdue']);

    const token = await f.signIn(payer, 'Client@Acme.test');
    const stranger = await f.signIn(privateKeyToAccount(generatePrivateKey()), 'someone@else.test');
    expect((await f.call('/v1/commerce/me/invoices', token)).body.data.map((i: { id: string }) => i.id)).toEqual([created.id]);
    expect((await f.call('/v1/commerce/me/invoices', stranger)).body.data).toHaveLength(0);
    expect((await f.call(`/v1/commerce/me/invoices/${created.id}`, stranger)).status).toBe(404);
    expect((await f.call(`/v1/commerce/invoices/${created.id}/brand`, '')).status).toBe(200);

    const typed = (await f.call(`/v1/commerce/me/invoices/${created.id}/acknowledgement`, token)).body;
    const message = { ...typed.message, amount: BigInt(typed.message.amount), dueAt: BigInt(typed.message.dueAt) };
    const wrong = await privateKeyToAccount(generatePrivateKey()).signTypedData({ ...typed, message });
    expect((await f.call(`/v1/commerce/me/invoices/${created.id}/acknowledge`, token, { signature: wrong })).body.error.code).toBe('invalid_signature');
    const signature = await payer.signTypedData({ ...typed, message });
    const acknowledged = (await f.call(`/v1/commerce/me/invoices/${created.id}/acknowledge`, token, { signature })).body;
    expect(acknowledged).toMatchObject({ status: 'acknowledged', acknowledgement: { signer: payer.address.toLowerCase() } });
    expect(acknowledged.activity.map((a: { type: string }) => a.type)).toContain('acknowledged');

    // Manual reminders: now and scheduled, cancellable before they are sent.
    const reminded = (await f.call(`/v1/invoices/${created.id}/remind`, f.keys.secretKey, { message: 'Friendly nudge' })).body;
    expect(reminded.activity.some((a: { detail: string }) => a.detail.includes('Friendly nudge'))).toBe(true);
    const later = (await f.call(`/v1/invoices/${created.id}/reminders`, f.keys.secretKey, { message: 'Due soon', sendAt: new Date(Date.now() + 86_400_000).toISOString() })).body;
    expect(later.sentAt).toBeNull();
    expect((await f.call(`/v1/invoices/${created.id}/reminders/${later.id}/cancel`, f.keys.secretKey, {})).body.cancelledAt).toBeTruthy();

    // The payer starts a payment for the invoice and owns it.
    const payment = await f.call(`/v1/commerce/me/invoices/${created.id}/payments`, token, {});
    expect(payment.status).toBe(201);
    expect((await f.call(`/v1/commerce/me/payments/${payment.body.paymentId}`, token)).body).toMatchObject({ invoiceId: created.id, amountMinor: '1000000000' });
    expect((await f.call(`/v1/commerce/me/payments/${payment.body.paymentId}`, stranger)).status).toBe(404);
  });

  describe('a payer who leaves checkout and comes back', () => {
    const merchant = '0x00000000000000000000000000000000000000aa';
    async function setup(invoice: Record<string, unknown> = {}) {
      const f = fixture(), payer = privateKeyToAccount(generatePrivateKey());
      const created = (await f.call('/v1/invoices', f.keys.secretKey, { customerEmail: 'client@acme.test', amount: '6', ...invoice })).body;
      const token = await f.signIn(payer, 'client@acme.test');
      const pay = (amountMinor?: string) => f.call(`/v1/commerce/me/invoices/${created.id}/payments`, token, amountMinor ? { amountMinor } : {});
      const status = (paymentId: string) => (f.db.prepare('SELECT status FROM payments WHERE id=?').get(paymentId) as { status: string }).status;
      const unix = (offset: number) => Math.floor(Date.now() / 1000) + offset;
      const offer = (paymentId: string, deadline: number) => f.db.prepare('INSERT OR REPLACE INTO hosted_intent_offers VALUES (?,?)').run(paymentId, deadline);
      const submitted = (paymentId: string, amount: bigint, deadline: number, intentStatus = 'submitted') => {
        const data = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [paymentId as Hex, merchant, amount, 86_400n] });
        const request = { data, signature: '0x', intent: { signer: payer.address, merchant, target: escrow, dataHash: '0x', amount: amount.toString(), feeUSDT: '0', nonce: String(unix(0)), deadline: String(deadline), maxGas: '1' } };
        f.db.prepare('INSERT INTO intents VALUES (?,?,?,?,?,?,?,?,?)').run(`int_${paymentId}`, f.keys.merchantId, payer.address.toLowerCase(), request.intent.nonce, JSON.stringify(request), intentStatus, null, null, new Date().toISOString());
      };
      return { f, token, invoiceId: created.id as string, pay, status, unix, offer, submitted };
    }

    it('returns the same open attempt every time instead of refusing the invoice', async () => {
      const t = await setup({ amount: '1' });
      const first = await t.pay('1000000');
      expect(first.status).toBe(201);
      for (let i = 0; i < 3; i++) {
        const again = await t.pay('1000000');
        expect(again.status).toBe(200);
        expect(again.body.paymentId).toBe(first.body.paymentId);
      }
      // Even with a charge offered for signing just now, coming back reuses the same payment id.
      t.offer(first.body.paymentId, t.unix(300));
      expect((await t.pay()).body.paymentId).toBe(first.body.paymentId);
      expect(t.f.db.prepare('SELECT * FROM payments').all()).toHaveLength(1);
    });

    it('expires an unsigned attempt when the payer picks a different amount', async () => {
      const t = await setup({ allowPartial: true });
      const four = (await t.pay('4000000')).body.paymentId;
      const six = await t.pay('6000000');
      expect(six.status).toBe(201);
      expect(t.status(four)).toBe('expired');
      expect((await t.f.call(`/v1/commerce/me/payments/${four}`, t.token)).body.status).toBe('expired');
      // The expired attempt no longer holds any of the balance.
      expect((await t.pay('6000000')).body.paymentId).toBe(six.body.paymentId);
    });

    it('keeps an attempt reserved while a charge signed for it can still execute, then releases it', async () => {
      const t = await setup({ allowPartial: true });
      const four = (await t.pay('4000000')).body.paymentId;
      t.offer(four, t.unix(240));
      const refused = await t.pay('6000000');
      expect(refused.body.error.code).toBe('invoice_payment_in_progress');
      expect(t.status(four)).toBe('open');
      // The other $2 is still free to pay.
      expect((await t.pay('2000000')).status).toBe(201);
      // Past the signed deadline plus clock skew, the Router refuses that charge, so it is released.
      t.offer(four, t.unix(-61));
      expect((await t.pay('3000000')).status).toBe(201);
      expect(t.status(four)).toBe('expired');
    });

    it('never releases an attempt whose submitted charge is unsettled, even after its deadline', async () => {
      const t = await setup({ allowPartial: true });
      const four = (await t.pay('4000000')).body.paymentId;
      t.submitted(four, 4_000_000n, t.unix(-3600));
      expect((await t.pay('6000000')).body.error.code).toBe('invoice_payment_in_progress');
      expect(t.status(four)).toBe('open');
      expect((await t.pay('4000000')).body.paymentId).toBe(four);
    });

    it('replaces a failed attempt once its charge has expired', async () => {
      const t = await setup({ amount: '1' });
      const first = (await t.pay()).body.paymentId;
      t.submitted(first, 1_000_000n, t.unix(-120), 'failed');
      t.f.db.prepare("UPDATE payments SET status='failed' WHERE id=?").run(first);
      const next = await t.pay();
      expect(next.status).toBe(201);
      expect(next.body.paymentId).not.toBe(first);
      expect(t.status(first)).toBe('expired');
    });

    it('does not offer an attempt again after its approval failed', async () => {
      const t = await setup({ amount: '1' });
      const first = (await t.pay()).body.paymentId;
      const at = new Date().toISOString();
      t.f.db.prepare('INSERT INTO approval_attempts VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('approval_1', first, t.f.keys.merchantId, '0x01', '0x02', escrow, '1000000', '0', '0', 'failed', 'reverted', null, '0', at, at);
      const next = await t.pay();
      expect(next.status).toBe(201);
      expect(next.body.paymentId).not.toBe(first);
      expect(t.status(first)).toBe('expired');
    });
  });
});
