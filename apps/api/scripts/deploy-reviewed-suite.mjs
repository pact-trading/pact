// Execute only the exact, reviewed Foundry plan under the approved fee budget.
// Execution fees are bounded by signed limits; chain-assessed L1 fees need headroom and reconciliation.
// Default is read-only preflight. Secrets stay in memory; the journal contains public data only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, encodeDeployData, encodeFunctionData, getContractAddress, http, keccak256, parseAbi, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const project = fileURLToPath(new URL('../../../', import.meta.url));
const contracts = join(project, 'contracts');
const reviewed = JSON.parse(readFileSync(join(contracts, 'deployment-preview-2026-11-06.json'), 'utf8'));
assert(process.env.DEPLOY_MANIFEST, 'DEPLOY_MANIFEST must point to a fresh preparation manifest');
const manifestPath = resolve(process.env.DEPLOY_MANIFEST);
const preview = JSON.parse(readFileSync(manifestPath, 'utf8'));
const previewContracts = join(dirname(manifestPath), 'contracts');
const raw = JSON.parse(readFileSync(join(previewContracts, 'broadcast/Deploy.s.sol/1874/dry-run/run-latest.json'), 'utf8'));
const artifact = name => JSON.parse(readFileSync(join(previewContracts, 'out', `${name}.sol`, `${name}.json`), 'utf8'));
const sha = data => createHash('sha256').update(data).digest('hex');
const same = (a, b) => assert.equal(a.toLowerCase(), b.toLowerCase());
const address = preview.predictedContracts;
const token = '0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7';
const client = createPublicClient({ transport: http('https://rpc.testnet.whitechain.io') });
const cap = 50_000_000_000_000_000n; // User-approved total maximum: 0.05 WBT.
const l1Reserve = 500_000_000_000_000n; // Reserve 0.0005 WBT; protocol L1 fees are not capped by gasPrice.
const execute = process.env.DEPLOY_EXECUTE === '1';
const journalPath = join(contracts, 'deployment-2026-11-06.json');
assert(!existsSync(journalPath), 'A deployment journal already exists. Reconcile it before any further send.');
assert.equal(preview.status, 'simulated_only_not_deployed');
assert.equal(await client.getChainId(), 1874);
same(preview.deployer, reviewed.deployer);
same(preview.feeVault, reviewed.feeVault);
same(preview.keeper, reviewed.keeper);
assert.deepEqual(preview.sourceSha256, reviewed.sourceSha256);
assert.equal(sha(readFileSync(join(contracts, 'script/Deploy.s.sol'))), reviewed.deployScriptSha256);
for (const [path, hash] of Object.entries(reviewed.sourceSha256)) {
  assert.equal(sha(readFileSync(join(contracts, path))), hash, `Source changed: ${path}`);
  assert.equal(sha(readFileSync(join(previewContracts, path))), hash, `Preview source changed: ${path}`);
}
assert.equal(sha(readFileSync(join(previewContracts, 'foundry.toml'))), sha(readFileSync(join(contracts, 'foundry.toml'))));
const read = (at, name, fn, args = []) => client.readContract({ address: at, abi: artifact(name).abi, functionName: fn, args });
assert.equal(await client.readContract({ address: token, abi: parseAbi(['function decimals() view returns (uint8)']), functionName: 'decimals' }), 6);
assert((await client.getCode({ address: token }))?.length > 2);
assert.equal(await client.getTransactionCount({ address: preview.deployer, blockTag: 'latest' }), preview.deployerNonce);
assert.equal(await client.getTransactionCount({ address: preview.deployer, blockTag: 'pending' }), preview.deployerNonce);

const expected = [
  ['CREATE', 'GasTank', []],
  ['CREATE', 'Router', [token, address.GasTank, preview.feeVault]],
  ['CALL', 'GasTank', 'setRouter', [address.Router]],
  ['CREATE', 'PaymentEscrow', [token, address.Router]],
  ['CREATE', 'SubscriptionManager', [token, address.Router, preview.keeper]],
];
for (const [name, functions] of [
  ['PaymentEscrow', ['authorize', 'capture', 'charge', 'void', 'reclaim', 'refund']],
  ['SubscriptionManager', ['subscribe', 'charge', 'cancel', 'replace']],
]) {
  const abi = artifact(name).abi;
  for (const fn of functions) {
    const entry = abi.find(item => item.type === 'function' && item.name === fn);
    assert(entry);
    const signature = Object.keys(artifact(name).methodIdentifiers).find(sig => sig.startsWith(`${fn}(`));
    assert(signature);
    const selector = `0x${artifact(name).methodIdentifiers[signature]}`;
    expected.push(['CALL', 'Router', 'setAllowed', [address[name], selector, true, name === 'SubscriptionManager' && fn === 'charge']]);
  }
}
assert.equal(raw.transactions.length, 15);
assert.equal(preview.transactions.length, 15);
const plan = raw.transactions.map((item, i) => {
  const tx = item.transaction;
  const [kind, name, argsOrFunction, args] = expected[i];
  assert.equal(item.transactionType, kind);
  assert.equal(item.contractName, name);
  same(tx.from, preview.deployer);
  assert.equal(Number(tx.chainId), 1874);
  assert.equal(Number(tx.nonce), preview.deployerNonce + i);
  assert.equal(BigInt(tx.value), 0n);
  const gas = BigInt(tx.gas);
  assert.equal(gas, BigInt(preview.transactions[i].gas));
  assert(gas > 21_000n);
  const compiled = artifact(name);
  const data = kind === 'CREATE'
    ? encodeDeployData({ abi: compiled.abi, bytecode: compiled.bytecode.object, args: argsOrFunction })
    : encodeFunctionData({ abi: compiled.abi, functionName: argsOrFunction, args });
  same(tx.input, data);
  if (kind === 'CREATE') {
    assert.equal(tx.to, null);
    same(getContractAddress({ from: preview.deployer, nonce: BigInt(tx.nonce) }), address[name]);
  } else same(tx.to, address[name]);
  return { index: i + 1, kind, name, nonce: Number(tx.nonce), gas, data, to: tx.to, function: kind === 'CALL' ? argsOrFunction : null };
});
for (const at of Object.values(address)) assert(!(await client.getCode({ address: at })), 'Predicted contract already exists');
const gasPrice = await client.getGasPrice();
const maximumFee = plan.reduce((sum, tx) => sum + tx.gas * gasPrice, 0n);
assert(maximumFee + l1Reserve <= cap, `Fee budget exceeded: ${formatEther(maximumFee + l1Reserve)} WBT`);
const startingBalance = await client.getBalance({ address: preview.deployer });
assert(startingBalance >= maximumFee + l1Reserve, 'Insufficient deployer balance');
console.log(JSON.stringify({ preflight: 'passed', transactions: plan.length, nonce: preview.deployerNonce, gasPriceWei: String(gasPrice), maximumExecutionFeeWbt: formatEther(maximumFee), l1ReserveWbt: formatEther(l1Reserve), approvedCapWbt: formatEther(cap), execute }));
if (!execute) process.exit(0);

const walletFile = process.env.WALLET_ENV_PATH ?? join(project, '.env.wallets');
const values = Object.fromEntries(readFileSync(walletFile, 'utf8').split(/\r?\n/).map(line => line.trim().replace(/^export\s+/, '')).filter(line => line && !line.startsWith('#') && line.includes('=')).map(line => {
  const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1).trim().replace(/^(['"])(.*)\1$/, '$2')];
}));
const account = privateKeyToAccount(values.DEPLOYER_PRIVATE_KEY);
same(account.address, preview.deployer);
const journal = { status: 'broadcasting', chainId: 1874, startedAt: new Date().toISOString(), deployer: preview.deployer, feeVault: preview.feeVault, keeper: preview.keeper, token, approvedFeeCapWei: String(cap), maximumExecutionFeeWei: String(maximumFee), l1ReserveWei: String(l1Reserve), gasPriceWei: String(gasPrice), startingBalanceWei: String(startingBalance), sourceSha256: reviewed.sourceSha256, contracts: address, receipts: [] };
const save = () => writeFileSync(journalPath, JSON.stringify(journal, (_, v) => typeof v === 'bigint' ? String(v) : v, 2) + '\n');
save();
let paid = 0n;
try {
  for (const tx of plan) {
    const remainingExecutionFees = plan.slice(tx.index - 1).reduce((sum, item) => sum + item.gas * gasPrice, 0n);
    assert(paid + remainingExecutionFees + l1Reserve <= cap, 'Remaining plan exceeds approved budget');
    assert.equal(await client.getTransactionCount({ address: account.address, blockTag: 'pending' }), tx.nonce, 'Unexpected nonce; stop and reconcile');
    const signed = await account.signTransaction({ chainId: 1874, type: 'legacy', nonce: tx.nonce, gas: tx.gas, gasPrice, value: 0n, data: tx.data, ...(tx.to ? { to: tx.to } : {}) });
    const hash = keccak256(signed);
    const entry = { index: tx.index, contract: tx.name, kind: tx.kind, function: tx.function, nonce: tx.nonce, gasLimit: tx.gas, transactionHash: hash, status: 'prepared' };
    journal.receipts.push(entry);
    save(); // Persist the deterministic hash before sending; never blindly retry a nonce.
    const sentHash = await client.request({ method: 'eth_sendRawTransaction', params: [signed] });
    same(sentHash, hash);
    entry.status = 'submitted'; save();
    const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 2, timeout: 180_000 });
    const executionFee = receipt.gasUsed * receipt.effectiveGasPrice;
    const l1Fee = BigInt(receipt.l1Fee ?? 0);
    Object.assign(entry, { status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, gasUsed: receipt.gasUsed, effectiveGasPrice: receipt.effectiveGasPrice, contractAddress: receipt.contractAddress, executionFeeWei: executionFee, l1FeeWei: l1Fee, totalFeeWei: executionFee + l1Fee });
    paid += executionFee + l1Fee;
    journal.actualFeeWei = paid; save();
    assert.equal(receipt.status, 'success');
    assert.equal(receipt.effectiveGasPrice, gasPrice);
    assert(receipt.gasUsed <= tx.gas && paid <= cap);
    if (tx.kind === 'CREATE') same(receipt.contractAddress, address[tx.name]);
    console.log(`Confirmed ${tx.index}/15 ${tx.name} ${tx.function ?? 'deployment'} ${hash}; cumulative fee ${formatEther(paid)} WBT`);
  }
  journal.status = 'deployed_pending_verification'; save();
  // Compare exact compiled runtime, masking only immutable slots checked through getters below.
  journal.runtimeCodeHashes = {};
  for (const [name, at] of Object.entries(address)) {
    const deployed = await client.getCode({ address: at });
    assert(deployed?.length > 2);
    const compiled = artifact(name).deployedBytecode;
    const normalize = code => {
      let hex = code.slice(2).toLowerCase();
      for (const references of Object.values(compiled.immutableReferences ?? {})) {
        for (const { start, length } of references) hex = hex.slice(0, start * 2) + '0'.repeat(length * 2) + hex.slice((start + length) * 2);
      }
      return hex;
    };
    assert.equal(normalize(deployed), normalize(compiled.object), `Runtime differs for ${name}`);
    journal.runtimeCodeHashes[name] = keccak256(deployed);
  }
  for (const [name, fn, wanted] of [
    ['GasTank', 'owner', preview.deployer], ['GasTank', 'router', address.Router],
    ['Router', 'owner', preview.deployer], ['Router', 'usdt', token], ['Router', 'gasTank', address.GasTank], ['Router', 'feeVault', preview.feeVault],
    ['PaymentEscrow', 'usdt', token], ['PaymentEscrow', 'router', address.Router],
    ['SubscriptionManager', 'owner', preview.deployer], ['SubscriptionManager', 'usdt', token], ['SubscriptionManager', 'router', address.Router], ['SubscriptionManager', 'keeper', preview.keeper],
  ]) same(await read(address[name], name, fn), wanted);
  for (const [fn, wanted] of [['minAmount', 1_000_000n], ['usdtPerWBT', 1_000_000n], ['maxPayerCallsPerDay', 10n], ['maxGasPerCall', 1_000_000n], ['maxGasPrice', 100_000_000_000n]]) {
    assert.equal(BigInt(await read(address.Router, 'Router', fn)), wanted);
  }
  for (const [, , , args] of expected.slice(5)) assert.deepEqual(await read(address.Router, 'Router', 'allowed', args.slice(0, 2)), args.slice(2));
  assert.equal(await read(address.GasTank, 'GasTank', 'balanceOf', [preview.deployer]), 0n);
  assert.equal(await read(address.GasTank, 'GasTank', 'dailyCap', [preview.deployer]), 0n);
  journal.status = 'verified_deployed_not_activated';
  journal.deploymentBlock = journal.receipts[0].blockNumber;
  journal.finalBlock = await client.getBlockNumber();
  journal.endingBalanceWei = await client.getBalance({ address: account.address });
  journal.completedAt = new Date().toISOString();
  save();
  console.log(JSON.stringify({ status: journal.status, actualFeeWbt: formatEther(paid), journal: journalPath }));
} catch (error) {
  journal.status = 'requires_reconciliation';
  journal.error = error instanceof Error ? error.name : 'DeploymentError';
  save();
  // Avoid dumping RPC errors containing signed transaction payloads.
  console.error(`Stopped; inspect public journal ${journalPath}. No automatic rebroadcast or replacement.`);
  process.exitCode = 1;
}
