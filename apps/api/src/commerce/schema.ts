import type { Db } from '../db.js';
export function initCommerce(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS commerce_products(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL REFERENCES merchants(id),revision INTEGER NOT NULL,status TEXT NOT NULL CHECK(status IN ('draft','active','archived')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS commerce_products_merchant ON commerce_products(merchant_id,id);
    CREATE TABLE IF NOT EXISTS commerce_product_revisions(product_id TEXT NOT NULL REFERENCES commerce_products(id),revision INTEGER NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(product_id,revision));
    CREATE TABLE IF NOT EXISTS commerce_customers(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL REFERENCES merchants(id),subject_id TEXT NOT NULL,wallet TEXT NOT NULL,email TEXT,name TEXT,created_at TEXT NOT NULL,UNIQUE(merchant_id,subject_id));
    CREATE TABLE IF NOT EXISTS commerce_orders(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL REFERENCES merchants(id),customer_id TEXT NOT NULL REFERENCES commerce_customers(id),product_id TEXT NOT NULL,product_revision INTEGER NOT NULL,product_name TEXT NOT NULL,amount_minor TEXT NOT NULL,currency TEXT NOT NULL CHECK(currency IN ('USDT','USD')),rail TEXT NOT NULL CHECK(rail IN ('whitechain','stripe')),payment_id TEXT UNIQUE REFERENCES payments(id),provider_session_id TEXT UNIQUE,created_at TEXT NOT NULL,FOREIGN KEY(product_id,product_revision) REFERENCES commerce_product_revisions(product_id,revision));
    CREATE TABLE IF NOT EXISTS commerce_checkout_sessions(id TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE REFERENCES commerce_orders(id),merchant_id TEXT NOT NULL,subject_id TEXT NOT NULL,idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(merchant_id,subject_id,idempotency_key));
    CREATE TABLE IF NOT EXISTS commerce_payment_attempts(id TEXT PRIMARY KEY,order_id TEXT NOT NULL UNIQUE REFERENCES commerce_orders(id),rail TEXT NOT NULL,payment_id TEXT UNIQUE REFERENCES payments(id),provider_session_id TEXT UNIQUE,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS commerce_order_events(order_id TEXT NOT NULL REFERENCES commerce_orders(id),type TEXT NOT NULL,source_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(order_id,type,source_id));
    -- The latest deadline (unix seconds) of a charge a payer was given to sign for a hosted payment.
    CREATE TABLE IF NOT EXISTS hosted_intent_offers(payment_id TEXT PRIMARY KEY REFERENCES payments(id),deadline INTEGER NOT NULL);
  `);
  for (const table of ['commerce_product_revisions', 'commerce_orders', 'commerce_checkout_sessions', 'commerce_payment_attempts']) for (const action of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${action.toLowerCase()} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable commerce snapshot'); END;`);
}
