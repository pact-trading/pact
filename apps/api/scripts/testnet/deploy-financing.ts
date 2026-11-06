// Adds invoice financing to the deployed Whitechain Sepolia suite WITHOUT redeploying it: creates
// InvestorRegistry and InvoiceReceivables (its sale fee goes to the FeeSchedule's recipient), then the
// Router owner allowlists InvoiceReceivables.pay and .buyBack. Four transactions.
//
// 1. Rehearse on a local Anvil fork of the testnet. Sends nothing to the testnet:
//      anvil --fork-url https://rpc.testnet.whitechain.io --port 8546 --hardfork prague --chain-id 1874
//      tsx scripts/testnet/deploy-financing.ts --rpc http://127.0.0.1:8546 --keys ../../.env.testnet \
//        --suite ../../contracts/deployment-testnet-<date>.json --out <rehearsal.json>
// 2. Execute exactly the rehearsed plan on the testnet, under a fee cap:
//      tsx scripts/testnet/deploy-financing.ts --rpc https://rpc.testnet.whitechain.io --keys ../../.env.testnet \
//        --suite ../../contracts/deployment-testnet-<date>.json --rehearsal <rehearsal.json> --max-fee-wbt 0.05 \
//        --out ../../contracts/deployment-financing-testnet-<date>.json --execute
//
// Keys stay in memory and are never printed. The output file holds public data only, is written before
// each send so a stopped run can be reconciled, and is never overwritten.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BaseError, createPublicClient, encodeDeployData, encodeFunctionData, formatEther, getContractAddress, http, keccak256,
  parseEther, type Abi, type Address, type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { USDT } from '../../src/token.js';
import { FINANCING_TERMS, receivablesConfig } from '../../src/financing/terms.js';
import { ALLOWLIST, allowFlags } from '../../src/suite.js';
import { privateKey, readEnvFile } from './keys.js';

const { values: args } = parseArgs({
  options: {
    rpc: { type: 'string' }, keys: { type: 'string' }, suite: { type: 'string' }, out: { type: 'string' }, rehearsal: { type: 'string' },
    'max-fee-wbt': { type: 'string' }, execute: { type: 'boolean', default: false },
    // An earlier receivables deployment this one must not double-sell against (repeatable).
    predecessor: { type: 'string', multiple: true },
  },
});
const fail = (message: string): never => { console.error(`[financing] ${message}`); process.exit(1); };
if (!args.rpc || !args.keys || !args.suite || !args.out) fail('usage: --rpc <url> --keys <env file> --suite <deployment record> --out <file> [--rehearsal <file> --max-fee-wbt <n> --execute]');
if (existsSync(args.out!)) fail(`${args.out} already exists. Reconcile it; this script never overwrites a deployment record.`);

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const pub = createPublicClient({ transport: http(args.rpc, { timeout: 30_000, retryCount: 2 }), pollingInterval: 1_000 });
const rpc = (method: string, params: unknown[] = []) => pub.request({ method: method as never, params: params as never });
const local = ['127.0.0.1', 'localhost'].includes(new URL(args.rpc!).hostname) && String(await rpc('web3_clientVersion')).toLowerCase().includes('anvil');
if (await pub.getChainId() !== 1874) fail('RPC is not chain 1874');
if (!local && !(args.execute && args.rehearsal && args['max-fee-wbt'])) fail('A testnet run needs --rehearsal, --max-fee-wbt and --execute');
if (local && args.execute) fail('--execute is for the testnet; a local fork run is always a rehearsal');

const env = readEnvFile(args.keys!);
const deployer = (() => { try { return privateKeyToAccount(privateKey(env, 'DEPLOYER_PRIVATE_KEY')); } catch { return fail(`DEPLOYER_PRIVATE_KEY is missing or malformed in ${args.keys}`); } })();

const artifact = (name: string) => {
  const json = JSON.parse(readFileSync(`${root}contracts/out/${name}.sol/${name}.json`, 'utf8'));
  return { abi: json.abi as Abi, bytecode: json.bytecode.object as Hex, runtime: json.deployedBytecode as { object: Hex; immutableReferences?: Record<string, Array<{ start: number; length: number }>> }, ids: json.methodIdentifiers as Record<string, string> };
};
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const selector = (name: string, fn: string): Hex => {
  const matches = Object.entries(artifact(name).ids).filter(([signature]) => signature.startsWith(`${fn}(`));
  if (matches.length !== 1) fail(`${name}.${fn} is missing or overloaded`);
  return `0x${matches[0][1]}`;
};
/** Compiled runtime equals deployed runtime, immutables masked (checked through getters), CBOR metadata dropped. */
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
const sources = ['InvestorRegistry', 'InvoiceReceivables', 'SponsoredContext', 'Signatures'];
const sourceSha256 = Object.fromEntries(sources.map(name => [`src/${name}.sol`, createHash('sha256').update(readFileSync(`${root}contracts/src/${name}.sol`)).digest('hex')]));

// The existing suite: the Router is reused, never redeployed. Its owner (the deployer) adds the receivables
// allowlist entries: `pay` (customers pay financed invoices) and `buyBack` (merchant-signed, gas on top).
const suite = JSON.parse(readFileSync(args.suite!, 'utf8'));
const router = suite.contracts?.router as Address;
if (!router || suite.chainId !== 1874) fail('The suite record names no chain 1874 Router');
const routerAbi = artifact('Router').abi;
const readRouter = (functionName: string, callArgs: unknown[] = []) => pub.readContract({ address: router, abi: routerAbi, functionName, args: callArgs });
if (!(await pub.getCode({ address: router }))) fail(`No Router code at ${router}`);
if (!same(String(await readRouter('owner')), deployer.address)) fail('The deployer key does not own the Router');
if (!same(String(await readRouter('usdt')), USDT)) fail('The Router settles a different token');
const fees = await readRouter('fees') as Address;

const startNonce = await pub.getTransactionCount({ address: deployer.address, blockTag: 'latest' });
if (startNonce !== await pub.getTransactionCount({ address: deployer.address, blockTag: 'pending' })) fail('Deployer has pending transactions; wait for them first');
const registry = getContractAddress({ from: deployer.address, nonce: BigInt(startNonce) });
const receivables = getContractAddress({ from: deployer.address, nonce: BigInt(startNonce + 1) });
for (const address of [registry, receivables]) if (await pub.getCode({ address })) fail(`Predicted address ${address} already has code`);
const predecessors = (args.predecessor ?? []) as Address[];
for (const p of predecessors) if (!/^0x[0-9a-fA-F]{40}$/.test(p) || !(await pub.getCode({ address: p }))) fail(`No receivables contract at predecessor ${p}`);
const config = receivablesConfig({ usdt: USDT, router, registry, fees, predecessors });
const receivablesEntries = ALLOWLIST.filter(entry => entry.contract === 'receivables');
type Step = { label: string; to: Address | null; data: Hex };
const plan: Step[] = [
  { label: 'create InvestorRegistry', to: null, data: encodeDeployData({ abi: artifact('InvestorRegistry').abi, bytecode: artifact('InvestorRegistry').bytecode, args: [deployer.address] }) },
  { label: 'create InvoiceReceivables', to: null, data: encodeDeployData({ abi: artifact('InvoiceReceivables').abi, bytecode: artifact('InvoiceReceivables').bytecode, args: [config] }) },
  ...receivablesEntries.map(entry => ({ label: `Router.setAllowed ${entry.fn}`, to: router, data: encodeFunctionData({ abi: routerAbi, functionName: 'setAllowed', args: [receivables, selector('InvoiceReceivables', entry.fn), ...allowFlags(entry)] }) })),
];

let gasLimits: bigint[];
if (local) gasLimits = plan.map(() => 10_000_000n);
else {
  const rehearsal = JSON.parse(readFileSync(args.rehearsal!, 'utf8'));
  if (rehearsal.status !== 'verified' || rehearsal.mode !== 'rehearsal') fail('Rehearsal did not complete and verify');
  if (!same(rehearsal.accounts.deployer, deployer.address) || !same(rehearsal.contracts.router, router)) fail('Rehearsal used a different deployer or Router');
  if (rehearsal.startNonce !== startNonce) fail(`Deployer nonce moved since the rehearsal (${rehearsal.startNonce} → ${startNonce}); rehearse again`);
  if (rehearsal.steps.length !== plan.length || plan.some((step, i) => rehearsal.steps[i].dataHash !== keccak256(step.data) || String(rehearsal.steps[i].to) !== String(step.to))) fail('Plan differs from the rehearsal; rehearse again');
  gasLimits = rehearsal.steps.map((step: { gasUsed: string }) => (BigInt(step.gasUsed) * 125n) / 100n + 5_000n);
}
const gasPrice = await pub.getGasPrice();
if (!local && gasPrice > 20_000_000_000n) fail(`Gas price ${gasPrice} wei is above the 20 gwei sanity limit`);
const l1Reserve = parseEther('0.001');
const maxFee = args['max-fee-wbt'] ? parseEther(args['max-fee-wbt']) : 0n;
const plannedFee = gasLimits.reduce((sum, gas) => sum + gas * gasPrice, 0n);
if (!local && plannedFee + l1Reserve > maxFee) fail(`Plan needs up to ${formatEther(plannedFee + l1Reserve)} WBT, above the ${args['max-fee-wbt']} WBT cap`);
const balance = await pub.getBalance({ address: deployer.address });
if (!local && balance < plannedFee + l1Reserve) fail(`Deployer holds ${formatEther(balance)} WBT, needs ${formatEther(plannedFee + l1Reserve)}`);

const record = {
  status: 'broadcasting', mode: local ? 'rehearsal' : 'testnet', chainId: 1874, rpcUrl: local ? 'local-fork' : args.rpc,
  startedAt: new Date().toISOString(), completedAt: null as string | null,
  accounts: { deployer: deployer.address, registryOwner: deployer.address },
  fees,
  contracts: { router, registry, receivables, usdt: USDT, predecessors },
  terms: { ...FINANCING_TERMS, minShareMinor: FINANCING_TERMS.minShareMinor.toString() },
  startNonce, gasPriceWei: String(gasPrice), maxFeeWei: String(maxFee), plannedMaxFeeWei: String(plannedFee), startingBalanceWei: String(balance),
  deploymentBlock: null as string | null, totalFeeWei: '0', sourceSha256,
  steps: [] as Array<Record<string, string | number | null>>,
  error: null as string | null,
};
const save = () => writeFileSync(args.out!, `${JSON.stringify(record, null, 2)}\n`);
save();
console.info(`[financing] ${record.mode}: ${plan.length} transactions from ${deployer.address} at nonce ${startNonce}, gas price ${gasPrice} wei`);

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
    const fee = receipt.gasUsed * receipt.effectiveGasPrice + BigInt((receipt as { l1Fee?: string | bigint }).l1Fee ?? 0);
    paid += fee;
    Object.assign(entry, { status: receipt.status, block: String(receipt.blockNumber), gasUsed: String(receipt.gasUsed), feeWei: String(fee), contractAddress: receipt.contractAddress ?? null });
    record.totalFeeWei = String(paid);
    if (i === 0) record.deploymentBlock = String(receipt.blockNumber);
    save();
    if (receipt.status !== 'success') throw new Error(`Step ${i + 1} (${step.label}) reverted`);
    if (step.to === null && !same(receipt.contractAddress ?? '', [registry, receivables][i])) throw new Error(`Step ${i + 1} created an unexpected address`);
    console.info(`[financing] ${i + 1}/${plan.length} ${step.label}  gas ${receipt.gasUsed}  total ${formatEther(paid)} WBT`);
  }

  // Verify what is on chain, not what was sent.
  const read = (address: Address, name: string, functionName: string, callArgs: unknown[] = []) => pub.readContract({ address, abi: artifact(name).abi, functionName, args: callArgs });
  const t = FINANCING_TERMS;
  const checks: Array<[Address, string, string, unknown[], unknown]> = [
    [registry, 'InvestorRegistry', 'owner', [], deployer.address], [registry, 'InvestorRegistry', 'officers', [deployer.address], true],
    [receivables, 'InvoiceReceivables', 'usdt', [], USDT], [receivables, 'InvoiceReceivables', 'router', [], router],
    [receivables, 'InvoiceReceivables', 'registry', [], registry], [receivables, 'InvoiceReceivables', 'fees', [], fees],
    [receivables, 'InvoiceReceivables', 'feeBps', [], t.feeBps], [receivables, 'InvoiceReceivables', 'reserveBps', [], t.reserveBps],
    [receivables, 'InvoiceReceivables', 'lateFeeBps', [], t.lateFeeBps], [receivables, 'InvoiceReceivables', 'maxDiscountBps', [], t.maxDiscountBps],
    [receivables, 'InvoiceReceivables', 'gracePeriod', [], t.gracePeriodSeconds], [receivables, 'InvoiceReceivables', 'recordPeriod', [], t.recordPeriodSeconds],
    [receivables, 'InvoiceReceivables', 'minShare', [], t.minShareMinor], [receivables, 'InvoiceReceivables', 'maxHolders', [], t.maxHolders],
    ...receivablesEntries.map(entry => [router, 'Router', 'allowed', [receivables, selector('InvoiceReceivables', entry.fn)], [...allowFlags(entry)]] as [Address, string, string, unknown[], unknown]),
    [receivables, 'InvoiceReceivables', 'predecessors', [], predecessors],
  ];
  const norm = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' || typeof x === 'number' ? String(x) : typeof x === 'string' ? x.toLowerCase() : x));
  for (const [address, name, fn, callArgs, wanted] of checks) {
    const got = await read(address, name, fn, callArgs);
    if (norm(got) !== norm(wanted)) throw new Error(`${name}.${fn} is ${norm(got)}, expected ${norm(wanted)}`);
  }
  for (const [name, address] of [['InvestorRegistry', registry], ['InvoiceReceivables', receivables]] as const) {
    const code = await pub.getCode({ address });
    if (!code || !runtimeMatches(name, code)) throw new Error(`${name} runtime differs from the compiled source`);
  }
  record.status = 'verified';
  record.completedAt = new Date().toISOString();
  save();
  console.info(`[financing] verified: ${plan.length} transactions, ${formatEther(paid)} WBT. Record: ${args.out}`);
} catch (error) {
  record.status = 'requires_reconciliation';
  record.error = error instanceof BaseError ? error.shortMessage : error instanceof Error ? error.message : 'DeploymentError';
  save();
  fail(`stopped: ${record.error}. Inspect ${args.out}; nothing is re-sent automatically.`);
}
