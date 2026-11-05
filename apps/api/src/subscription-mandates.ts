import { encodeAbiParameters, hashTypedData, keccak256, toHex, type Address, type Hex } from 'viem';
import { now, type Db } from './db.js';
import type { Mandate, MerchantConsent } from './types.js';
import { mandateTypedData } from './typed-data.js';

export interface SignedSubscriptionMandate {
  manager: Address; version: 1 | 2; mandateHash: Hex; mandate: Mandate;
  payerSignature: Hex; merchantConsent?: MerchantConsent;
}
const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);

export function initSubscriptionMandates(db: Db) {
  db.exec(`CREATE TABLE IF NOT EXISTS subscription_mandates(
    subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id),
    payload TEXT NOT NULL,payload_hash TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS subscription_mandates_no_update BEFORE UPDATE ON subscription_mandates
      BEGIN SELECT RAISE(ABORT,'immutable subscription mandate'); END;
    CREATE TRIGGER IF NOT EXISTS subscription_mandates_no_delete BEFORE DELETE ON subscription_mandates
      BEGIN SELECT RAISE(ABORT,'immutable subscription mandate'); END;`);
}

/** Call only after payer/merchant signatures have been verified, within the
 * writer's subscription reservation transaction, before submission can await.
 * This preserves signed terms, not proof of onchain registration or delegation. */
export function snapshotSubscriptionMandate(db: Db, subscriptionId: string, input: Omit<SignedSubscriptionMandate, 'mandateHash'>) {
  if (!db.inTransaction) throw new Error('Subscription mandate requires atomic reservation');
  const row = db.prepare('SELECT chain_id,payer,plan_id,m.address FROM subscriptions s JOIN merchants m ON m.id=s.merchant_id WHERE s.id=?').get(subscriptionId) as { chain_id: string; payer: string; plan_id: string; address: string } | undefined;
  const m = input.mandate;
  const chainId = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'address' }], [m.payer, m.nonce, input.manager]));
  if (!row || row.chain_id.toLowerCase() !== chainId || row.payer.toLowerCase() !== m.payer.toLowerCase() || row.address.toLowerCase() !== m.merchant.toLowerCase() || keccak256(toHex(row.plan_id)) !== m.planId || (input.version === 2 && !input.merchantConsent)) throw new Error('Subscription mandate binding mismatch');
  const mandateHash = hashTypedData(mandateTypedData(m, input.manager, input.version === 2 ? '2' : '1'));
  const payload = json({ ...input, mandateHash });
  db.prepare('INSERT INTO subscription_mandates VALUES (?,?,?,?)').run(subscriptionId, payload, keccak256(toHex(payload)), now());
}

/** Legacy rows intentionally have no snapshot; never infer a nonce/end time
 * from the current plan or silently backfill unverified historical consent. */
export function readSubscriptionMandate(db: Db, subscriptionId: string): SignedSubscriptionMandate | undefined {
  const row = db.prepare('SELECT payload,payload_hash FROM subscription_mandates WHERE subscription_id=?').get(subscriptionId) as { payload: string; payload_hash: Hex } | undefined;
  if (!row) return;
  if (keccak256(toHex(row.payload)) !== row.payload_hash) throw new Error('Subscription mandate digest mismatch');
  const value = JSON.parse(row.payload) as SignedSubscriptionMandate;
  for (const key of ['amountCap', 'periodSeconds', 'endTime', 'nonce'] as const) value.mandate[key] = BigInt(value.mandate[key]);
  if (value.merchantConsent) value.merchantConsent.deadline = BigInt(value.merchantConsent.deadline);
  if (hashTypedData(mandateTypedData(value.mandate, value.manager, value.version === 2 ? '2' : '1')) !== value.mandateHash) throw new Error('Subscription mandate digest mismatch');
  return value;
}
