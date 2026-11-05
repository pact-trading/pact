import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import { FakeChain, escrowAbi } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { Refusal, type IntentRequest } from '../src/types.js';

const router = '0x0000000000000000000000000000000000000001' as Address;
const escrow = '0x0000000000000000000000000000000000000002' as Address;
const subscription = '0x0000000000000000000000000000000000000003' as Address;
const merchant = '0x0000000000000000000000000000000000000004' as Address;
const chain = new FakeChain();
chain.tank.set(merchant.toLowerCase(), { balanceWei: 10n ** 18n, dailyCapWei: 10n ** 18n, spentTodayWei: 0n });
const relayer = new Relayer(chain, router, allowedTargets(escrow, subscription));
const paymentId = `0x${'a'.repeat(64)}` as Hex;
const data = encodeFunctionData({ abi: escrowAbi, functionName: 'charge', args: [paymentId, merchant, 2_000_000n, 2_592_000n] });
const types = { Intent: [
  { name: 'signer', type: 'address' }, { name: 'merchant', type: 'address' }, { name: 'target', type: 'address' },
  { name: 'dataHash', type: 'bytes32' }, { name: 'amount', type: 'uint256' }, { name: 'feeUSDT', type: 'uint256' },
  { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint64' }, { name: 'maxGas', type: 'uint32' },
] } as const;
async function request(n: number, opts: { amount?: bigint; fee?: bigint; data?: Hex } = {}): Promise<IntentRequest> {
  const account = privateKeyToAccount(`0x${(n + 1).toString(16).padStart(64, '0')}`);
  const call = opts.data ?? data;
  const intent = { signer: account.address, merchant, target: escrow, dataHash: keccak256(call), amount: opts.amount ?? 2_000_000n, feeUSDT: opts.fee ?? 10_000n, nonce: 0n, deadline: BigInt(Math.floor(Date.now() / 1000) + 3600), maxGas: 300_000 };
  const signature = await account.signTypedData({ domain: { name: 'Settle Router', version: '1', chainId: 1874, verifyingContract: router }, types, primaryType: 'Intent', message: intent });
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
for (let n = 4; n < 54; n++) await attempt(`spam account ${n - 3}/50`, await request(n, { fee: 0n }), 'fee_too_low');
console.log(`Relayer sent ${chain.sent.length} legitimate transaction; attack attempts sent 0.`);
