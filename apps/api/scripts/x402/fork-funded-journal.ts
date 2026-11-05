// Local-only evidence. No dotenv, runtime config, wallet files, live signing or token overrides.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from '@x402/hono';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { Permit2Facilitator } from '../../src/x402/facilitator.js';
import { X402WriteCoordinator } from '../../src/x402/write-coordinator.js';
import { SqliteFundedX402Journal } from '../../src/x402/sqlite-funded-journal.js';
import { SqliteX402Journal } from '../../src/x402/sqlite-journal.js';
import { ViemFundedX402WritePorts } from '../../src/x402/viem-funded-ports.js';
import { x402Routes } from '../../src/x402/routes.js';
import { ViemChain, routerAbi } from '../../src/chain.js';
import { openDb } from '../../src/db.js';
import { intentTypedData } from '../../src/typed-data.js';
import type { GatewayPayment } from '../../src/x402/funded-gateway.js';
import { canonicalJson, fingerprint } from '../../src/x402/sqlite-store.js';
import type { MerchantSponsorshipPolicy } from '../../src/x402/write-ports.js';
import { ExactEvmScheme as ExactServer } from '@x402/evm/exact/server';
import { UptoEvmScheme as UptoServer } from '@x402/evm/upto/server';
import { ExactEvmScheme as ExactClient } from '@x402/evm/exact/client';
import { UptoEvmScheme as UptoClient } from '@x402/evm/upto/client';
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch';
import { createPublicClient, createWalletClient, decodeFunctionData, decodeEventLog, getFunctionSelector, parseTransaction, recoverTransactionAddress, recoverTypedDataAddress, defineChain, http, keccak256, parseAbi, toHex, type Address, type Hex, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createX402AccountSigner, agentAccountAbi } from '../../src/x402/account-client.js';
import { CREATE2, EXACT, NETWORK, PERMIT2, UPTO, USDT } from '../../src/x402/constants.js';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const artifact = (name: string) => JSON.parse(readFileSync(`${root}/contracts/out/${name}.sol/${name}.json`, 'utf8'));
const reference = JSON.parse(readFileSync(`${root}/docs/x402/whitechain-readonly.json`, 'utf8'));
const forkBlock = 11930519;
const remoteRpc = 'https://rpc.testnet.whitechain.io';
const net = createServer();
await new Promise<void>(r => net.listen(0, '127.0.0.1', r));
const port = (net.address() as { port: number }).port;
await new Promise<void>(r => net.close(() => r()));
const url = `http://127.0.0.1:${port}`;
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--fork-url', remoteRpc, '--fork-block-number', String(forkBlock), '--chain-id', '1874', '--hardfork', 'cancun', '--silent'], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.HOME } });
let anvilLog = ''; anvil.stderr.on('data', d => anvilLog += d);
const servers: ReturnType<typeof serve>[] = [];
const checks: string[] = [];
const check = (message: string) => { checks.push(message); console.log(message); };
const transfers: unknown[] = [];
const temp = mkdtempSync(join(tmpdir(), 'x402-funded-journal-'));
const databasePath = join(temp, 'journal.sqlite');
let db = openDb(databasePath);
const adminSetup: Hex[] = [];
const sourceFiles = ['contracts/src/X402FundedGateway.sol', 'contracts/src/X402AccountFactory.sol', 'contracts/src/Router.sol', 'contracts/src/GasTank.sol', 'contracts/src/X402AgentAccount.sol', 'apps/api/src/x402/funded-gateway.ts', 'api/scripts/x402/fork-funded-journal.ts', 'apps/api/src/x402/funded-operations.ts', 'apps/api/src/x402/write-coordinator.ts', 'apps/api/src/x402/sqlite-funded-journal.ts', 'apps/api/src/x402/viem-funded-ports.ts', 'apps/api/src/x402/facilitator.ts', 'apps/api/src/x402/sqlite-store.ts', 'apps/api/src/x402/viem-write-ports.ts', 'apps/api/src/x402/call-binding.ts', 'apps/api/src/account-writer.ts', 'apps/api/src/chain.ts'];
const sourceHashes = () => Object.fromEntries(sourceFiles.map(path => [path, keccak256(toHex(readFileSync(`${root}/${path}`)))]));
const startHashes = sourceHashes();
let rpcId = 0;
async function rpc(method: string, params: unknown[] = []) {
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000), body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const body = await res.json() as { result: unknown; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}
try {
  let started = false;
  for (let i = 0; i < 120; i++) {
    if (anvil.exitCode !== null) throw new Error(`anvil exited: ${anvilLog}`);
    try { if (String(await rpc('web3_clientVersion')).toLowerCase().includes('anvil')) { started = true; break; } } catch {}
    await delay(250);
  }
  assert(started, `anvil startup failed: ${anvilLog}`);
  const chain = defineChain({ id: 1874, name: 'Isolated Whitechain fork', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [url] } } });
  const readPublic = createPublicClient({ chain, transport: http(url), pollingInterval: 100 });
  // Anvil instant mining can race block-subscription receipt watchers. Poll the actual
  // receipt by hash, bounded, for this local harness (no receipt or transfer fabrication).
  const pub = readPublic.extend(() => ({ async waitForTransactionReceipt({ hash, timeout = 30_000 }: { hash: Hex; timeout?: number }) {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      try { return await readPublic.getTransactionReceipt({ hash }); }
      catch (e) { if (!(e instanceof Error) || e.name !== 'TransactionReceiptNotFoundError') throw e; }
      await delay(100);
    }
    throw new Error(`local receipt timeout: ${hash}`);
  } }));
  assert.equal(await pub.getBlockNumber(), BigInt(forkBlock));
  const relayerKey = toHex(0x402a11cen, { size: 32 });
  const relayer = privateKeyToAccount(relayerKey);
  const owner = privateKeyToAccount(toHex(0x4020aan, { size: 32 }));
  const feeVault = '0x0000000000000000000000000000000000000fee' as Address;
  const session = privateKeyToAccount(toHex(0x402beefn, { size: 32 }));
  const merchant = privateKeyToAccount(toHex(0x402cafen, { size: 32 }));
  const wallet = createWalletClient({ chain, account: owner, transport: http(url) });
  await rpc('anvil_setBalance', [relayer.address, toHex(10n ** 20n)]);
  await rpc('anvil_setBalance', [owner.address, toHex(10n ** 20n)]);
  await rpc('anvil_setBalance', [merchant.address, toHex(10n ** 18n)]);
  // Package deadlines use wall clock. Advance local fork time only, never the remote node.
  await rpc('evm_setNextBlockTimestamp', [Math.floor(Date.now() / 1000)]);
  await rpc('evm_mine');
  const receipt = async (hash: Hex) => { const r = await pub.waitForTransactionReceipt({ hash }); assert.equal(r.status, 'success'); return r; };
  const runtimeHashes = {} as Record<typeof PERMIT2 | typeof EXACT | typeof UPTO, Hex>;
  for (const address of [USDT, PERMIT2, EXACT]) assert.equal(keccak256((await pub.getCode({ address }))!), reference.runtimes[address].hash);
  assert.equal(await pub.getCode({ address: UPTO }), undefined);
  console.log('deploying canonical upto');
  await receipt(await wallet.sendTransaction({ to: CREATE2, data: reference.uptoDeployment.data as Hex, gas: 2_000_000n }));
  for (const address of [PERMIT2, EXACT, UPTO] as const) runtimeHashes[address] = keccak256((await pub.getCode({ address }))!);
  assert.equal(runtimeHashes[UPTO], reference.uptoDeployment.expectedRuntimeHash);
  check('canonical upto deployed locally with official CREATE2 initcode');
  // Compare existing exact runtime with deployment from the pinned official initcode.
  const exactInit = readFileSync(`${root}/contracts/x402-reference/script/data/exact-proxy-initcode.hex`, 'utf8').trim() as Hex;
  console.log('deploying exact runtime comparison');
  const exactCopy = await receipt(await wallet.sendTransaction({ data: exactInit, gas: 2_000_000n }));
  assert.equal(keccak256((await pub.getCode({ address: exactCopy.contractAddress! }))!), runtimeHashes[EXACT]);
  check('existing exact runtime equals pinned official initcode runtime');
  const deploy = async (name: string, args: unknown[] = []) => {
    const a = artifact(name); return (await receipt(await wallet.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args, gas: 10_000_000n }))).contractAddress!;
  };
  const tankArt = artifact('GasTank'), gatewayArt = artifact('X402FundedGateway'), factoryArt = artifact('X402AccountFactory');
  const gasTank = await deploy('GasTank');
  const router = await deploy('Router', [USDT, gasTank, feeVault]);
  await receipt(await wallet.writeContract({ address: gasTank, abi: tankArt.abi, functionName: 'setRouter', args: [router] }));
  await receipt(await wallet.writeContract({ address: router, abi: routerAbi, functionName: 'setLimits', args: [1n, 1_000_000n, 100, 1_000_000, 100_000_000_000n] }));
  const factory = await deploy('X402AccountFactory');
  const gateway = await deploy('X402FundedGateway', [router, factory, { amount: 100_000n, accountCalls: 10, merchantCalls: 20, globalCalls: 30 }]);
  for (const name of ['settleExact', 'settleUpto']) {
    const selector = getFunctionSelector(gatewayArt.abi.find((a: any) => a.type === 'function' && a.name === name));
    await receipt(await wallet.writeContract({ address: router, abi: routerAbi, functionName: 'setAllowed', args: [gateway, selector, true, true] }));
  }
  const art = artifact('X402AgentAccount');
  const createReceipt = await receipt(await wallet.writeContract({ address: factory, abi: factoryArt.abi, functionName: 'createAccount', args: [owner.address, toHex(1n, { size: 32 })], gas: 4_000_000n }));
  const createdAbi = parseAbi(['event AccountCreated(address indexed account,address indexed owner,bytes32 salt)']);
  const creation = createReceipt.logs.filter(l => l.address.toLowerCase() === factory.toLowerCase()).map(l => { try { return decodeEventLog({ abi: createdAbi, data: l.data, topics: l.topics }); } catch { return undefined; } }).find(e => e?.eventName === 'AccountCreated')!;
  const payer = (creation.args as { account: Address }).account;
  assert.equal(await pub.readContract({ address: factory, abi: factoryArt.abi, functionName: 'isAccount', args: [payer] }), true);
  const deployedCodehash = await pub.readContract({ address: factory, abi: factoryArt.abi, functionName: 'accountCodehash', args: [payer] });
  assert.equal(deployedCodehash, keccak256((await pub.getCode({ address: payer }))!));
  check('unchanged root Router/GasTank plus payment-only gateway; account provenance from immutable factory');
  const tokenAbi = parseAbi(['function transfer(address,uint256)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256)', 'event Transfer(address indexed from,address indexed to,uint256 value)']);
  const holder = '0xC0DFd2a61DF78dF2e8b491a90e3765Fbf480689a' as Address;
  const holderBefore = await pub.readContract({ address: USDT, abi: tokenAbi, functionName: 'balanceOf', args: [holder] });
  await rpc('anvil_impersonateAccount', [holder]);
  await rpc('anvil_setBalance', [holder, toHex(10n ** 18n)]);
  const donor = createWalletClient({ chain, account: holder, transport: http(url) });
  await receipt(await donor.writeContract({ address: USDT, abi: tokenAbi, functionName: 'transfer', args: [payer, 1_000_000n], gas: 100_000n }));
  await receipt(await donor.writeContract({ address: USDT, abi: tokenAbi, functionName: 'transfer', args: [merchant.address, 1_000_000n], gas: 100_000n }));
  await rpc('anvil_stopImpersonatingAccount', [holder]);
  assert.equal(await pub.readContract({ address: USDT, abi: tokenAbi, functionName: 'balanceOf', args: [holder] }), holderBefore - 2_000_000n);
  assert.equal(await pub.getBalance({ address: payer }), 0n);
  const now = Math.floor(Date.now() / 1000);
  await receipt(await wallet.writeContract({ address: payer, abi: art.abi, functionName: 'configureSession', args: [session.address, 10_000n, 100_000n, BigInt(now + 3600), [merchant.address]], gas: 500_000n }));
  const bootstrapDeadline = BigInt(now + 300);
  const approvalDigest = await pub.readContract({ address: payer, abi: art.abi, functionName: 'bootstrapDigest', args: [1_000_000n, 0n, bootstrapDeadline] }) as Hex;
  const approvalSignature = await owner.sign({ hash: approvalDigest });
  await receipt(await wallet.writeContract({ address: payer, abi: agentAccountAbi, functionName: 'bootstrap', args: [1_000_000n, bootstrapDeadline, approvalSignature], gas: 200_000n }));
  assert.equal(await pub.readContract({ address: USDT, abi: tokenAbi, functionName: 'allowance', args: [payer, PERMIT2] }), 1_000_000n);
  await assert.rejects(pub.simulateContract({ address: payer, abi: agentAccountAbi, functionName: 'bootstrap', args: [1_000_000n, bootstrapDeadline, approvalSignature] }));
  check('UNSPONSORED fixture bootstrap by separate synthetic owner, bounded signature/replay refusal; no admin grant or tank debit');

  const merchantWallet = createWalletClient({ chain, account: merchant, transport: http(url) });
  await receipt(await merchantWallet.writeContract({ address: USDT, abi: tokenAbi, functionName: 'approve', args: [router, 1_000_000n], gas: 100_000n }));
  await receipt(await merchantWallet.writeContract({ address: gasTank, abi: tankArt.abi, functionName: 'deposit', args: [merchant.address], value: 500_000_000_000_000_000n, gas: 150_000n }));
  await receipt(await merchantWallet.writeContract({ address: gasTank, abi: tankArt.abi, functionName: 'setDailyCap', args: [100_000_000_000_000_000n], gas: 100_000n }));
  let viemChain = new ViemChain(url, relayerKey, { router, gasTank, escrow: payer, subscription: payer });
  const gasPrice = await viemChain.gasPrice(), targetGas = 500_000;
  const feeUSDT = ((BigInt(targetGas) + 40_000n) * gasPrice * 1_000_000n + 10n ** 18n - 1n) / 10n ** 18n;
  // Fixture-only hashes of the just-deployed audited root artifacts. Production must obtain
  // independent pinned deployment hashes, not learn expected values from its untrusted RPC.
  const route = { router, gasTank, feeVault, factory, gateway,
    runtimeHashes: Object.fromEntries(await Promise.all([router, gasTank, factory, gateway, USDT].map(async address => [address.toLowerCase(), keccak256((await pub.getCode({ address }))!)]))) };
  let signatures = 0, termsCalls = 0, policyCalls = 0, prepares = 0, broadcasts = 0;
  let injectAcceptedTimeout = false, crashSnapshot: Buffer | undefined, timeoutHash: Hex | undefined;
  const envelopes: unknown[] = [], rawReceipts: unknown[] = [];
  const terms = { async reserve(_operationId: string, payment: GatewayPayment) {
    termsCalls++;
    // This one-payer synthetic fixture uses its unique Permit2 nonce as the merchant intent nonce.
    // Root's REQUIRED production source must reserve across keeper and every merchant Router user.
    return { nonce: payment.nonce, deadline: payment.deadline, feeUSDT, maxGas: targetGas };
  } };
  const authorizer = { async signExactIntent(address: Address, intent: Parameters<typeof intentTypedData>[0]) {
    signatures++; assert.equal(address, router); assert.equal(intent.target.toLowerCase(), gateway.toLowerCase());
    assert.equal(intent.signer.toLowerCase(), merchant.address.toLowerCase()); assert.equal(intent.merchant.toLowerCase(), merchant.address.toLowerCase());
    return merchant.signTypedData(intentTypedData(intent, address));
  } };
  const policy: MerchantSponsorshipPolicy = { async authorize(request) {
    policyCalls++; assert.equal(request.variant, 'funded'); assert.equal(request.transaction.to, router);
    const decoded = decodeFunctionData({ abi: routerAbi, data: request.transaction.data }); assert.equal(decoded.functionName, 'execute');
    const [intent, data, signature] = decoded.args as unknown as [Parameters<typeof intentTypedData>[0], Hex, Hex];
    assert.equal(intent.target.toLowerCase(), gateway.toLowerCase()); assert.equal(intent.dataHash, keccak256(data));
    assert.equal((await recoverTypedDataAddress({ ...intentTypedData(intent, router), signature })).toLowerCase(), merchant.address.toLowerCase());
    assert.equal(intent.amount, request.amount);
    return { policyId: 'LOCAL_REAL_MERCHANT_ROUTER_AUTHORITY_NOT_PRIVY', maxFeePerGas: gasPrice, merchantDailyLimitWei: 10n ** 17n, merchantDailyCalls: 20 };
  } };
  const mineDepth = async () => { await rpc('evm_mine'); await rpc('evm_mine'); };
  function transport() {
    const ports = new ViemFundedX402WritePorts(viemChain, pub);
    assert.equal(ports.writer, viemChain.writer);
    const prepare = ports.prepare.bind(ports), broadcast = ports.broadcast.bind(ports);
    ports.prepare = async (request, nonce) => {
      prepares++;
      const result = await prepare(request, nonce), tx = parseTransaction(result.raw);
      assert.equal(tx.to?.toLowerCase(), router.toLowerCase()); assert.equal(tx.data, request.data); assert.equal(tx.nonce, nonce);
      assert.equal(tx.gas, 900_000n); assert.equal(tx.gasPrice, gasPrice); assert.equal(tx.chainId, 1874); assert.equal(tx.value ?? 0n, 0n);
      assert.equal(await recoverTransactionAddress({ serializedTransaction: result.raw as TransactionSerialized }), relayer.address);
      const cost = db.prepare('SELECT s.cost_wei FROM relayer_spend_reservations s JOIN relayer_operations w ON s.operation_id=w.operation_id WHERE w.nonce=? AND w.relayer=?').get(nonce, relayer.address.toLowerCase()) as { cost_wei: string };
      assert.equal(BigInt(cost.cost_wei), tx.gas! * tx.gasPrice!);
      envelopes.push({ hash: result.hash, nonce, dataHash: keccak256(request.data), to: router, gas: tx.gas, gasPrice: tx.gasPrice, maximumCostWei: cost.cost_wei });
      return result;
    };
    ports.broadcast = async raw => {
      broadcasts++; const hash = await broadcast(raw); const r = await pub.waitForTransactionReceipt({ hash });
      assert.equal(hash, keccak256(raw)); assert.equal(r.status, 'success'); rawReceipts.push(r);
      assert.equal(viemChain.writer.rows().find(w => w.tx_hash === hash)!.phase, 'broadcasting');
      if (injectAcceptedTimeout) {
        injectAcceptedTimeout = false; timeoutHash = hash; crashSnapshot = db.serialize();
        throw new Error('real Anvil accepted transaction; synthetic transport response timeout');
      }
      await mineDepth(); return hash;
    };
    return ports;
  }
  let ports = transport();
  const funded = { route, outerGas: 900_000n, maxTargetGas: targetGas, maxFeeUSDT: 10_000n, terms, authorizer };
  let coordinator = new X402WriteCoordinator({ db, writer: viemChain.writer, ports, sponsorship: policy, maxSpendPerMinuteWei: 10n ** 18n, confirmations: 2n, funded });
  let journal = new SqliteFundedX402Journal(coordinator);
  let facilitator = new Permit2Facilitator({ publicClient: pub, journal, runtimeHashes, merchants: [merchant.address], maxAmount: 100_000n, maxGas: 500_000n });
  await facilitator.initialize();
  let lastRequest!: { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
  const makeApp = () => {
    const app = new Hono();
    app.use('/settle', async (c, next) => { lastRequest = await c.req.raw.clone().json(); await next(); });
    app.route('/', x402Routes({ facilitator, authorize: async (req, payTo) => req.headers.get('authorization') === 'Bearer synthetic-local-only' && payTo.toLowerCase() === merchant.address.toLowerCase() }));
    return app;
  };
  let app = makeApp();
  const facilitatorHttp = serve({ fetch: req => app.fetch(req), port: 0, hostname: '127.0.0.1' }); servers.push(facilitatorHttp);
  await new Promise<void>(r => facilitatorHttp.on('listening', r));
  const facUrl = `http://127.0.0.1:${(facilitatorHttp.address() as { port: number }).port}`;
  const facClient = new HTTPFacilitatorClient({ url: facUrl, createAuthHeaders: async () => ({ verify: { Authorization: 'Bearer synthetic-local-only' }, settle: { Authorization: 'Bearer synthetic-local-only' }, supported: {} }) });
  const resource = new x402ResourceServer(facClient).register(NETWORK, new ExactServer()).register(NETWORK, new UptoServer());
  const paid = new Hono();
  paid.use(paymentMiddleware({
    'GET /exact': { accepts: { scheme: 'exact', network: NETWORK, payTo: merchant.address, price: { asset: USDT, amount: '10000', extra: { assetTransferMethod: 'permit2' } }, maxTimeoutSeconds: 120 } },
    'GET /upto': { accepts: { scheme: 'upto', network: NETWORK, payTo: merchant.address, price: { asset: USDT, amount: '10000', extra: { assetTransferMethod: 'permit2' } }, maxTimeoutSeconds: 120 } },
  }, resource));
  paid.get('/exact', c => c.json({ paid: true }));
  paid.get('/upto', c => { setSettlementOverrides(c, { amount: '4000' }); return c.json({ paid: true, metered: 4000 }); });
  const resourceHttp = serve({ fetch: paid.fetch, port: 0, hostname: '127.0.0.1' }); servers.push(resourceHttp);
  await new Promise<void>(r => resourceHttp.on('listening', r));
  const paidUrl = `http://127.0.0.1:${(resourceHttp.address() as { port: number }).port}`;
  const balances = async () => ({
    payer: await pub.readContract({ address: USDT, abi: tokenAbi, functionName: 'balanceOf', args: [payer] }),
    merchant: await pub.readContract({ address: USDT, abi: tokenAbi, functionName: 'balanceOf', args: [merchant.address] }),
    vault: await pub.readContract({ address: USDT, abi: tokenAbi, functionName: 'balanceOf', args: [feeVault] }),
    tank: await pub.readContract({ address: gasTank, abi: tankArt.abi, functionName: 'balanceOf', args: [merchant.address] }) as bigint,
    relayer: await pub.getBalance({ address: relayer.address }),
  });
  const signer = createX402AccountSigner(payer, pub, session, { async reserve(account, payment, signature) {
    const before = await balances();
    // Explicit UNSPONSORED fixture setup, not an admin grant or a payment quote.
    const hash = await wallet.writeContract({ address: account, abi: agentAccountAbi, functionName: 'reserve', args: [payment, signature], gas: 300_000n });
    await receipt(hash); adminSetup.push(hash); assert.deepEqual(await balances(), before);
  } });
  const client = x402Client.fromConfig({ schemes: [{ network: NETWORK, client: new ExactClient(signer) }, { network: NETWORK, client: new UptoClient(signer) }], spendControls: { allowedAssets: [{ network: NETWORK, asset: USDT, maxAmountPerPayment: '10000' }] } });
  const payingFetch = wrapFetchWithPayment(fetch, client);
  for (const scheme of ['exact', 'upto']) {
    const before = await balances();
    const response = await payingFetch(`${paidUrl}/${scheme}`); assert.equal(response.status, 200, await response.text());
    const result = decodePaymentResponseHeader(response.headers.get('payment-response')!); assert(result.success);
    const row = db.prepare('SELECT f.proof_json FROM x402_funded_operations f JOIN x402_operations o USING(operation_key) JOIN relayer_operations w ON w.operation_id=o.write_id WHERE w.tx_hash=?').get(result.transaction) as { proof_json: string };
    const proof = JSON.parse(row.proof_json); const after = await balances();
    assert.equal(before.payer - after.payer, BigInt(proof.amount)); assert.equal(after.merchant - before.merchant, BigInt(proof.amount) - feeUSDT);
    assert.equal(after.vault - before.vault, feeUSDT); assert.equal(before.tank - after.tank, BigInt(proof.reimbursement));
    assert.equal(before.relayer - after.relayer, BigInt(proof.relayerNetGasCostWei));
    transfers.push({ scheme, transaction: result.transaction, before, after, proof });
    const count = broadcasts;
    const retries = await Promise.all([facilitator.settle(lastRequest.paymentPayload, lastRequest.paymentRequirements), facilitator.settle(lastRequest.paymentPayload, lastRequest.paymentRequirements)]);
    assert(retries.every(r => r.success && r.transaction === result.transaction)); assert.equal(broadcasts, count);
    check(`official ${scheme} through production Permit2Facilitator/SQLite funded journal: real payment, fee, reimbursement, depth, concurrent deduplication`);
  }
  injectAcceptedTimeout = true;
  const beforeTimeout = await balances();
  const response = await payingFetch(`${paidUrl}/exact`); assert.equal(response.status, 402, await response.text());
  assert(crashSnapshot && timeoutHash);
  const acceptedRequest = lastRequest;
  const originalAuth = db.prepare('SELECT authorization_json,envelope_json FROM x402_funded_operations ORDER BY rowid DESC LIMIT 1').get();
  const counts = { signatures, termsCalls, policyCalls, prepares, broadcasts };
  assert.equal(viemChain.writer.rows().find(r => r.tx_hash === timeoutHash)!.phase, 'uncertain');
  db.close(); writeFileSync(databasePath, crashSnapshot); db = openDb(databasePath);
  viemChain = new ViemChain(url, relayerKey, { router, gasTank, escrow: payer, subscription: payer }); ports = transport();
  coordinator = new X402WriteCoordinator({ db, writer: viemChain.writer, ports, sponsorship: policy, maxSpendPerMinuteWei: 10n ** 18n, confirmations: 2n, funded });
  journal = new SqliteFundedX402Journal(coordinator);
  facilitator = new Permit2Facilitator({ publicClient: pub, journal, runtimeHashes, merchants: [merchant.address], maxAmount: 100_000n, maxGas: 500_000n });
  await facilitator.initialize(); app = makeApp();
  assert.equal(viemChain.writer.rows().find(r => r.tx_hash === timeoutHash)!.phase, 'broadcasting');
  assert.equal((await facilitator.settle(acceptedRequest.paymentPayload, acceptedRequest.paymentRequirements)).success, false);
  await assert.rejects(viemChain.writer.run(async () => assert.fail('uncertain write must block unrelated signer writes')), /relayer_pending/);
  await mineDepth(); await journal.reconcile();
  const recovered = await Promise.all([facilitator.settle(acceptedRequest.paymentPayload, acceptedRequest.paymentRequirements), facilitator.settle(acceptedRequest.paymentPayload, acceptedRequest.paymentRequirements)]);
  assert(recovered.every(r => r.success && r.transaction === timeoutHash));
  const httpRecovered = await fetch(`${facUrl}/settle`, { method: 'POST', headers: { authorization: 'Bearer synthetic-local-only', 'content-type': 'application/json' }, body: JSON.stringify(acceptedRequest) });
  assert.equal(httpRecovered.status, 200); assert.deepEqual(await httpRecovered.json(), recovered[0]);
  assert.deepEqual({ signatures, termsCalls, policyCalls, prepares, broadcasts }, counts);
  assert.deepEqual(db.prepare('SELECT authorization_json,envelope_json FROM x402_funded_operations ORDER BY rowid DESC LIMIT 1').get(), originalAuth);
  const proof = JSON.parse((db.prepare('SELECT proof_json FROM x402_funded_operations ORDER BY rowid DESC LIMIT 1').get() as any).proof_json);
  const afterTimeout = await balances();
  assert.equal(beforeTimeout.payer - afterTimeout.payer, 10_000n); assert.equal(beforeTimeout.tank - afterTimeout.tank, BigInt(proof.reimbursement));
  assert.equal(beforeTimeout.relayer - afterTimeout.relayer, BigInt(proof.relayerNetGasCostWei));
  transfers.push({ scheme: 'exact', transaction: timeoutHash, acceptedTimeoutRestart: true, before: beforeTimeout, after: afterTimeout, proof });
  check('real accepted-timeout transfer: broadcasting SQLite crash image, immutable authorization/envelope, two-block hold, independent restart/HTTP recovery without resend or reauthorization');
  const auth = (acceptedRequest.paymentPayload.payload as any).permit2Authorization;
  const op = { id: `${NETWORK}:permit2:${payer.toLowerCase()}:${BigInt(auth.nonce)}`, fingerprint: fingerprint({ payload: acceptedRequest.paymentPayload, req: acceptedRequest.paymentRequirements }), payer, merchant: merchant.address, amount: 10_000n };
  await assert.rejects(new SqliteX402Journal(coordinator).runOnce(op, async () => { assert.fail('direct/funded nonce conflict must not execute'); }), /idempotency_conflict/);
  assert.equal((db.prepare('SELECT COUNT(*) n FROM x402_operations WHERE kind=\'x402\'').get() as any).n, 3);
  assert.equal(viemChain.writer.rows().length, 3); assert.equal(broadcasts, 3); assert.equal(signatures, 3); assert.equal(termsCalls, 3);
  assert(viemChain.writer.rows().every(r => r.phase === 'confirmed')); assert.equal(await pub.getBalance({ address: payer }), 0n);
  check('shared global payer Permit2 nonce rejects direct replay of funded operation; three existing AccountWriter nonces and durable budgets only');
  assert.deepEqual(sourceHashes(), startHashes, 'Source changed during evidence run');
  const evidence = { localOnly: true, generatedAt: new Date().toISOString(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceTreeDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
    sourceHashes: startHashes, artifactInitcodeHashes: Object.fromEntries(['Router', 'GasTank', 'X402AccountFactory', 'X402FundedGateway', 'X402AgentAccount'].map(name => [name, keccak256(artifact(name).bytecode.object)])), forkBlock, forkBlockHash: (await pub.getBlock({ blockNumber: BigInt(forkBlock) })).hash, remoteRpc, runtimeHashes, route,
    addresses: { payer, owner: owner.address, merchant: merchant.address, relayer: relayer.address, router, gasTank, feeVault, factory, gateway },
    checks, transfers, envelopes, rawReceipts, adminSetupUnfunded: adminSetup, writerRows: viemChain.writer.rows(),
    operations: db.prepare('SELECT * FROM x402_operations').all(), authorizations: db.prepare('SELECT * FROM x402_funded_operations').all(), gasReservations: db.prepare('SELECT * FROM relayer_spend_reservations').all(), merchantReservations: db.prepare('SELECT * FROM x402_sponsorship_reservations').all(),
    counts: { signatures, termsCalls, policyCalls, prepares, broadcasts },
    productionActivation: 'INACTIVE: genuine Privy merchant signing and shared merchant terms authority pending; admin grants disabled; root runtime/indexer integration and live deployment/attestation require separate authorization.' };
  writeFileSync(`${root}/docs/x402/funded-journal-fork-evidence.json`, JSON.stringify(JSON.parse(canonicalJson(evidence)), null, 2) + '\n');
  console.log('Production journal path proof saved; no script-only journal, no live activation');
} finally {
  for (const server of servers) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  anvil.kill('SIGTERM'); if (db.open) db.close(); rmSync(temp, { recursive: true, force: true });
}
