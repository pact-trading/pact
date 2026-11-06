// Pact's margin: fees taken against the relayer's measured gas, from the API database (read only).
//   DATABASE_PATH=./settle.sqlite tsx scripts/margin.ts [days] [usdtPerWbt]
// usdtPerWbt is USDT base units per WBT (the FeeSchedule's usdtPerWBT); without it gas stays in wei.
import Database from 'better-sqlite3';
import { relayerMargin } from '../src/margin.js';

const [days = '30', price] = process.argv.slice(2);
const path = process.env.DATABASE_PATH;
if (!path) throw new Error('Set DATABASE_PATH to the API database');
if (!/^[1-9]\d{0,3}$/.test(days) || (price !== undefined && !/^[1-9]\d*$/.test(price))) throw new Error('usage: margin.ts [days] [usdtPerWbt]');
const db = new Database(path, { readonly: true, fileMustExist: true });
try { console.info(JSON.stringify(relayerMargin(db, Number(days), price === undefined ? undefined : BigInt(price)), null, 2)); }
finally { db.close(); }
