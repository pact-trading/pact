import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { openDb, seedMerchant } from '../src/db.js';
import { rehearseCommerceMigration } from '../scripts/rehearse-commerce-migration.js';

const directories: string[] = [];
afterEach(() => { directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pact-migration-')); directories.push(dir);
  const path = join(dir, 'source.sqlite');
  const db = openDb(path);
  // Simulate the pre-commerce runtime, keeping committed rows in its WAL.
  for (const table of ['commerce_order_events', 'commerce_payment_attempts', 'commerce_checkout_sessions', 'commerce_orders', 'commerce_customers', 'commerce_product_revisions', 'commerce_products']) db.exec(`DROP TABLE ${table}`);
  const merchant = seedMerchant(db, `0x${'1'.repeat(40)}`);
  db.prepare("INSERT INTO payments(id,merchant_id,amount_minor,captured_minor,refunded_minor,status,created_at) VALUES ('payment',?,'2000000','2000000','1000000','captured','2026-11-06')").run(merchant.merchantId);
  return { dir, path, db };
}
it('backs up WAL rows, preserves historical data and migrates only the private copy', async () => {
  const f = fixture();
  try {
    const output = join(f.dir, 'rehearsal');
    const report = await rehearseCommerceMigration(f.path, output);
    expect(report.tables.find(t => t.table === 'payments')).toEqual({ table: 'payments', rows: 1, preserved: true });
    expect(report.addedTables).toHaveLength(7);
    expect(f.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'commerce_%'").all()).toEqual([]);
    const copy = new Database(join(output, 'before.sqlite'), { readonly: true });
    expect(copy.prepare('SELECT captured_minor,refunded_minor FROM payments').get()).toEqual({ captured_minor: '2000000', refunded_minor: '1000000' }); copy.close();
    for (const name of ['before.sqlite', 'candidate.sqlite', 'report.json']) expect(statSync(join(output, name)).mode & 0o777).toBe(0o600);
    expect(statSync(output).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(output, 'report.json'), 'utf8')).not.toContain('sk_test_');
    await expect(rehearseCommerceMigration(f.path, output)).rejects.toThrow();
  } finally { f.db.close(); }
});
it('refuses a missing source without creating a replacement database', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pact-migration-')); directories.push(dir);
  await expect(rehearseCommerceMigration(join(dir, 'missing.sqlite'), join(dir, 'output'))).rejects.toThrow();
});
