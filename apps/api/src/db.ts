import { initCommerce } from './commerce/schema.js';
import { initDiscounts } from './discounts.js';
import { initCheckoutMetadata } from './metadata.js';
import { initNotifications } from './notifications.js';
import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { initAccounting } from './accounting.js';

export type Db = Database.Database;
export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '')}`;
export const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');
export function openDb(path: string | Buffer = ':memory:'): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchants(id TEXT PRIMARY KEY, address TEXT NOT NULL, webhook_url TEXT, webhook_secret TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS merchant_settings(merchant_id TEXT PRIMARY KEY REFERENCES merchants(id),brand_name TEXT NOT NULL,logo_url TEXT,refund_window_seconds INTEGER NOT NULL CHECK(refund_window_seconds BETWEEN 1 AND 31536000),updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_policies(payment_id TEXT PRIMARY KEY REFERENCES payments(id),refund_window_seconds INTEGER NOT NULL CHECK(refund_window_seconds BETWEEN 1 AND 31536000));
    CREATE TABLE IF NOT EXISTS payment_contract_terms(payment_id TEXT PRIMARY KEY REFERENCES payments(id),refund_window_seconds TEXT NOT NULL,refund_deadline_unix TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
    CREATE TABLE IF NOT EXISTS payments(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, amount_minor TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USDT', description TEXT, customer TEXT, payer TEXT, metadata TEXT, status TEXT NOT NULL DEFAULT 'open', captured_minor TEXT NOT NULL DEFAULT '0', refunded_minor TEXT NOT NULL DEFAULT '0', expires_at TEXT, refund_deadline TEXT, tx_hash TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS refunds(id TEXT PRIMARY KEY, payment_id TEXT NOT NULL, amount_minor TEXT NOT NULL, reason TEXT, status TEXT NOT NULL DEFAULT 'pending', tx_hash TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invoices(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, customer_email TEXT NOT NULL, amount_minor TEXT NOT NULL, paid_minor TEXT NOT NULL DEFAULT '0', due_at TEXT, allow_partial INTEGER NOT NULL DEFAULT 0, metadata TEXT, status TEXT NOT NULL DEFAULT 'sent', financing_status TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invoice_lines(id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, description TEXT NOT NULL, quantity REAL NOT NULL, unit_amount_minor TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, name TEXT NOT NULL, amount_minor TEXT NOT NULL, period_seconds INTEGER NOT NULL, max_periods INTEGER, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS payment_links(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('product','subscription','tip')), name TEXT NOT NULL, amount_minor TEXT, period_seconds INTEGER, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')), visits INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS subscriptions(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, plan_id TEXT NOT NULL, chain_id TEXT, payer TEXT, status TEXT NOT NULL DEFAULT 'active', next_charge_at TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, pending_tx_hash TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS subscription_replacements(intent_id TEXT PRIMARY KEY, old_id TEXT NOT NULL, new_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS subscription_service_backoff(subscription_id TEXT PRIMARY KEY, next_attempt_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, signer TEXT NOT NULL, nonce TEXT NOT NULL, request_json TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, tx_hash TEXT, created_at TEXT NOT NULL, UNIQUE(signer,nonce));
    CREATE TABLE IF NOT EXISTS chain_events(id TEXT PRIMARY KEY, block_number TEXT NOT NULL, tx_hash TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS webhook_events(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, type TEXT NOT NULL, object_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS webhook_deliveries(id TEXT PRIMARY KEY, event_id TEXT NOT NULL, merchant_id TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending', next_at TEXT NOT NULL, last_http_status INTEGER, last_error TEXT, delivered_at TEXT, UNIQUE(event_id,merchant_id));
    CREATE TABLE IF NOT EXISTS webhook_attempts(id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL, attempt INTEGER NOT NULL, http_status INTEGER, error TEXT, attempted_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reminders(invoice_id TEXT NOT NULL, stage TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(invoice_id,stage));
    CREATE TABLE IF NOT EXISTS refusal_attempts(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, object_id TEXT NOT NULL, reason TEXT NOT NULL, tx_hash TEXT, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS approval_attempts(
      id TEXT PRIMARY KEY, payment_id TEXT NOT NULL UNIQUE, merchant_id TEXT NOT NULL, payer TEXT NOT NULL,
      token TEXT NOT NULL, spender TEXT NOT NULL, amount_minor TEXT NOT NULL, approval_nonce TEXT NOT NULL,
      deadline TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, tx_hash TEXT, cost_wei TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS approval_pending_payer ON approval_attempts(payer) WHERE status IN ('prepared','pending');
    CREATE TABLE IF NOT EXISTS relayer_legacy_holds(reference TEXT PRIMARY KEY, tx_hash TEXT);
    CREATE TABLE IF NOT EXISTS relayer_recovery_audit(id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, tx_hash TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS relayer_operations(
      operation_id TEXT PRIMARY KEY, kind TEXT NOT NULL, object_id TEXT NOT NULL, links_json TEXT NOT NULL,
      chain_id INTEGER NOT NULL, relayer TEXT NOT NULL, nonce INTEGER, tx_hash TEXT,
      phase TEXT NOT NULL, reason TEXT, receipt_block TEXT, receipt_status TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS relayer_reserved_nonce ON relayer_operations(chain_id,relayer,nonce) WHERE nonce IS NOT NULL AND phase!='not_sent';
    CREATE TABLE IF NOT EXISTS relayer_write_block(id INTEGER PRIMARY KEY CHECK(id=1), tx_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cursor(name TEXT PRIMARY KEY, block_number TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS idempotency(merchant_id TEXT NOT NULL, route TEXT NOT NULL, key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL, PRIMARY KEY(merchant_id,route,key));
  `);
  db.exec("DROP INDEX IF EXISTS approval_pending_payer; CREATE UNIQUE INDEX approval_pending_payer ON approval_attempts(payer) WHERE status IN ('prepared','pending');");
  if (!(db.pragma('table_info(subscriptions)') as Array<{ name: string }>).some(x => x.name === 'payer')) db.exec('ALTER TABLE subscriptions ADD COLUMN payer TEXT');
  if (!(db.pragma('table_info(plans)') as Array<{ name: string }>).some(x => x.name === 'trial_days')) db.exec('ALTER TABLE plans ADD COLUMN trial_days INTEGER NOT NULL DEFAULT 0');
  for (const column of ['cancelled_at', 'cancelled_by', 'trial_ends_at', 'trial_customer_subject_id']) if (!(db.pragma('table_info(subscriptions)') as Array<{ name: string }>).some(x => x.name === column)) db.exec(`ALTER TABLE subscriptions ADD COLUMN ${column} TEXT`);
  if (!(db.pragma('table_info(payments)') as Array<{ name: string }>).some(x => x.name === 'payer')) db.exec('ALTER TABLE payments ADD COLUMN payer TEXT');
  // Staged finality: confirmed (in a sequencer block), settled (batch on Ethereum), final (irreversible),
  // with the transaction and block it was seen in, rechecked before it counts as final.
  for (const column of ['finality', 'finality_tx_hash', 'finality_block', 'finality_block_hash']) if (!(db.pragma('table_info(payments)') as Array<{ name: string }>).some(x => x.name === column)) db.exec(`ALTER TABLE payments ADD COLUMN ${column} TEXT`);
  db.exec('CREATE INDEX IF NOT EXISTS payments_finality ON payments(finality); CREATE INDEX IF NOT EXISTS payments_finality_hash ON payments(lower(finality_tx_hash));');
  // What each confirmed relayer write actually cost Pact in gas: Pact's margin is its fees less this.
  if (!(db.pragma('table_info(relayer_operations)') as Array<{ name: string }>).some(x => x.name === 'gas_cost_wei')) db.exec('ALTER TABLE relayer_operations ADD COLUMN gas_cost_wei TEXT');
  // Measured execution gas per kind of call (`target:selector`): the relayer budgets with it instead of the gas limit.
  // The signed transaction itself: rebroadcasting these exact bytes (same nonce, same hash) is always safe.
  for (const column of ['raw_tx', 'broadcast_attempts', 'last_error']) if (!(db.pragma('table_info(relayer_operations)') as Array<{ name: string }>).some(x => x.name === column)) db.exec(`ALTER TABLE relayer_operations ADD COLUMN ${column} TEXT`);
  for (const column of ['gas_used', 'call_key']) if (!(db.pragma('table_info(relayer_operations)') as Array<{ name: string }>).some(x => x.name === column)) db.exec(`ALTER TABLE relayer_operations ADD COLUMN ${column} TEXT`);
  db.exec('CREATE INDEX IF NOT EXISTS relayer_operations_call ON relayer_operations(call_key)');
  // A label for each API key, and the merchant's display preferences (live mode).
  if (!(db.pragma('table_info(api_keys)') as Array<{ name: string }>).some(x => x.name === 'name')) db.exec("ALTER TABLE api_keys ADD COLUMN name TEXT NOT NULL DEFAULT ''");
  db.exec("CREATE TABLE IF NOT EXISTS merchant_preferences(merchant_id TEXT PRIMARY KEY, brand_color TEXT NOT NULL, updated_at TEXT NOT NULL)");
  // Customers never pay Pact's fee, so the old "who pays the fee" preference is gone.
  if ((db.pragma('table_info(merchant_preferences)') as Array<{ name: string }>).some(x => x.name === 'fee_mode')) db.exec('ALTER TABLE merchant_preferences DROP COLUMN fee_mode');
  // Gas Pact's relayer absorbed for a merchant (subscribing, cancelling, permits, signed orders), per UTC day.
  db.exec('CREATE TABLE IF NOT EXISTS sponsored_spend(operation_id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, day TEXT NOT NULL, cost_wei TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS sponsored_spend_day ON sponsored_spend(merchant_id,day);');
  // Where a refusal happened (relayer, contract, api) and who signed the refused request.
  for (const column of ['source', 'signer']) if (!(db.pragma('table_info(refusal_attempts)') as Array<{ name: string }>).some(x => x.name === column)) db.exec(`ALTER TABLE refusal_attempts ADD COLUMN ${column} TEXT`);
  // The spend budget each relayer write reserves (created here so every query below can be indexed).
  db.exec('CREATE TABLE IF NOT EXISTS relayer_spend_reservations(operation_id TEXT PRIMARY KEY, minute INTEGER NOT NULL, cost_wei TEXT NOT NULL)');
  // Hot-path indexes. Hash lookups compare lower(...), so the indexes are on the same expressions.
  db.exec(`
    CREATE INDEX IF NOT EXISTS relayer_operations_phase ON relayer_operations(chain_id,relayer,phase);
    CREATE INDEX IF NOT EXISTS relayer_operations_hash ON relayer_operations(lower(tx_hash));
    CREATE INDEX IF NOT EXISTS relayer_operations_object ON relayer_operations(object_id,kind,phase);
    CREATE INDEX IF NOT EXISTS relayer_spend_minute ON relayer_spend_reservations(minute);
    CREATE INDEX IF NOT EXISTS intents_hash ON intents(lower(tx_hash));
    CREATE INDEX IF NOT EXISTS intents_status ON intents(status);
    CREATE INDEX IF NOT EXISTS refunds_hash ON refunds(lower(tx_hash));
    CREATE INDEX IF NOT EXISTS refunds_payment ON refunds(payment_id,status);
    CREATE INDEX IF NOT EXISTS subscriptions_pending ON subscriptions(lower(pending_tx_hash));
    CREATE INDEX IF NOT EXISTS subscriptions_chain ON subscriptions(chain_id);
    CREATE INDEX IF NOT EXISTS subscriptions_due ON subscriptions(status,next_charge_at);
    CREATE INDEX IF NOT EXISTS payments_merchant ON payments(merchant_id,created_at);
    CREATE INDEX IF NOT EXISTS webhook_deliveries_due ON webhook_deliveries(status,next_at);
    CREATE INDEX IF NOT EXISTS refusal_attempts_object ON refusal_attempts(merchant_id,object_id);
    CREATE INDEX IF NOT EXISTS approval_attempts_created ON approval_attempts(created_at);
  `);
  initAccounting(db);
  initCommerce(db);
  initDiscounts(db);
  initCheckoutMetadata(db);
  initNotifications(db);
  return db;
}
export function seedMerchant(db: Db, address: string, options: { webhookUrl?: string; webhookSecret?: string } = {}) {
  const merchantId = id('mer');
  const secretKey = `sk_test_${randomBytes(24).toString('hex')}`;
  const publishableKey = `pk_test_${randomBytes(24).toString('hex')}`;
  db.prepare('INSERT INTO merchants VALUES (?,?,?,?,?)').run(merchantId, address, options.webhookUrl ?? null, options.webhookSecret ?? null, now());
  for (const [kind, key] of [['secret', secretKey], ['publishable', publishableKey]])
    db.prepare('INSERT INTO api_keys(id,merchant_id,kind,hash,created_at,revoked_at) VALUES (?,?,?,?,?,NULL)').run(id('key'), merchantId, kind, keyHash(key), now());
  return { merchantId, secretKey, publishableKey };
}
export function amountMinor(input: unknown): bigint {
  if (typeof input !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(input)) throw new Error('Invalid USDT amount');
  const [whole, decimal = ''] = input.split('.');
  const n = BigInt(whole) * 1_000_000n + BigInt(decimal.padEnd(6, '0'));
  if (n <= 0n) throw new Error('Amount must be positive');
  return n;
}
export function amountString(minor: bigint | string | number): string {
  const value = BigInt(minor);
  const n = value < 0n ? -value : value;
  return `${value < 0n ? '-' : ''}${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, '0')}`;
}
