import { randomBytes } from 'node:crypto';
import type { Context, Hono } from 'hono';
import { keyHash, now, type Db } from './db.js';
import { eventsFor, retryAt, type OwnerKind } from './notifications.js';

export interface TelegramConfig { token: string; username: string }
export type TelegramCall = (method: string, body: Record<string, unknown>) => Promise<{ ok: boolean; result?: unknown; error_code?: number; description?: string; parameters?: { retry_after?: number } }>;
const TOKEN_TTL_MS = 15 * 60_000, MAX_ATTEMPTS = 8, MAX_MESSAGE = 4096;

/** Both values or nothing: an unset bot means no routes, no jobs and no calls to Telegram. */
export function telegramConfig(env: Record<string, string | undefined> = process.env): TelegramConfig | undefined {
  return env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_USERNAME ? { token: env.TELEGRAM_BOT_TOKEN, username: env.TELEGRAM_BOT_USERNAME.replace(/^@/, '') } : undefined;
}

/** The request URL holds the bot token, so errors from here never carry the URL or the original error. */
export function telegramClient(token: string, fetcher: typeof fetch = fetch): TelegramCall {
  return async (method, body) => {
    let response: Response;
    try {
      response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new Error(`Telegram ${method} could not be reached`);
    }
    const parsed = await response.json().catch(() => null) as Awaited<ReturnType<TelegramCall>> | null;
    return parsed ?? { ok: false, error_code: response.status, description: 'Unreadable response' };
  };
}

/** One live link per owner. Only the hash is stored; the token itself exists only in the returned URL. */
export function createConnectLink(db: Db, config: TelegramConfig, kind: OwnerKind, ownerId: string, at = new Date()) {
  const token = randomBytes(32).toString('base64url'), expiresAt = new Date(at.getTime() + TOKEN_TTL_MS).toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM telegram_tokens WHERE owner_kind=? AND owner_id=? AND used_at IS NULL').run(kind, ownerId);
    db.prepare('INSERT INTO telegram_tokens(token_hash,owner_kind,owner_id,expires_at,created_at) VALUES (?,?,?,?,?)').run(keyHash(token), kind, ownerId, expiresAt, at.toISOString());
  })();
  return { url: `https://t.me/${config.username}?start=${token}`, expiresAt };
}

function bindChat(db: Db, token: string, chatId: string, at: Date) {
  const hash = keyHash(token);
  if (db.prepare('UPDATE telegram_tokens SET used_at=? WHERE token_hash=? AND used_at IS NULL AND expires_at>?').run(at.toISOString(), hash, at.toISOString()).changes !== 1) return false;
  const owner = db.prepare('SELECT owner_kind,owner_id FROM telegram_tokens WHERE token_hash=?').get(hash) as { owner_kind: OwnerKind; owner_id: string };
  db.prepare(`INSERT INTO notification_prefs(owner_kind,owner_id,channel,events,telegram_chat_id,updated_at) VALUES (?,?,'telegram',?,?,?)
    ON CONFLICT(owner_kind,owner_id,channel) DO UPDATE SET telegram_chat_id=excluded.telegram_chat_id,updated_at=excluded.updated_at`).run(owner.owner_kind, owner.owner_id, JSON.stringify(eventsFor(owner.owner_kind)), chatId, now());
  return true;
}
const unbindChat = (db: Db, chatId: string) => db.prepare("UPDATE notification_prefs SET telegram_chat_id=NULL,updated_at=? WHERE channel='telegram' AND telegram_chat_id=?").run(now(), chatId).changes;

type Update = { update_id: number; message?: { text?: unknown; chat?: { id?: unknown; type?: unknown } } };
function reply(db: Db, update: Update, at: Date): { chatId: string; text: string } | null {
  const text = update.message?.text, chat = update.message?.chat;
  if (typeof text !== 'string' || (typeof chat?.id !== 'number' && typeof chat?.id !== 'string') || chat.type !== 'private') return null;
  const chatId = String(chat.id), start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(text);
  if (start) {
    if (!start[1]) return { chatId, text: 'To connect, click Connect Telegram in your Pact notification settings.' };
    return { chatId, text: bindChat(db, start[1], chatId, at) ? 'Connected to Pact' : 'This link has expired or was already used. Click Connect Telegram again.' };
  }
  if (/^\/stop(?:@\w+)?\s*$/.test(text)) return { chatId, text: unbindChat(db, chatId) ? 'Disconnected from Pact. You will get no more messages here.' : 'This chat is not connected to Pact.' };
  return null;
}

/** The offset moves with each update's database changes, so a crash or restart cannot process it twice. */
export async function pollTelegram(db: Db, call: TelegramCall, at = new Date()) {
  const state = db.prepare('SELECT update_offset FROM telegram_state WHERE id=1').get() as { update_offset: number } | undefined;
  const response = await call('getUpdates', { timeout: 0, limit: 50, allowed_updates: ['message'], ...(state ? { offset: state.update_offset } : {}) });
  if (!response.ok || !Array.isArray(response.result)) throw new Error(`Telegram getUpdates failed with ${response.error_code ?? 'no status'}`);
  for (const update of response.result as Update[]) {
    const answer = db.transaction(() => {
      const value = reply(db, update, at);
      db.prepare('INSERT INTO telegram_state(id,update_offset) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET update_offset=excluded.update_offset').run(update.update_id + 1);
      return value;
    })();
    if (answer) await call('sendMessage', { chat_id: answer.chatId, text: answer.text }).catch(() => console.error('Telegram reply could not be sent'));
  }
  return response.result.length;
}

/** The same outbox and retry shape as email. The chat is read at send time, so /stop also stops what is queued. */
export async function deliverTelegram(db: Db, call: TelegramCall, at = new Date()) {
  const rows = db.prepare("SELECT o.*,p.telegram_chat_id FROM notification_outbox o LEFT JOIN notification_prefs p ON p.owner_kind=o.owner_kind AND p.owner_id=o.owner_id AND p.channel='telegram' WHERE o.channel='telegram' AND o.status='pending' AND o.next_at<=? ORDER BY o.next_at LIMIT 20").all(at.toISOString()) as Array<{ id: string; subject: string; body: string; attempt: number; telegram_chat_id: string | null }>;
  const finish = db.prepare('UPDATE notification_outbox SET status=?,attempt=?,last_error=?,next_at=?,sent_at=? WHERE id=?');
  await Promise.all(rows.map(async row => {
    const attempt = row.attempt + 1;
    if (!row.telegram_chat_id) { finish.run('failed', row.attempt, 'telegram_not_connected', at.toISOString(), null, row.id); return; }
    let error: string, permanent = false, retry = retryAt(at, attempt);
    try {
      const response = await call('sendMessage', { chat_id: row.telegram_chat_id, text: `${row.subject}\n\n${row.body}`.slice(0, MAX_MESSAGE) });
      if (response.ok) { finish.run('sent', attempt, null, at.toISOString(), now(), row.id); return; }
      const status = response.error_code ?? 0;
      error = `HTTP ${status}`;
      // The person blocked the bot or the chat is gone: retrying cannot help, and they should show as disconnected.
      if (status === 403) unbindChat(db, row.telegram_chat_id);
      permanent = status >= 400 && status < 500 && status !== 429;
      if (status === 429 && response.parameters?.retry_after) retry = new Date(at.getTime() + response.parameters.retry_after * 1000).toISOString();
    } catch (cause) {
      error = (cause instanceof Error ? cause.message : 'Send failed').slice(0, 300);
    }
    finish.run(permanent || attempt >= MAX_ATTEMPTS ? 'failed' : 'pending', attempt, error, retry, null, row.id);
  }));
  return rows.length;
}

function mount(app: Hono, db: Db, config: TelegramConfig | undefined, connect: string, disconnect: string, kind: OwnerKind, owner: (c: Context) => string | Promise<string>) {
  const hidden = (c: Context) => c.json({ error: { code: 'telegram_unavailable', message: 'Telegram is not set up' } }, 404);
  app.post(connect, async c => config ? c.json(createConnectLink(db, config, kind, await owner(c))) : hidden(c));
  app.post(disconnect, async c => {
    if (!config) return hidden(c);
    db.prepare("UPDATE notification_prefs SET telegram_chat_id=NULL,updated_at=? WHERE owner_kind=? AND owner_id=? AND channel='telegram'").run(now(), kind, await owner(c));
    return c.json({ connected: false });
  });
}
export const mountMerchantTelegram = (app: Hono, db: Db, config: TelegramConfig | undefined, merchant: (c: Context) => string) =>
  mount(app, db, config, '/v1/notifications/telegram/connect', '/v1/notifications/telegram/disconnect', 'merchant', merchant);
export const mountCustomerTelegram = (app: Hono, db: Db, config: TelegramConfig | undefined, customer: (c: Context) => Promise<{ userId: string }>) =>
  mount(app, db, config, '/me/notifications/telegram/connect', '/me/notifications/telegram/disconnect', 'customer', async c => (await customer(c)).userId);
