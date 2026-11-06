// Deploys the Pact suite to Whitechain Sepolia (chain 1874): the same contracts and settings as the
// local fork (scripts/live/deploy.ts), signed by the deployer in a private env file. The relayer
// address from that file becomes the SubscriptionManager keeper, the FeeSchedule's price keeper and,
// until a fee vault exists, its fee recipient. The WBT price starts at the testnet pool's.
//
// 1. Rehearse on a local Anvil fork of the testnet. Sends nothing to the testnet:
//      anvil --fork-url https://rpc.testnet.whitechain.io --port 8546 --hardfork prague
//      tsx scripts/testnet/deploy.ts --rpc http://127.0.0.1:8546 --keys ../../.env.testnet --out <rehearsal.json>
// 2. Execute exactly the rehearsed plan on the testnet, under a fee cap:
//      tsx scripts/testnet/deploy.ts --rpc https://rpc.testnet.whitechain.io --keys ../../.env.testnet \
//        --rehearsal <rehearsal.json> --max-fee-wbt 0.1 --out ../../contracts/deployment-testnet-<date>.json --execute
//
// Keys stay in memory and are never printed. The output file holds public data only. It is written before
// each send, so a stopped run can be reconciled from it; the script never overwrites an existing one.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BaseError, createPublicClient, encodeDeployData, encodeFunctionData, formatEther, getContractAddress, http, keccak256,
  parseAbi, parseEther, type Abi, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { USDT } from '../../src/token.js';
import { ALLOWLIST, INITIAL_TERMS, ROUTER_LIMITS, allowFlags, termsTuple } from '../../src/suite.js';
import { readPoolPrice } from '../../src/treasury.js';
import { privateKey, readEnvFile } from './keys.js';

const { values: args } = parseArgs({
  options: {
    rpc: { type: 'string' }, keys: { type: 'string' }, out: { type: 'string' }, rehearsal: { type: 'string' },
    'max-fee-wbt': { type: 'string' }, 'fee-recipient': { type: 'string' }, 'usdt-per-wbt': { type: 'string' }, execute: { type: 'boolean', default: false },
  },
});
const fail = (message: string): never => { console.error(`[deploy] ${message}`); process.exit(1); };
if (!args.rpc || !args.keys || !args.out) fail('usage: --rpc <url> --keys <env file> --out <file> [--rehearsal <file> --max-fee-wbt <n> --execute]');
if (existsSync(args.out!)) fail(`${args.out} already exists. Reconcile it; this script never overwrites a deployment record.`);

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const pub = createPublicClient({ transport: http(args.rpc, { timeout: 30_000, retryCount: 2 }), pollingInterval: 1_000 });
const rpc = (method: string, params: unknown[] = []) => pub.request({ method: method as never, params: params as never });
const host = new URL(args.rpc!).hostname;
const local = ['127.0.0.1', 'localhost'].includes(host) && String(await rpc('web3_clientVersion')).toLowerCase().includes('anvil');
if (await pub.getChainId() !== 1874) fail('RPC is not chain 1874');
if (!local && !(args.execute && args.rehearsal && args['max-fee-wbt'])) fail('A testnet run needs --rehearsal, --max-fee-wbt and --execute');
if (local && args.execute) fail('--execute is for the testnet; a local fork run is always a rehearsal');

// Keys: read from the given file only, validated, never logged.
const env = readEnvFile(args.keys!);
const key = (name: string): Hex => { try { return privateKey(env, name); } catch { return fail(`${name} is missing or malformed in ${args.keys}`); } };
const deployer = privateKeyToAccount(key('DEPLOYER_PRIVATE_KEY'));
const relayer = privateKeyToAccount(key('RELAYER_PRIVATE_KEY')).address;
const feeRecipient = (args['fee-recipient'] ?? relayer) as Address;
if (deployer.address.toLowerCase() === relayer.toLowerCase()) fail('Deployer and relayer must be different wallets');

const artifact = (name: string) => {
  const json = JSON.parse(readFileSync(`${root}contracts/out/${name}.sol/${name}.json`, 'utf8'));
  return { abi: json.abi as Abi, bytecode: json.bytecode.object as Hex, runtime: json.deployedBytecode as { object: Hex; immutableReferences?: Record<string, Array<{ start: number; length: number }>> }, ids: json.methodIdentifiers as Record<string, string> };
};
const selector = (name: string, fn: string): Hex => {
  const matches = Object.entries(artifact(name).ids).filter(([signature]) => signature.startsWith(`${fn}(`));
  if (matches.length !== 1) fail(`${name}.${fn} is missing or overloaded`);
  return `0x${matches[0][1]}`;
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
/** Compiled runtime equals deployed runtime, with immutable slots masked (their values are checked through getters)
 * and the trailing CBOR metadata dropped: it hashes source paths, so a build in another directory differs only there. */
const runtimeMatches = (name: string, code: Hex) => {
  const { runtime } = artifact(name);
  const executable = (hex: string) => {
    let out = hex.slice(2).toLowerCase();
    for (const refs of Object.values(runtime.immutableReferences ?? {}))
      for (const { start, length } of refs) out = out.slice(0, start * 2) + '0'.repeat(length * 2) + out.slice((start + length) * 2);
    const metadata = parseInt(out.slice(-4), 16);
    return out.slice(-(metadata + 2) * 2, -(metadata + 2) * 2 + 4) === 'a264' ? out.slice(0, out.length - (metadata + 2) * 2) : out;
  };
  return executable(code) === executable(runtime.object);
};
const sources = ['FeeSchedule', 'Router', 'PaymentEscrow', 'SubscriptionManagerV2', 'SponsoredContext', 'Signatures', 'X402AccountFactory', 'X402AgentAccount', 'PasskeyAccountFactory', 'PasskeyAccount', 'WebAuthn'];
const sourceSha256 = Object.fromEntries(sources.map(name => [`src/${name}.sol`, createHash('sha256').update(readFileSync(`${root}contracts/src/${name}.sol`)).digest('hex')]));

// Chain preconditions: the token (with its EIP-2612 permit) and the pinned x402 runtimes.
const erc20 = parseAbi(['function decimals() view returns (uint8)', 'function DOMAIN_SEPARATOR() view returns (bytes32)']);
if (await pub.readContract({ address: USDT, abi: erc20, functionName: 'decimals' }) !== 6) fail('USDT does not report 6 decimals');
await pub.readContract({ address: USDT, abi: erc20, functionName: 'DOMAIN_SEPARATOR' }).catch(() => fail('USDT has no EIP-2612 permit'));
const reference = JSON.parse(readFileSync(`${root}docs/x402/whitechain-readonly.json`, 'utf8'));
const runtimeHashes: Record<string, Hex> = Object.fromEntries(Object.entries(reference.runtimes as Record<string, { hash: Hex | null }>).filter(([, v]) => v?.hash).map(([k, v]) => [k, v.hash as Hex]));
for (const [address, hash] of Object.entries(runtimeHashes)) {
  const code = await pub.getCode({ address: address as Address });
  if (!code || keccak256(code) !== hash) fail(`x402 reference runtime mismatch at ${address}`);
}
const UPTO = reference.uptoDeployment.expectedAddress as Address;
const uptoMissing = !(await pub.getCode({ address: UPTO }));
runtimeHashes[UPTO] = reference.uptoDeployment.expectedRuntimeHash;
// Uniswap's canonical Permit2 (its runtime is among the pinned hashes checked above): the escrow's Permit2
// collector and passkey accounts spend through it.
const PERMIT2 = reference.exactPermit2 as Address;
if (!runtimeHashes[PERMIT2]) fail(`No pinned runtime for Permit2 at ${PERMIT2}`);

// The plan. Every address is known up front: CREATE addresses follow the deployer nonce.
const startNonce = await pub.getTransactionCount({ address: deployer.address, blockTag: 'latest' });
if (startNonce !== await pub.getTransactionCount({ address: deployer.address, blockTag: 'pending' })) fail('Deployer has pending transactions; wait for them first');
const at = (index: number) => getContractAddress({ from: deployer.address, nonce: BigInt(startNonce + index) });
const contracts = { fees: at(0), router: at(1), escrow: at(2), subscription: at(3), passkeyFactory: at(4) };
// The factory creates its account template (the clones' implementation) in its constructor: its nonce 1.
const passkeyImplementation = getContractAddress({ from: contracts.passkeyFactory, nonce: 1n });
const limits = ROUTER_LIMITS;
// The rehearsal records the price it used; the testnet run uses exactly that, so the plan matches.
const priorRehearsal = args.rehearsal ? JSON.parse(readFileSync(args.rehearsal, 'utf8')) : undefined;
const usdtPerWbt = BigInt(args['usdt-per-wbt'] ?? priorRehearsal?.usdtPerWbt ?? await readPoolPrice(pub));
if (usdtPerWbt <= 0n) fail('Invalid USDT per WBT');
type Step = { label: string; to: Address | null; data: Hex };
const create = (name: string, ctorArgs: unknown[] = []): Step => ({ label: `create ${name}`, to: null, data: encodeDeployData({ abi: artifact(name).abi, bytecode: artifact(name).bytecode, args: ctorArgs }) });
const call = (name: string, to: Address, functionName: string, callArgs: unknown[]): Step => ({ label: `${name}.${functionName}${functionName === 'setAllowed' ? ` ${callArgs[1]}` : ''}`, to, data: encodeFunctionData({ abi: artifact(name).abi, functionName, args: callArgs }) });
const targetOf = { escrow: ['PaymentEscrow', contracts.escrow], subscription: ['SubscriptionManagerV2', contracts.subscription] } as const;
const suiteEntries = ALLOWLIST.filter(entry => entry.contract !== 'receivables'); // Added by deploy-financing.ts.
const plan: Step[] = [
  create('FeeSchedule', [feeRecipient, relayer, usdtPerWbt, termsTuple(INITIAL_TERMS)]),
  create('Router', [USDT, contracts.fees]),
  create('PaymentEscrow', [USDT, contracts.router, contracts.fees, PERMIT2]),
  create('SubscriptionManagerV2', [USDT, contracts.router, relayer, contracts.fees]),
  // Passkey (WebAuthn) customer accounts, which approve Permit2 for USDT when created.
  create('PasskeyAccountFactory', [USDT, PERMIT2]),
  ...suiteEntries.map(entry => {
    const [name, address] = targetOf[entry.contract as 'escrow' | 'subscription'];
    return call('Router', contracts.router, 'setAllowed', [address, selector(name, entry.fn), ...allowFlags(entry)]);
  }),
  // Same as the local fork: a higher per-payer daily count than the default 10, so one tester can try every flow.
  call('Router', contracts.router, 'setLimits', [limits.minAmount, limits.maxPayerCallsPerDay, limits.maxGasPerCall, limits.maxGasPrice]),
  ...(uptoMissing ? [{ label: 'create canonical x402 upto (CREATE2)', to: reference.uptoDeployment.to as Address, data: reference.uptoDeployment.data as Hex }] : []),
];
const factory = at(plan.length);
plan.push(create('X402AccountFactory'));
for (const address of [...Object.values(contracts), passkeyImplementation, factory]) if (await pub.getCode({ address })) fail(`Predicted address ${address} already has code`);

// Gas: a rehearsal measures it; a testnet run uses the rehearsed amounts plus a margin, and must match the plan exactly.
let gasLimits: bigint[];
if (local) gasLimits = plan.map(() => 10_000_000n);
else {
  const rehearsal = priorRehearsal;
  if (rehearsal.status !== 'verified' || rehearsal.mode !== 'rehearsal') fail('Rehearsal did not complete and verify');
  if (!same(rehearsal.accounts.deployer, deployer.address) || !same(rehearsal.accounts.relayer, relayer) || !same(rehearsal.accounts.feeRecipient, feeRecipient)) fail('Rehearsal used different accounts');
  if (rehearsal.startNonce !== startNonce) fail(`Deployer nonce moved since the rehearsal (${rehearsal.startNonce} → ${startNonce}); rehearse again`);
  if (rehearsal.steps.length !== plan.length || plan.some((step, i) => rehearsal.steps[i].dataHash !== keccak256(step.data) || String(rehearsal.steps[i].to) !== String(step.to))) fail('Plan differs from the rehearsal; rehearse again');
  gasLimits = rehearsal.steps.map((step: { gasUsed: string }) => (BigInt(step.gasUsed) * 125n) / 100n + 5_000n);
}
const gasPrice = await pub.getGasPrice();
if (!local && gasPrice > 20_000_000_000n) fail(`Gas price ${gasPrice} wei is above the 20 gwei sanity limit`);
const l1Reserve = parseEther('0.001'); // L1 data fees are charged outside gasPrice on Whitechain.
const maxFee = args['max-fee-wbt'] ? parseEther(args['max-fee-wbt']) : 0n;
const plannedFee = gasLimits.reduce((sum, gas) => sum + gas * gasPrice, 0n);
if (!local && plannedFee + l1Reserve > maxFee) fail(`Plan needs up to ${formatEther(plannedFee + l1Reserve)} WBT, above the ${args['max-fee-wbt']} WBT cap`);
const balance = await pub.getBalance({ address: deployer.address });
if (!local && balance < plannedFee + l1Reserve) fail(`Deployer holds ${formatEther(balance)} WBT, needs ${formatEther(plannedFee + l1Reserve)}`);

const record = {
  status: 'broadcasting', mode: local ? 'rehearsal' : 'testnet', chainId: 1874, rpcUrl: local ? 'local-fork' : args.rpc,
  startedAt: new Date().toISOString(), completedAt: null as string | null,
  accounts: { deployer: deployer.address, relayer, keeper: relayer, priceKeeper: relayer, feeRecipient },
  contracts: { ...contracts, usdt: USDT, permit2: PERMIT2 },
  passkeys: { factory: contracts.passkeyFactory, implementation: passkeyImplementation },
  x402: { factory, upto: UPTO, uptoDeployed: uptoMissing, runtimeHashes },
  feeTerms: { version: 1, ...JSON.parse(JSON.stringify(termsTuple(INITIAL_TERMS), (_, v) => typeof v === 'bigint' ? String(v) : v)) },
  usdtPerWbt: String(usdtPerWbt),
  routerLimits: Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, String(v)])),
  startNonce, gasPriceWei: String(gasPrice), maxFeeWei: String(maxFee), plannedMaxFeeWei: String(plannedFee), startingBalanceWei: String(balance),
  deploymentBlock: null as string | null, totalFeeWei: '0', sourceSha256,
  steps: [] as Array<Record<string, string | number | null>>,
  error: null as string | null,
};
const save = () => writeFileSync(args.out!, `${JSON.stringify(record, null, 2)}\n`);
save();
console.info(`[deploy] ${record.mode}: ${plan.length} transactions from ${deployer.address} at nonce ${startNonce}, gas price ${gasPrice} wei`);

let paid = 0n;
try {
  for (const [i, step] of plan.entries()) {
    const nonce = startNonce + i;
    if (await pub.getTransactionCount({ address: deployer.address, blockTag: 'pending' }) !== nonce) throw new Error(`Unexpected deployer nonce before step ${i + 1}`);
    if (!local && paid + gasLimits.slice(i).reduce((s, g) => s + g * gasPrice, 0n) + l1Reserve > maxFee) throw new Error('Remaining plan exceeds the fee cap');
    const signed = await deployer.signTransaction({ type: 'legacy', chainId: 1874, nonce, gas: gasLimits[i], gasPrice, value: 0n, data: step.data, ...(step.to ? { to: step.to } : {}) });
    const hash = keccak256(signed);
    const entry: Record<string, string | number | null> = { index: i + 1, label: step.label, nonce, to: step.to, dataHash: keccak256(step.data), gasLimit: String(gasLimits[i]), hash, status: 'signed' };
    record.steps.push(entry);
    save(); // The hash is on disk before the send: never blindly re-send a nonce.
    await rpc('eth_sendRawTransaction', [signed]);
    entry.status = 'sent';
    save();
    const receipt = await pub.waitForTransactionReceipt({ hash, confirmations: local ? 1 : 2, timeout: 180_000 });
    const l1Fee = BigInt((receipt as { l1Fee?: string | bigint }).l1Fee ?? 0);
    const fee = receipt.gasUsed * receipt.effectiveGasPrice + l1Fee;
    paid += fee;
    Object.assign(entry, { status: receipt.status, block: String(receipt.blockNumber), gasUsed: String(receipt.gasUsed), feeWei: String(fee), contractAddress: receipt.contractAddress ?? null });
    record.totalFeeWei = String(paid);
    if (i === 0) record.deploymentBlock = String(receipt.blockNumber);
    save();
    if (receipt.status !== 'success') throw new Error(`Step ${i + 1} (${step.label}) reverted`);
    if (step.to === null && !same(receipt.contractAddress ?? '', at(i))) throw new Error(`Step ${i + 1} created an unexpected address`);
    console.info(`[deploy] ${i + 1}/${plan.length} ${step.label}  gas ${receipt.gasUsed}  total ${formatEther(paid)} WBT`);
  }

  // Verify what is on chain, not what was sent.
  const read = (address: Address, name: string, functionName: string, callArgs: unknown[] = []) => pub.readContract({ address, abi: artifact(name).abi, functionName, args: callArgs });
  const checks: Array<[Address, string, string, unknown[], unknown]> = [
    [contracts.fees, 'FeeSchedule', 'owner', [], deployer.address], [contracts.fees, 'FeeSchedule', 'recipient', [], feeRecipient],
    [contracts.fees, 'FeeSchedule', 'priceKeeper', [], relayer], [contracts.fees, 'FeeSchedule', 'usdtPerWBT', [], usdtPerWbt],
    [contracts.fees, 'FeeSchedule', 'latestVersion', [], 1n], [contracts.fees, 'FeeSchedule', 'terms', [1], termsTuple(INITIAL_TERMS)],
    [contracts.router, 'Router', 'owner', [], deployer.address], [contracts.router, 'Router', 'usdt', [], USDT], [contracts.router, 'Router', 'fees', [], contracts.fees],
    [contracts.escrow, 'PaymentEscrow', 'usdt', [], USDT], [contracts.escrow, 'PaymentEscrow', 'router', [], contracts.router], [contracts.escrow, 'PaymentEscrow', 'fees', [], contracts.fees],
    [contracts.escrow, 'PaymentEscrow', 'permit2', [], PERMIT2],
    [contracts.subscription, 'SubscriptionManagerV2', 'owner', [], deployer.address], [contracts.subscription, 'SubscriptionManagerV2', 'usdt', [], USDT],
    [contracts.subscription, 'SubscriptionManagerV2', 'router', [], contracts.router], [contracts.subscription, 'SubscriptionManagerV2', 'keeper', [], relayer],
    [contracts.subscription, 'SubscriptionManagerV2', 'fees', [], contracts.fees],
    [contracts.passkeyFactory, 'PasskeyAccountFactory', 'implementation', [], passkeyImplementation],
    [passkeyImplementation, 'PasskeyAccount', 'usdt', [], USDT], [passkeyImplementation, 'PasskeyAccount', 'permit2', [], PERMIT2],
    [passkeyImplementation, 'PasskeyAccount', 'factory', [], contracts.passkeyFactory],
    ...Object.entries(limits).map(([fn, value]) => [contracts.router, 'Router', fn, [], BigInt(value)] as [Address, string, string, unknown[], unknown]),
    ...suiteEntries.map(entry => {
      const [name, address] = targetOf[entry.contract as 'escrow' | 'subscription'];
      return [contracts.router, 'Router', 'allowed', [address, selector(name, entry.fn)], [...allowFlags(entry)]] as [Address, string, string, unknown[], unknown];
    }),
  ];
  for (const [address, name, fn, callArgs, wanted] of checks) {
    const got = await read(address, name, fn, callArgs);
    const norm = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? String(x) : typeof x === 'string' ? x.toLowerCase() : x));
    if (norm(typeof got === 'number' ? BigInt(got) : got) !== norm(wanted)) throw new Error(`${name}.${fn} is ${norm(got)}, expected ${norm(wanted)}`);
  }
  for (const [name, address] of [['FeeSchedule', contracts.fees], ['Router', contracts.router], ['PaymentEscrow', contracts.escrow], ['SubscriptionManagerV2', contracts.subscription], ['PasskeyAccountFactory', contracts.passkeyFactory], ['PasskeyAccount', passkeyImplementation], ['X402AccountFactory', factory]] as const) {
    const code = await pub.getCode({ address });
    if (!code || !runtimeMatches(name, code)) throw new Error(`${name} runtime differs from the compiled source`);
  }
  const uptoCode = await pub.getCode({ address: UPTO });
  if (!uptoCode || keccak256(uptoCode) !== runtimeHashes[UPTO]) throw new Error('x402 upto runtime mismatch');

  record.status = 'verified';
  record.completedAt = new Date().toISOString();
  save();
  console.info(`[deploy] verified: ${plan.length} transactions, ${formatEther(paid)} WBT. Record: ${args.out}`);
} catch (error) {
  record.status = 'requires_reconciliation';
  // shortMessage only: full RPC errors can carry the signed payload.
  record.error = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : 'DeploymentError';
  save();
  fail(`stopped: ${record.error}. Inspect ${args.out}; nothing is re-sent automatically.`);
}
