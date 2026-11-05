// Live Whitechain Sepolia run: capped subscription, accepted renewal, refused early renewal, cancel, refused after cancel.
// Uses the test deployment with a self-issued token (not the prize USDT).
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData, keccak256, toHex, decodeEventLog, defineChain, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';

const env = Object.fromEntries(readFileSync(new URL('../../../.env.wallets', import.meta.url), 'utf8').split('\n').filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const PRIZE = process.env.USE_PRIZE_USDT === '1';
const A: Record<string, Hex> = (PRIZE
  ? { token: '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7', router: '0x014BC0e127D4660a3ef369a9d71a57e727a7D34f', sub: '0xAAB13cEfEb4291842439Bb958F54C11459e09573' }
  : { token: '0x92A7AE8BD75312594f31165bd87DfbfBaC58997D', router: '0x60691AA1CE5c1e1232E1D4C5E1af1fed4f522204', sub: '0xaB985CaD4589e18B6f1a2e56cA7a2d9E0673eA88' });
const chain = defineChain({ id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [env.WHITECHAIN_RPC!] } } });
const pub = createPublicClient({ chain, transport: http() });
const merchant = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY as Hex);
const keeper = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as Hex);
const payer = privateKeyToAccount(env.PAYER_PRIVATE_KEY as Hex);
const w = (a: typeof merchant) => createWalletClient({ account: a, chain, transport: http() });
const subAbi = parseAbi([
  'function subscribe((address payer,address merchant,bytes32 planId,uint256 amountCap,uint64 periodSeconds,uint32 maxPeriods,uint64 endTime,uint256 nonce) m, bytes sig) returns (bytes32)',
  'function charge(bytes32 id,uint256 amount) returns (bool)', 'function cancel(bytes32 id)', 'function nonces(address) view returns (uint256)',
  'event Subscribed(bytes32 indexed id,address indexed payer,address indexed merchant,bytes32 planId)', 'event Charged(bytes32 indexed id,uint256 amount,uint32 period)',
  'event Refused(bytes32 indexed id,uint8 reason)', 'event Cancelled(bytes32 indexed id)']);
const erc = parseAbi(['function approve(address,uint256)']);
const reasons = ['Cancelled', 'Expired', 'TooEarly', 'CapExceeded', 'MaxPeriods', 'InsufficientFunds', 'TransferFailed'];
const link = (h: string) => `https://explorer.testnet.whitechain.io/tx/${h}`;
const out: Record<string, string> = {};
async function tx(account: typeof merchant, to: Hex, data: Hex) { const hash = await w(account).sendTransaction({ to, data, gas: 600_000n }); const r = await pub.waitForTransactionReceipt({ hash }); if (r.status !== 'success') throw new Error(`failed ${hash}`); return { hash, r }; }
function events(r: { logs: readonly { address: string; data: Hex; topics: readonly Hex[] }[] }) {
  return r.logs.filter(l => l.address.toLowerCase() === A.sub.toLowerCase()).map(l => { try { return decodeEventLog({ abi: subAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }); } catch { return null; } }).filter(Boolean) as { eventName: string; args: Record<string, unknown> }[];
}
const nonce = await pub.readContract({ address: A.sub, abi: subAbi, functionName: 'nonces', args: [payer.address] });
const m = { payer: payer.address, merchant: merchant.address, planId: keccak256(toHex('growth-plan')), amountCap: (PRIZE ? 1_000_000n : 49_000_000n), periodSeconds: 2_592_000n, maxPeriods: 12, endTime: BigInt(Math.floor(Date.now() / 1000) + 31_536_000), nonce };
const signature = await payer.signTypedData({ domain: { name: 'Settle Subscription', version: '1', chainId: 1874, verifyingContract: A.sub }, types: { Mandate: [{ name: 'payer', type: 'address' }, { name: 'merchant', type: 'address' }, { name: 'planId', type: 'bytes32' }, { name: 'amountCap', type: 'uint256' }, { name: 'periodSeconds', type: 'uint64' }, { name: 'maxPeriods', type: 'uint32' }, { name: 'endTime', type: 'uint64' }, { name: 'nonce', type: 'uint256' }] }, primaryType: 'Mandate', message: m });
out.payerApprovesSubscriptions = link((await tx(payer, A.token, encodeFunctionData({ abi: erc, functionName: 'approve', args: [A.sub, 2n ** 255n] }))).hash);
const s = await tx(keeper, A.sub, encodeFunctionData({ abi: subAbi, functionName: 'subscribe', args: [m, signature] }));
const id = events(s.r).find(e => e.eventName === 'Subscribed')!.args.id as Hex;
out.subscribe = link(s.hash); out.subscriptionId = id;
const c0 = await tx(keeper, A.sub, encodeFunctionData({ abi: subAbi, functionName: 'charge', args: [id, (PRIZE ? 2_000_000n : 99_000_000n)] }));
const r0 = events(c0.r).find(e => e.eventName === 'Refused'); out.overCapFirst = link(c0.hash); out.overCapFirstResult = r0 ? `Refused: ${reasons[Number(r0.args.reason)]}` : 'charged';
const c1 = await tx(keeper, A.sub, encodeFunctionData({ abi: subAbi, functionName: 'charge', args: [id, (PRIZE ? 1_000_000n : 49_000_000n)] }));
out.renewal1 = link(c1.hash); out.renewal1Result = events(c1.r).map(e => e.eventName).join(',');
const c2 = await tx(keeper, A.sub, encodeFunctionData({ abi: subAbi, functionName: 'charge', args: [id, (PRIZE ? 1_000_000n : 49_000_000n)] }));
const r2 = events(c2.r).find(e => e.eventName === 'Refused'); out.earlyRenewal = link(c2.hash); out.earlyRenewalResult = r2 ? `Refused: ${reasons[Number(r2.args.reason)]}` : events(c2.r).map(e => e.eventName).join(',');
const c3 = await tx(keeper, A.sub, encodeFunctionData({ abi: subAbi, functionName: 'charge', args: [id, (PRIZE ? 2_000_000n : 99_000_000n)] }));
const r3 = events(c3.r).find(e => e.eventName === 'Refused'); out.overCapRenewal = link(c3.hash); out.overCapResult = r3 ? `Refused: ${reasons[Number(r3.args.reason)]}` : 'charged';
out.cancel = link((await tx(payer, A.sub, encodeFunctionData({ abi: subAbi, functionName: 'cancel', args: [id] }))).hash);
const c4 = await tx(keeper, A.sub, encodeFunctionData({ abi: subAbi, functionName: 'charge', args: [id, (PRIZE ? 1_000_000n : 49_000_000n)] }));
const r4 = events(c4.r).find(e => e.eventName === 'Refused'); out.afterCancel = link(c4.hash); out.afterCancelResult = r4 ? `Refused: ${reasons[Number(r4.args.reason)]}` : 'charged';
console.log(JSON.stringify(out, null, 2));
