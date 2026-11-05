import { openDb, seedMerchant } from '../src/db.js';
import { privateKeyToAccount } from 'viem/accounts';
const db = openDb(process.env.DATABASE_PATH!);
const merchant = privateKeyToAccount(`0x${'1'.repeat(64)}`);
console.log(JSON.stringify(seedMerchant(db, merchant.address)));
db.close();
