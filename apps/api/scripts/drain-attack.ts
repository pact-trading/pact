import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import { FakeChain, escrowAbi } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { intentTypedData } from '../src/typed-data.js';
import { Refusal, type IntentRequest } from '../src/types.js';

// Offline drain run against the in-memory chain: one legitimate payment goes through, then fresh
// attacker keys try to replay it, send dust or arbitrary calldata, and spend the merchant's USDT
// with refunds it never signed. Every attempt must be refused before anything is sent.
const router = '0x0000000000000000000000000000000000000001' as Address;
const escrow = '0x0000000000000000000000000000000000000002' as Address;
const subscription = '0x0000000000000000000000000000000000000003' as Address;
const merchant = '0x0000000000000000000000000000000000000004' as Address;
const chain = new FakeChain();
// The merchant signed Pact's fee terms; nothing else about it is trusted.
chain.accepted.set(merchant.toLowerCase(), 1);
const relayer = new Relayer(chain, router, allowedTargets({ escrow, subscription }));
const paymentId = `0x${'a'.repeat(64)}` as Hex;
const data = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [paymentId, merchant, 2_000_000n, 2_592_000n] });
const refund = encodeFunctionData({ abi: escrowAbi, functionName: 'refund', args: [paymentId, 1_000_000n, keccak256('0x01')] });
async function request(n: number, opts: { amount?: bigint; data?: Hex } = {}): Promise<IntentRequest> {
  const account = privateKeyToAccount(`0x${(n + 1).toString(16).padStart(64, '0')}`);
  const call = opts.data ?? data;
  const intent = { signer: account.address, merchant, target: escrow, dataHash: keccak256(call), amount: opts.amount ?? 2_000_000n, nonce: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), maxGas: 300_000 };
  const signature = await account.signTypedData(intentTypedData(intent, router));
  return { intent, signature, data: call };
}
async function attempt(label: string, value: IntentRequest, expected: string) {
  try { await relayer.submit(value); console.log(`${label}: UNEXPECTED ACCEPT`); process.exitCode = 1; }
  catch (e) { const code = e instanceof Refusal ? e.code : String(e); console.log(`${label}: refused ${code}`); if (code !== expected) process.exitCode = 1; }
}
const first = await request(1);
await relayer.submit(first);
await attempt('replay', first, 'replay');
await attempt('dust', await request(2, { amount: 1n }), 'dust');
await attempt('arbitrary calldata', await request(3, { data: '0xdeadbeef' }), 'wrong_selector');
for (let n = 4; n < 54; n++) await attempt(`unsigned refund spending the merchant's USDT ${n - 3}/50`, await request(n, { data: refund, amount: 1_000_000n }), 'signer_not_merchant');
console.log(`Relayer sent ${chain.sent.length} legitimate transaction; attack attempts sent 0.`);
