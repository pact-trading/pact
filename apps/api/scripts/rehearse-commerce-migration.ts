// Read-only source backup and isolated migration rehearsal. No server, signer,
// indexer, keeper, RPC client or webhook worker is started by this command.
import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openDb } from '../src/db.js';

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
function tableNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(row => row.name);
}
function columns(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${quote(table)})`).all() as { name: string }[]).map(row => row.name);
}
function fingerprint(db: Database.Database, table: string, fields: string[]) {
  const rows = [...db.prepare(`SELECT ${fields.map(quote).join(',')} FROM ${quote(table)}`).safeIntegers().iterate()]
    .map(row => createHash('sha256').update(json(row)).digest('hex')).sort();
  return { count: rows.length, hash: createHash('sha256').update(rows.join('\n')).digest('hex') };
}
function integrity(db: Database.Database) {
  assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }], 'SQLite integrity check failed');
  assert.deepEqual(db.pragma('foreign_key_check'), [], 'SQLite foreign key check failed');
}

export async function rehearseCommerceMigration(sourcePath: string, outputDirectory: string) {
  // Never pass the source into openDb: it performs migrations on construction.
  const source = realpathSync(sourcePath);
  const directory = resolve(outputDirectory);
  // Exclusive directory creation refuses retries/overwrites and symlink targets.
  mkdirSync(directory, { mode: 0o700 });
  const backup = join(directory, 'before.sqlite'), candidate = join(directory, 'candidate.sqlite');
  const reader = new Database(source, { readonly: true, fileMustExist: true });
  try { await reader.backup(backup); } finally { reader.close(); }
  chmodSync(backup, 0o600);
  const before = new Database(backup, { readonly: true, fileMustExist: true });
  let migrated: Database.Database | undefined;
  try {
    integrity(before);
    await before.backup(candidate); chmodSync(candidate, 0o600);
    migrated = openDb(candidate);
    integrity(migrated);
    const tables = tableNames(before).map(table => {
      const fields = columns(before, table);
      assert.deepEqual(fingerprint(migrated!, table, fields), fingerprint(before, table, fields), `Historical rows changed: ${table}`);
      return { table, rows: fingerprint(before, table, fields).count, preserved: true };
    });
    const addedTables = tableNames(migrated).filter(table => !tableNames(before).includes(table));
    // Reopening is the actual startup migration path; verify it is repeatable.
    migrated.close(); migrated = undefined;
    migrated = openDb(candidate); integrity(migrated);
    for (const { table } of tables) assert.deepEqual(fingerprint(migrated, table, columns(before, table)), fingerprint(before, table, columns(before, table)), `Reopen changed historical rows: ${table}`);
    const commerceTables = tableNames(migrated).filter(table => table.startsWith('commerce_'));
    assert.equal(commerceTables.length, 7, 'Expected all seven commerce tables');
    const report = { recordedAt: new Date().toISOString(), sourceOpenedReadOnly: true, backupMethod: 'SQLite online backup API', migrationTarget: 'candidate.sqlite only', sourceMigrated: false, networkWrites: false, integrity: 'ok', foreignKeys: 'ok', reopen: 'ok', tables, addedTables, commerceTables };
    writeFileSync(join(directory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return report;
  } finally { migrated?.close(); before.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output) throw new Error('Usage: tsx scripts/rehearse-commerce-migration.ts SOURCE_DB NEW_PRIVATE_DIRECTORY');
  console.log(JSON.stringify(await rehearseCommerceMigration(source, output), null, 2));
}
