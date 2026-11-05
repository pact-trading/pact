import { encodeFunctionData, keccak256, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { escrowAbi } from './chain.js';
import { id, now, type Db } from './db.js';
import { recordRefusal } from './refusals.js';
import type { Relayer } from './relayer.js';
import { intentTypedData } from './typed-data.js';
import type { ChainAdapter, IntentRequest } from './types.js';
import { Refusal } from './types.js';

/** The eight layers that stop a drain (PRD §5.8): five enforced by contracts, three by the relayer. */
export const SECURITY_LAYERS = [
  { id: 1, name: 'Function allowlist', enforcedIn: 'contract', stops: 'Using the relayer to run arbitrary transactions', reasons: ['wrong_selector', 'data_hash', 'target_refused', 'invalid_address'] },
  { id: 2, name: 'Per-merchant gas tank', enforcedIn: 'contract', stops: "One merchant's gas paying for another merchant's traffic", reasons: ['tank_limit', 'quote_mismatch', 'merchant_mismatch'] },
  { id: 3, name: 'Daily caps per payer and merchant', enforcedIn: 'contract', stops: 'Spam from one payer or one merchant', reasons: ['payer_daily_cap', 'merchant_daily_sponsorship_cap'] },
  { id: 4, name: 'Minimum amount, fee covers gas', enforcedIn: 'contract', stops: "Dust payments at the merchant's expense", reasons: ['dust', 'fee_too_low', 'fee_unavailable'] },
  { id: 5, name: 'Signature, nonce and deadline', enforcedIn: 'contract', stops: 'Replays and stale intents', reasons: ['invalid_signature', 'replay', 'deadline'] },
  { id: 6, name: 'Simulate before broadcast', enforcedIn: 'relayer', stops: 'Paying gas for transactions that would fail', reasons: ['simulation_refused', 'target_failed'] },
  { id: 7, name: 'Gas caps per call', enforcedIn: 'relayer', stops: 'Gas price spikes and gas-heavy calls', reasons: ['gas_limit', 'gas_price'] },
  { id: 8, name: 'Hot wallet float and circuit breaker', enforcedIn: 'relayer', stops: 'A bug or leaked key emptying the float', reasons: ['circuit_open', 'circuit_budget', 'merchant_circuit_budget'] },
] as const;
export const layerFor = (reason: string) => SECURITY_LAYERS.find(l => (l.reasons as readonly string[]).includes(reason))?.id ?? null;

export function initSecurity(db: Db) {
  db.exec('CREATE TABLE IF NOT EXISTS drain_runs(id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)');
}
export function securityLayers(db: Db, merchantId: string) {
  const counts = new Map((db.prepare("SELECT reason,count(*) n FROM refusal_attempts WHERE merchant_id=? AND (source IN ('relayer','contract') OR source IS NULL) GROUP BY reason").all(merchantId) as Array<{ reason: string; n: number }>).map(r => [r.reason, r.n]));
  return SECURITY_LAYERS.map(l => ({ ...l, reasons: [...l.reasons], blocked: l.reasons.reduce((t, r) => t + (counts.get(r) ?? 0), 0) }));
}

/** Every refusal for this merchant: relayer and contract refusals, plus refused intents not yet mirrored. */
export function refusalsFeed(db: Db, merchantId: string, limit = 100) {
  const rows = db.prepare(`SELECT id,object_id AS objectId,reason,tx_hash AS txHash,created_at AS createdAt,source,signer FROM refusal_attempts WHERE merchant_id=?
    UNION ALL SELECT id,signer AS objectId,reason,tx_hash AS txHash,created_at AS createdAt,'contract' AS source,signer FROM intents
      WHERE merchant_id=? AND status='refused' AND NOT EXISTS (SELECT 1 FROM refusal_attempts r WHERE lower(r.tx_hash)=lower(intents.tx_hash))
    ORDER BY createdAt DESC LIMIT ?`).all(merchantId, merchantId, Math.max(1, Math.min(500, limit))) as Array<{ id: string; objectId: string; reason: string; txHash: Hex | null; createdAt: string; source: string | null; signer: string | null }>;
  return rows.map(r => ({ ...r, layer: layerFor(r.reason) }));
}

type Attack = 'replay' | 'dust' | 'arbitrary_calldata' | 'spam_accounts' | 'over_daily_cap' | 'stale_deadline';
const LABELS: Record<Attack, string> = {
  replay: 'Replay a sponsored payment that already ran',
  dust: 'Dust payment of 0.000001 USDT',
  arbitrary_calldata: 'Arbitrary calldata through the Router',
  spam_accounts: 'Spam from a new account, fee below gas',
  over_daily_cap: 'Gas-heavy call above the per-call cap',
  stale_deadline: 'Intent with an expired deadline',
};

/**
 * A live drain attempt against this merchant: fresh attacker keys sign intents that try to spend the
 * merchant's tank. Each one is refused before simulation, so no gas is spent, the merchant's circuit
 * breaker is not tripped, and the tank balance does not move. The results are stored and shown.
 */
export async function runDrain(db: Db, chain: ChainAdapter, relayer: Relayer, merchant: { merchantId: string; address: Address }, contracts: { router: Address; escrow: Address }) {
  const before = await chain.gasTank(merchant.address);
  const quote = await relayer.quote().catch(() => ({ minimumFeeMinor: '10000', minimumAmountMinor: '1000000', targetGas: 300_000 }));
  const attacker = () => privateKeyToAccount(generatePrivateKey());
  const sign = async (opts: { amount?: bigint; fee?: bigint; data?: Hex; deadline?: bigint; maxGas?: number; tamper?: boolean } = {}): Promise<IntentRequest & { actor: Address }> => {
    const account = attacker();
    const data = opts.data ?? encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [keccak256(toHex(id('drain'))), merchant.address, opts.amount ?? 2_000_000n, 2_592_000n] });
    const intent = { signer: account.address, merchant: merchant.address, target: contracts.escrow, dataHash: keccak256(data), amount: opts.amount ?? 2_000_000n, feeUSDT: opts.fee ?? BigInt(quote.minimumFeeMinor), nonce: BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000)), deadline: opts.deadline ?? BigInt(Math.floor(Date.now() / 1000) + 300), maxGas: opts.maxGas ?? Number(quote.targetGas) };
    const signature = await account.signTypedData(intentTypedData(intent, contracts.router));
    // Tampering flips the last byte to a different value, so the signed data hash no longer matches.
    const tampered = `${data.slice(0, -2)}${data.endsWith('01') ? '02' : '01'}` as Hex;
    return { intent, data: opts.tamper ? tampered : data, signature, actor: account.address };
  };
  const attempts: Array<{ id: string; attack: Attack; label: string; actor: string; result: 'refused' | 'sent'; reason: string; layer: number }> = [];
  const attempt = async (attack: Attack, request: IntentRequest & { actor: Address }, label = LABELS[attack]) => {
    let result: 'refused' | 'sent' = 'sent', reason = '';
    // Preflight only: the relayer's checks run, but nothing can be simulated, signed or sent.
    try { await relayer.preflight(request); reason = 'passed_checks_not_sent'; }
    catch (error) { result = 'refused'; reason = error instanceof Refusal ? error.code : 'error'; }
    attempts.push({ id: id('att'), attack, label, actor: request.actor, result, reason, layer: layerFor(reason) ?? 0 });
  };
  // A previously executed intent of this merchant, resent byte for byte.
  const executed = db.prepare("SELECT request_json FROM intents WHERE merchant_id=? AND tx_hash IS NOT NULL ORDER BY created_at DESC LIMIT 1").get(merchant.merchantId) as { request_json: string } | undefined;
  if (executed) {
    const old = JSON.parse(executed.request_json) as IntentRequest;
    const request = { ...old, intent: { ...old.intent, amount: BigInt(old.intent.amount), feeUSDT: BigInt(old.intent.feeUSDT), nonce: BigInt(old.intent.nonce), deadline: BigInt(old.intent.deadline) } };
    await attempt('replay', { ...request, actor: old.intent.signer });
  }
  await attempt('dust', await sign({ amount: 1n }));
  await attempt('arbitrary_calldata', await sign({ data: '0xdeadbeef00000000000000000000000000000000000000000000000000000000' }));
  await attempt('arbitrary_calldata', await sign({ tamper: true }), 'Calldata changed after signing');
  await attempt('stale_deadline', await sign({ deadline: BigInt(Math.floor(Date.now() / 1000) - 60) }));
  await attempt('over_daily_cap', await sign({ maxGas: 5_000_000 }));
  for (let n = 0; n < 50; n++) await attempt('spam_accounts', await sign({ fee: 0n }), `${LABELS.spam_accounts} (${n + 1}/50)`);
  const after = await chain.gasTank(merchant.address);
  const run = { id: id('drain'), startedAt: now(), attempts, legitimateSent: 0, tankBeforeWei: before.balanceWei.toString(), tankAfterWei: after.balanceWei.toString() };
  db.prepare('INSERT INTO drain_runs VALUES (?,?,?,?)').run(run.id, merchant.merchantId, JSON.stringify(run), run.startedAt);
  return run;
}
export function drainRuns(db: Db, merchantId: string) {
  return (db.prepare('SELECT payload FROM drain_runs WHERE merchant_id=? ORDER BY created_at DESC LIMIT 10').all(merchantId) as Array<{ payload: string }>).map(r => JSON.parse(r.payload));
}
export { recordRefusal };
