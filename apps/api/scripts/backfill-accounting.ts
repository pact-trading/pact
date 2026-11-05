import { openDb } from '../src/db.js';
import { ViemChain, type Addresses } from '../src/chain.js';
import { backfillAccounting } from '../src/accounting-backfill.js';
import { isAddress } from 'viem';

const addresses: Addresses = {
  router: process.env.ROUTER_ADDRESS as Addresses['router'], escrow: process.env.ESCROW_ADDRESS as Addresses['escrow'],
  subscription: process.env.SUBSCRIPTION_ADDRESS as Addresses['subscription'], gasTank: process.env.GAS_TANK_ADDRESS as Addresses['gasTank'],
};
if (!process.env.DATABASE_PATH || !process.env.RPC_URL || Object.values(addresses).some(address => !isAddress(address ?? ''))) throw new Error('DATABASE_PATH, RPC_URL and all four suite addresses are required');
// A public synthetic signer satisfies the adapter constructor. This tool never reads a relayer key or invokes a write method.
const chain = new ViemChain(process.env.RPC_URL, `0x${'1'.repeat(64)}`, addresses);
const db = openDb(process.env.DATABASE_PATH);
try {
  const result = await backfillAccounting(db, chain, BigInt(process.env.CONFIRMATIONS ?? '2'));
  console.info(JSON.stringify(result));
  if (result.unresolved.length) process.exitCode = 1;
} finally { db.close(); }
