import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { openDb, seedMerchant } from '../src/db.js';
import { FakeChain } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { Indexer } from '../src/indexer.js';
import { runKeeper } from '../src/keeper.js';
import type { Hex } from 'viem';

const router = '0x0000000000000000000000000000000000000001';
const escrow = '0x0000000000000000000000000000000000000002';
const subscription = '0x0000000000000000000000000000000000000003';
function fixture() {
  const db = openDb(), chain = new FakeChain();
  const keys = seedMerchant(db, '0x0000000000000000000000000000000000000004');
  const other = seedMerchant(db, '0x0000000000000000000000000000000000000005');
  const app = createApp({ db, chain, relayer: new Relayer(chain, router, allowedTargets(escrow, subscription)) });
  const post = (path: string, body: unknown, key = keys.secretKey, idem?: string) => app.request(path, {
    method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...(idem ? { 'idempotency-key': idem } : {}) }, body: JSON.stringify(body),
  });
  const get = (path: string, key = keys.secretKey) => app.request(path, { headers: { authorization: `Bearer ${key}` } });
  const invoice = async (body = {}) => (await post('/v1/invoices', { customerEmail: 'buyer@example.com', amount: '6', ...body })).json();
  return { db, chain, keys, other, post, get, invoice };
}

describe('invoice lifecycle', () => {
  it('creates exact line totals, memo and draft; sending is idempotent and drafts never remind', async () => {
    const f = fixture();
    const body = { customerEmail: 'buyer@example.com', status: 'draft', memo: 'Project deposit', dueAt: '2026-11-06', metadata: { project: 'A' }, lines: [{ description: 'Design', quantity: 3, unitAmount: '1.000001' }] };
    const responses = await Promise.all([f.post('/v1/invoices', body, f.keys.secretKey, 'draft-1'), f.post('/v1/invoices', body, f.keys.secretKey, 'draft-1')]);
    expect(responses.map(x => x.status)).toEqual([200, 200]);
    const [created, replayed] = await Promise.all(responses.map(x => x.json()));
    expect(created.id).toBe(replayed.id);
    expect(created).toMatchObject({ amount: '3.000003', remaining: '3.000003', status: 'draft', memo: body.memo, metadata: body.metadata });
    expect(created.lines[0]).toMatchObject({ quantity: 3, unitAmount: '1.000001', amount: '3.000003' });
    await runKeeper(f.db, f.chain);
    expect(f.db.prepare('SELECT * FROM reminders').all()).toHaveLength(0);
    expect((await f.post(`/v1/invoices/${created.id}/payments`, {})).status).toBe(422);
    for (let i = 0; i < 2; i++) expect((await f.post(`/v1/invoices/${created.id}/send`, {})).status).toBe(200);
    expect(f.db.prepare("SELECT * FROM webhook_events WHERE type='invoice.sent'").all()).toHaveLength(1);
    expect((await (await f.get(`/v1/invoices/${created.id}`)).json()).status).toBe('sent');
    expect((await (await f.get('/v1/invoices')).json()).data).toHaveLength(1);
  });

  it.each([0, -1, 1.2, '2', null, Number.MAX_SAFE_INTEGER + 1])('rejects invalid quantity %s without partial inserts', async quantity => {
    const f = fixture();
    const response = await f.post('/v1/invoices', { customerEmail: 'buyer@example.com', lines: [{ description: 'Work', unitAmount: '2', quantity }] });
    expect(response.status).toBe(400);
    expect(f.db.prepare('SELECT * FROM invoices').all()).toHaveLength(0);
    expect(f.db.prepare('SELECT * FROM invoice_lines').all()).toHaveLength(0);
  });

  it.each([
    { allow_partial: 'false' }, { dueAt: 1 }, { dueAt: 'bad' }, { metadata: [] }, { lines: 'bad' },
    { status: 'paid' }, { memo: 123 }, { metadata: { invoiceMemo: 'spoof' } },
    { lines: [{ quantity: 1, unitAmount: '1', description: '' }] },
    { amount: '2', lines: [{ quantity: 1, unitAmount: '1', description: 'Work' }] },
  ])('rejects malformed invoice fields %j', async extra => {
    const f = fixture();
    expect((await f.post('/v1/invoices', { customerEmail: 'buyer@example.com', amount: '1', ...extra })).status).toBe(400);
  });

  it('isolates merchants and does not expose customer records to publishable keys', async () => {
    const f = fixture(), invoice = await f.invoice();
    expect((await f.get(`/v1/invoices/${invoice.id}`, f.other.secretKey)).status).toBe(404);
    expect((await (await f.get('/v1/invoices', f.other.secretKey)).json()).data).toEqual([]);
    for (const path of ['/v1/invoices', `/v1/invoices/${invoice.id}`]) expect((await f.get(path, f.keys.publishableKey)).status).toBe(403);
    for (const suffix of ['send', 'payments']) {
      expect((await f.post(`/v1/invoices/${invoice.id}/${suffix}`, {}, f.keys.publishableKey)).status).toBe(403);
      expect((await f.post(`/v1/invoices/${invoice.id}/${suffix}`, {}, f.other.secretKey)).status).toBe(422);
    }
    expect((await f.post('/v1/payments', { amount: '6', metadata: { invoiceId: invoice.id } }, f.other.publishableKey)).status).toBe(422);
    expect((await f.post('/v1/payments', { amount: '6', metadata: { invoiceId: invoice.id } }, f.keys.publishableKey)).status).toBe(422);
  });

  it('enforces full-payment policy on both invoice and generic payment routes', async () => {
    const f = fixture(), invoice = await f.invoice();
    expect((await f.post(`/v1/invoices/${invoice.id}/payments`, { amount: '2' })).status).toBe(422);
    expect((await f.post('/v1/payments', { amount: '2', metadata: { invoiceId: invoice.id } })).status).toBe(422);
    expect((await f.post(`/v1/invoices/${invoice.id}/payments`, {})).status).toBe(200);
    expect((await f.post('/v1/payments', { amount: '6', metadata: { invoiceId: invoice.id } })).status).toBe(422);
    expect(f.db.prepare('SELECT * FROM payments').all()).toHaveLength(1);
  });

  it('reserves amounts atomically across simultaneous partial checkout requests', async () => {
    const f = fixture(), invoice = await f.invoice({ allowPartial: true });
    const responses = await Promise.all([
      f.post(`/v1/invoices/${invoice.id}/payments`, { amount: '4' }),
      f.post('/v1/payments', { amount: '4', metadata: { invoiceId: invoice.id } }),
    ]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 422]);
    expect((await f.post(`/v1/invoices/${invoice.id}/payments`, { amount: '2' })).status).toBe(200);
    expect((await f.post(`/v1/invoices/${invoice.id}/payments`, { amount: '0.000001' })).status).toBe(422);
    expect(f.db.prepare('SELECT amount_minor FROM payments').all()).toHaveLength(2);
  });

  it('indexes confirmed partial payments once, then permits only the outstanding balance', async () => {
    const f = fixture(), invoice = await f.invoice({ allow_partial: true });
    const first = await (await f.post(`/v1/invoices/${invoice.id}/payments`, { amount: '2' })).json();
    const hash = `0x${'a'.repeat(64)}` as Hex;
    f.chain.emit({ id: 'invoice-partial-1', txHash: hash, contract: 'escrow', name: 'Charged', args: { id: first.id, amount: 2_000_000n } });
    const indexer = new Indexer(f.db, f.chain);
    await indexer.poll();
    expect((await (await f.get(`/v1/invoices/${invoice.id}`)).json()).paid).toBe('0.000000');
    f.chain.block += 2n;
    await indexer.poll(); await indexer.poll();
    expect((await (await f.get(`/v1/invoices/${invoice.id}`)).json())).toMatchObject({ status: 'partially_paid', paid: '2.000000', remaining: '4.000000' });
    const second = await (await f.post(`/v1/invoices/${invoice.id}/payments`, {})).json();
    expect(second.amount).toBe('4.000000');
    f.chain.emit({ id: 'invoice-partial-2', txHash: `0x${'b'.repeat(64)}`, contract: 'escrow', name: 'Charged', args: { id: second.id, amount: 4_000_000n } });
    f.chain.block += 2n;
    await indexer.poll(); await indexer.poll();
    expect((await (await f.get(`/v1/invoices/${invoice.id}`)).json())).toMatchObject({ status: 'paid', paid: '6.000000', remaining: '0.000000' });
    expect(f.db.prepare("SELECT * FROM webhook_events WHERE type='invoice.paid'").all()).toHaveLength(1);
    expect((await f.post(`/v1/invoices/${invoice.id}/payments`, {})).status).toBe(422);
  });
});
