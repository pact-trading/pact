import { DatabaseSync } from 'node:sqlite';
import { initFulfillment } from '../fulfillment.ts';

let db: DatabaseSync | undefined;
/** Opened on first use, so building the app never creates a database. */
export function storeDb() {
  if (!db) {
    db = new DatabaseSync(process.env.PACT_STORE_DB || './merchant-store.sqlite');
    db.exec('PRAGMA journal_mode=WAL');
    initFulfillment(db);
  }
  return db;
}
