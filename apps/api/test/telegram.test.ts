import { afterEach, describe, expect, it, vi } from 'vitest';
import { keccak256, type Address, type Hex } from 'viem';
import { FakeChain } from '../src/chain.js';
import { createApp } from '../src/app.js';
import { openDb, seedMerchant } from '../src/db.js';
import { IdentityError, type PrivyIdentity } from '../src/identity.js';
import { Indexer } from '../src/indexer.js';
import { deliverNotifications } from '../src/notifications.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { deliverTelegram, pollTelegram, telegramClient, telegramConfig } from '../src/telegram.js';
import { enqueueWebhook } from '../src/webhooks.js';

const address = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address;
const config = { token: 'BOT_SECRET_TOKEN', username: 'pact_test_bot' };
/** A fake Bot API: hands out queued updates, records every call, and can be told to fail. */
function fakeBot() {
  const updates: unknown[] = [], calls: Array<{ method: string; body: any }> = [];
  let nextId = 100, failure: Record<string, unknown> | null = null;
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const method = String(url).split('/').pop()!, body = JSON.parse(String(init?.body));
    calls.push({ method, body });
    if (method === 'getUpdates') return Response.json({ ok: true, result: updates.splice(0).filter((u: any) => body.offset === undefined || u.update_id >= body.offset) });
    if (failure) return Response.json({ ok: false, ...failure });
    return Response.json({ ok: true, result: {} });
  });
  return { call: telegramClient(config.token, fetcher as typeof fetch), fetcher, calls,
    say: (chat: number, text: string, type = 'private') => updates.push({ update_id: nextId++, message: { text, chat: { id: chat, type } } }),
    raw: (update: unknown) => updates.push(update),
    fail: (next: Record<string, unknown> | null) => { failure = next; },
    sent: () => calls.filter(c => c.method === 'sendMessage') };
}
function fixture(telegram: typeof config | undefined = config) {
  const db = openDb(), chain = new FakeChain(true), keys = seedMerchant(db, address(11)), other = seedMerchant(db, address(12));
  const identity = { handles: () => true, async authenticate(token: string) {
    const users: Record<string, object> = {
      payer: { userId: 'person-1', sessionId: 's', expiresAt: Math.floor(Date.now() / 1000) + 300, email: null, wallet: { address: address(22), id: null } },
      other: { userId: 'person-2', sessionId: 's', expiresAt: Math.floor(Date.now() / 1000) + 300, email: null, wallet: { address: address(33), id: null } },
    };
    if (!users[token]) throw new IdentityError('invalid_identity_token', 401);
    return users[token];
  }, async merchantFor() { throw new IdentityError('merchant_not_registered', 403); } } as unknown as PrivyIdentity;
  const app = createApp({ telegram, db, chain, identity, relayer: new Relayer(chain, address(1), allowedTargets(address(2), address(3))) });
  let count = 0;
  const request = async (path: string, token: string, body?: unknown) => {
    const result = await app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', 'idempotency-key': `key-${++count}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: result.status, body: await result.json() as any };
  };
  const connect = async (path: string, token: string) => {
    const link = await request(path, token, {});
    expect(link.status).toBe(200);
    return new URL(link.body.url).searchParams.get('start')!;
  };
  const merchantLink = (key = keys.secretKey) => connect('/v1/notifications/telegram/connect', key);
  const customerLink = (token = 'payer') => connect('/v1/commerce/me/notifications/telegram/connect', token);
  const buy = async () => {
    const item = (await request('/v1/commerce/products', keys.secretKey, { name: 'Widget', description: '', status: 'active', prices: [{ currency: 'USDT', amountMinor: '4000000' }] })).body;
    const order = (await request('/v1/commerce/checkout-sessions', 'payer', { productId: item.id, rail: 'whitechain' })).body.order;
    chain.emit({ id: `paid-${++count}`, txHash: keccak256(order.paymentId as Hex), contract: 'escrow', name: 'Charged', args: { id: order.paymentId, amount: 4_000_000n, merchant: address(11), payer: address(22) } });
    chain.block += 2n; await new Indexer(db, chain).poll();
    return order;
  };
  const chat = (kind: string, owner: string) => (db.prepare("SELECT telegram_chat_id c FROM notification_prefs WHERE owner_kind=? AND owner_id=? AND channel='telegram'").get(kind, owner) as { c: string | null } | undefined)?.c ?? null;
  const outbox = () => db.prepare("SELECT owner_kind,owner_id,recipient,status,attempt,last_error FROM notification_outbox WHERE channel='telegram' ORDER BY owner_kind DESC").all() as Array<Record<string, any>>;
  return { db, keys, other, request, merchantLink, customerLink, buy, chat, outbox };
}
afterEach(() => vi.restoreAllMocks());

describe('telegram config', () => {
  it('needs both values, and an unset bot hides the feature with no calls to Telegram', async () => {
    expect(telegramConfig({})).toBeUndefined();
    expect(telegramConfig({ TELEGRAM_BOT_TOKEN: 'x' })).toBeUndefined();
    expect(telegramConfig({ TELEGRAM_BOT_USERNAME: 'x' })).toBeUndefined();
    expect(telegramConfig({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_BOT_USERNAME: '@pact_bot' })).toEqual({ token: 't', username: 'pact_bot' });
    const fetched = vi.spyOn(globalThis, 'fetch');
    const f = fixture(null as never);
    expect((await f.request('/v1/notifications/preferences', f.keys.secretKey)).body).not.toHaveProperty('telegram');
    expect((await f.request('/v1/commerce/me/notifications/preferences', 'payer')).body).not.toHaveProperty('telegram');
    for (const [path, token] of [['/v1/notifications/telegram/connect', f.keys.secretKey], ['/v1/notifications/telegram/disconnect', f.keys.secretKey], ['/v1/commerce/me/notifications/telegram/connect', 'payer'], ['/v1/commerce/me/notifications/telegram/disconnect', 'payer']]) {
      const hidden = await f.request(path, token, {});
      expect(hidden.status).toBe(404); expect(hidden.body.error.code).toBe('telegram_unavailable');
    }
    expect((await f.request('/v1/notifications/preferences', f.keys.secretKey, { telegramEvents: [] })).status).toBe(422);
    expect(f.db.prepare('SELECT count(*) n FROM telegram_tokens').get()).toEqual({ n: 0 });
    expect(fetched).not.toHaveBeenCalled();
    f.db.close();
  });
});

describe('connect link', () => {
  it('returns a t.me link holding a 32-byte token that is stored only as a hash, for 15 minutes', async () => {
    const f = fixture();
    const link = (await f.request('/v1/notifications/telegram/connect', f.keys.secretKey, {})).body, token = new URL(link.url).searchParams.get('start')!;
    expect(link.url.startsWith('https://t.me/pact_test_bot?start=')).toBe(true);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = f.db.prepare('SELECT * FROM telegram_tokens').get() as Record<string, string>;
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row).toMatchObject({ owner_kind: 'merchant', owner_id: f.keys.merchantId, used_at: null });
    expect(Math.round((Date.parse(link.expiresAt) - Date.now()) / 60_000)).toBe(15);
    f.db.close();
  });
  it('binds once and refuses a second use, even from the same chat', async () => {
    const f = fixture(), bot = fakeBot(), token = await f.merchantLink();
    bot.say(555, `/start ${token}`);
    await pollTelegram(f.db, bot.call);
    expect(f.chat('merchant', f.keys.merchantId)).toBe('555');
    expect(bot.sent().at(-1)).toMatchObject({ body: { chat_id: '555', text: 'Connected to Pact' } });
    bot.say(666, `/start ${token}`); bot.say(555, `/start ${token}`);
    await pollTelegram(f.db, bot.call);
    expect(f.chat('merchant', f.keys.merchantId)).toBe('555');
    expect(bot.sent().slice(-2).map(c => c.body.text)).toEqual(['This link has expired or was already used. Click Connect Telegram again.', 'This link has expired or was already used. Click Connect Telegram again.']);
    expect((await f.request('/v1/notifications/preferences', f.keys.secretKey)).body.telegram).toMatchObject({ connected: true });
    f.db.close();
  });
  it('refuses an expired token, an older token after a new link, an unknown token and a group chat', async () => {
    const f = fixture(), bot = fakeBot(), expired = await f.merchantLink();
    bot.say(1, `/start ${expired}`);
    await pollTelegram(f.db, bot.call, new Date(Date.now() + 15 * 60_000 + 1000));
    expect(f.chat('merchant', f.keys.merchantId)).toBeNull();
    const older = await f.merchantLink(), newer = await f.merchantLink();
    bot.say(2, `/start ${older}`); bot.say(3, '/start not-a-real-token'); bot.say(4, `/start ${newer}`, 'group');
    await pollTelegram(f.db, bot.call);
    expect(f.chat('merchant', f.keys.merchantId)).toBeNull();
    bot.say(5, `/start ${newer}`);
    await pollTelegram(f.db, bot.call);
    expect(f.chat('merchant', f.keys.merchantId)).toBe('5');
    f.db.close();
  });
});

describe('owner isolation', () => {
  it('derives the owner from the session, never from the request, and refuses other callers', async () => {
    const f = fixture();
    expect((await f.request('/v1/notifications/telegram/connect', '', {})).status).toBe(401);
    expect((await f.request('/v1/notifications/telegram/connect', f.keys.publishableKey, {})).status).toBe(403);
    expect((await f.request('/v1/notifications/telegram/disconnect', f.keys.publishableKey, {})).status).toBe(403);
    expect((await f.request('/v1/commerce/me/notifications/telegram/connect', '', {})).status).toBe(401);
    expect((await f.request('/v1/notifications/telegram/connect', 'payer', {})).status).toBe(403);
    await f.request('/v1/commerce/me/notifications/telegram/connect', 'payer', { owner_id: 'person-2', owner_kind: 'merchant' });
    expect(f.db.prepare('SELECT owner_kind,owner_id FROM telegram_tokens').all()).toEqual([{ owner_kind: 'customer', owner_id: 'person-1' }]);
    f.db.close();
  });
  it('keeps each merchant and customer on their own chat, events and disconnect', async () => {
    const f = fixture(), bot = fakeBot();
    bot.say(10, `/start ${await f.merchantLink()}`); bot.say(20, `/start ${await f.merchantLink(f.other.secretKey)}`);
    bot.say(30, `/start ${await f.customerLink()}`); bot.say(40, `/start ${await f.customerLink('other')}`);
    await pollTelegram(f.db, bot.call);
    await f.buy();
    expect(f.outbox().map(row => [row.owner_kind, row.owner_id, row.recipient])).toEqual([['merchant', f.keys.merchantId, '10'], ['customer', 'person-1', '30']]);
    await f.request('/v1/commerce/me/notifications/telegram/disconnect', 'other', {});
    expect(f.chat('customer', 'person-2')).toBeNull();
    expect(f.chat('customer', 'person-1')).toBe('30');
    await f.request('/v1/notifications/telegram/disconnect', f.other.secretKey, {});
    expect(f.chat('merchant', f.other.merchantId)).toBeNull();
    expect(f.chat('merchant', f.keys.merchantId)).toBe('10');
    expect((await f.request('/v1/commerce/me/notifications/preferences', 'payer', { telegramEvents: ['invoice.paid'] })).status).toBe(422);
    f.db.close();
  });
});

describe('telegram delivery', () => {
  const connected = async () => { const f = fixture(), bot = fakeBot(); bot.say(10, `/start ${await f.merchantLink()}`); await pollTelegram(f.db, bot.call); bot.calls.length = 0; return { f, bot }; };
  it('sends one message for an event, through the outbox, separately from email', async () => {
    const { f, bot } = await connected();
    await f.request('/v1/notifications/preferences', f.keys.secretKey, { email: 'owner@shop.test' });
    await f.buy();
    const mail = vi.fn(async () => 'sent' as const);
    await deliverNotifications(f.db, mail);
    expect(mail).toHaveBeenCalledTimes(1);
    expect(await deliverTelegram(f.db, bot.call)).toBe(1);
    expect(await deliverTelegram(f.db, bot.call, new Date(Date.now() + 86_400_000))).toBe(0);
    expect(bot.sent()).toHaveLength(1);
    expect(bot.sent()[0].body.chat_id).toBe('10');
    expect(bot.sent()[0].body.text).toContain('Payment received: 4.00 USDT');
    expect(bot.sent()[0].body).not.toHaveProperty('parse_mode');
    expect(f.outbox()[0]).toMatchObject({ status: 'sent', attempt: 1 });
    f.db.close();
  });
  it('reaches a customer with no email address, and respects each channel\'s own prefs', async () => {
    const f = fixture(), bot = fakeBot();
    bot.say(30, `/start ${await f.customerLink()}`);
    await pollTelegram(f.db, bot.call);
    await f.buy();
    expect(f.outbox().map(row => row.recipient)).toEqual(['30']);
    f.db.exec('DELETE FROM notification_outbox');
    expect((await f.request('/v1/commerce/me/notifications/preferences', 'payer', { telegramEvents: [] })).body.telegram).toEqual({ connected: true, events: [] });
    await f.buy();
    expect(f.outbox()).toEqual([]);
    f.db.close();
  });
  it('stops queued messages after /stop and sends nothing more', async () => {
    const { f, bot } = await connected();
    await f.buy();
    bot.say(10, '/stop');
    await pollTelegram(f.db, bot.call);
    expect(f.chat('merchant', f.keys.merchantId)).toBeNull();
    bot.calls.length = 0;
    await deliverTelegram(f.db, bot.call);
    expect(bot.sent()).toEqual([]);
    expect(f.outbox()[0]).toMatchObject({ status: 'failed', last_error: 'telegram_not_connected' });
    f.db.exec('DELETE FROM notification_outbox');
    await f.buy();
    expect(f.outbox()).toEqual([]);
    f.db.close();
  });
  it('retries server errors up to eight times, honours retry_after, and unbinds a blocked chat', async () => {
    const { f, bot } = await connected();
    await f.buy();
    bot.fail({ error_code: 429, parameters: { retry_after: 120 } });
    const at = new Date(Date.now() + 1000);
    await deliverTelegram(f.db, bot.call, at);
    expect(f.outbox()[0]).toMatchObject({ status: 'pending', attempt: 1, last_error: 'HTTP 429' });
    expect(await deliverTelegram(f.db, bot.call, new Date(at.getTime() + 119_000))).toBe(0);
    bot.fail({ error_code: 500 });
    let later = new Date(at.getTime() + 121_000);
    for (let i = 0; i < 7; i++) { await deliverTelegram(f.db, bot.call, later); later = new Date(later.getTime() + 3_600_000); }
    expect(f.outbox()[0]).toMatchObject({ status: 'failed', attempt: 8 });
    f.db.exec('DELETE FROM notification_outbox');
    await f.buy();
    bot.fail({ error_code: 403 });
    await deliverTelegram(f.db, bot.call);
    expect(f.outbox()[0]).toMatchObject({ status: 'failed', attempt: 1, last_error: 'HTTP 403' });
    expect(f.chat('merchant', f.keys.merchantId)).toBeNull();
    f.db.close();
  });
});

describe('telegram polling', () => {
  it('keeps its offset across restarts, so an update is never processed twice', async () => {
    const f = fixture(), bot = fakeBot();
    bot.say(1, '/start'); bot.say(1, 'hello');
    expect(await pollTelegram(f.db, bot.call)).toBe(2);
    const offset = (f.db.prepare('SELECT update_offset FROM telegram_state').get() as { update_offset: number }).update_offset;
    expect(offset).toBe(102);
    await pollTelegram(f.db, bot.call);
    expect(bot.calls.at(-1)).toMatchObject({ method: 'getUpdates', body: { offset: 102, timeout: 0 } });
    expect(bot.sent()).toHaveLength(1);
    f.db.close();
  });
  it('skips updates it cannot read without getting stuck', async () => {
    const f = fixture(), bot = fakeBot();
    bot.raw({ update_id: 50 }); bot.raw({ update_id: 51, message: { text: 5, chat: { id: 1, type: 'private' } } }); bot.raw({ update_id: 52, message: { text: '/stop' } });
    expect(await pollTelegram(f.db, bot.call)).toBe(3);
    expect(f.db.prepare('SELECT update_offset FROM telegram_state').get()).toEqual({ update_offset: 53 });
    expect(bot.sent()).toEqual([]);
    f.db.close();
  });
  it('keeps the bot token out of errors', async () => {
    const f = fixture();
    const broken = telegramClient(config.token, (async () => { throw new Error(`failed: https://api.telegram.org/bot${config.token}/getUpdates`); }) as typeof fetch);
    const error = await pollTelegram(f.db, broken).catch(e => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(config.token);
    const refused = telegramClient(config.token, (async () => Response.json({ ok: false, error_code: 401, description: 'Unauthorized' })) as typeof fetch);
    await expect(pollTelegram(f.db, refused)).rejects.toThrow('Telegram getUpdates failed with 401');
    expect(f.db.prepare('SELECT count(*) n FROM telegram_state').get()).toEqual({ n: 0 });
    f.db.close();
  });
});

describe('merchant alerts', () => {
  it('sends non-webhook alerts and events to a chat with no email set', async () => {
    const f = fixture(), bot = fakeBot();
    bot.say(10, `/start ${await f.merchantLink()}`);
    await pollTelegram(f.db, bot.call);
    f.db.prepare('INSERT INTO invoices(id,merchant_id,customer_email,amount_minor,created_at) VALUES (?,?,?,?,?)').run('inv', f.keys.merchantId, 'buyer@example.test', '3000000', new Date().toISOString());
    enqueueWebhook(f.db, f.keys.merchantId, 'invoice.paid', 'inv');
    expect(f.outbox().map(row => row.recipient)).toEqual(['10']);
    f.db.close();
  });
});
