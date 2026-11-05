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
import { x402Facilitator } from '@x402/core/facilitator';
import { ExactEvmScheme as ExactFacilitator } from '@x402/evm/exact/facilitator';
import { UptoEvmScheme as UptoFacilitator } from '@x402/evm/upto/facilitator';
import type { FacilitatorEvmSigner } from '@x402/evm';
import { ViemChain, routerAbi } from '../../src/chain.js';
import { openDb } from '../../src/db.js';
import { intentTypedData } from '../../src/typed-data.js';
import { gatewayPayment, authorizeGatewayPayment, fundedReceipt, fundedGatewayAbi, type GatewayPayment } from '../../src/x402/funded-gateway.js';
import { SqlitePendingSettlementStore, canonicalJson, fingerprint } from '../../src/x402/sqlite-store.js';
import type { IntentRequest } from '../../src/types.js';
import type { MerchantSponsorshipPolicy, X402Receipt } from '../../src/x402/write-ports.js';
import { ExactEvmScheme as ExactServer } from '@x402/evm/exact/server';
import { UptoEvmScheme as UptoServer } from '@x402/evm/upto/server';
import { ExactEvmScheme as ExactClient } from '@x402/evm/exact/client';
import { UptoEvmScheme as UptoClient } from '@x402/evm/upto/client';
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch';
import { createPublicClient, createWalletClient, decodeFunctionData, decodeEventLog, encodeFunctionData, getFunctionSelector, parseTransaction, recoverTransactionAddress, recoverTypedDataAddress, defineChain, http, keccak256, parseAbi, toHex, type Address, type Hex, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createX402AccountSigner, agentAccountAbi } from '../../src/x402/account-client.js';
import { CREATE2, EXACT, NETWORK, PERMIT2, UPTO, USDT } from '../../src/x402/constants.js';
import type { PaymentPayload, PaymentRequirements, SettleResponse } from '@x402/core/types';

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
const temp = mkdtempSync(join(tmpdir(), 'x402-funded-gateway-'));
const db = openDb(join(temp, 'proof.sqlite'));
const adminSetup: Hex[] = [];
const sourceFiles = ['contracts/src/X402FundedGateway.sol', 'contracts/src/X402AccountFactory.sol', 'contracts/src/Router.sol', 'contracts/src/GasTank.sol', 'contracts/src/X402AgentAccount.sol', 'apps/api/src/x402/funded-gateway.ts', 'api/scripts/x402/fork-funded-gateway.ts'];
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
  const viemChain = new ViemChain(url, relayerKey, { router, gasTank, escrow: payer, subscription: payer });
  const writer = viemChain.writer; writer.bind(db);
  db.exec('CREATE TABLE funded_proof(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, request_json TEXT NOT NULL, result_json TEXT)');
  const gasPrice = await viemChain.gasPrice(), outerGas = 900_000n, targetGas = 500_000;
  const feeUSDT = ((BigInt(targetGas) + 40_000n) * gasPrice * 1_000_000n + 10n ** 18n - 1n) / 10n ** 18n;
  const signedRequests = new Map<string, IntentRequest>();
  const accepted = new Map<Hex, { payment: GatewayPayment; request: IntentRequest }>();
  let merchantNonce = 0n, sends = 0, attempts = 0;
  // Synthetic merchant key is real signing authority for this local merchant. API credentials are
  // not authority. Production Privy delegation and final funded journal integration remain absent.
  const authority = { async signExactIntent(address: Address, intent: Parameters<typeof intentTypedData>[0]) {
    assert.equal(address.toLowerCase(), router.toLowerCase()); assert.equal(intent.signer.toLowerCase(), merchant.address.toLowerCase());
    assert.equal(intent.merchant.toLowerCase(), merchant.address.toLowerCase()); assert.equal(intent.target.toLowerCase(), gateway.toLowerCase());
    return merchant.signTypedData(intentTypedData(intent, address));
  } };
  const policy: MerchantSponsorshipPolicy = { async authorize(request) {
    assert.equal(request.transaction.to.toLowerCase(), router.toLowerCase());
    const signed = signedRequests.get(keccak256(request.transaction.data));
    assert(signed, 'No exact merchant-authorized Router envelope');
    assert.equal((await recoverTypedDataAddress({ ...intentTypedData(signed.intent, router), signature: signed.signature })).toLowerCase(), merchant.address.toLowerCase());
    assert.equal(signed.intent.signer.toLowerCase(), merchant.address.toLowerCase());
    assert.equal(request.merchant.toLowerCase(), merchant.address.toLowerCase());
    return { policyId: 'LOCAL_REAL_MERCHANT_INTENT_AND_GASTANK_NOT_PRODUCTION_PRIVY', maxFeePerGas: gasPrice, merchantDailyLimitWei: 10n ** 17n, merchantDailyCalls: 20 };
  } };
  const balances = async () => ({
    payer: await pub.readContract({ address: USDT, abi: tokenAbi, functionName: 'balanceOf', args: [payer] }),
    merchant: await pub.readContract({ address: USDT, abi: tokenAbi, functionName: 'balanceOf', args: [merchant.address] }),
    vault: await pub.readContract({ address: USDT, abi: tokenAbi, functionName: 'balanceOf', args: [feeVault] }),
    tank: await pub.readContract({ address: gasTank, abi: tankArt.abi, functionName: 'balanceOf', args: [merchant.address] }) as bigint,
    relayer: await pub.getBalance({ address: relayer.address }),
  });
  async function sendRequest(payment: GatewayPayment, request: IntentRequest, expectFunded = true) {
    const data = encodeFunctionData({ abi: routerAbi, functionName: 'execute', args: [request.intent, request.data, request.signature] });
    const operation = { id: `funded-proof:${++attempts}:${fingerprint(request)}`, kind: 'x402' as const, objectId: `${payer}:${payment.nonce}` };
    signedRequests.set(keccak256(data), request);
    // Explicit adversarial sends use local relayer funds to test onchain refusal; no merchant
    // policy grant is claimed for those attempts. They still reserve the shared writer gas budget.
    const grant = expectFunded ? await policy.authorize({ operationId: operation.id, kind: 'x402', merchant: payment.merchant, payer: payment.payer, amount: payment.amount, transaction: { chainId: 1874, to: router, data, value: 0n, gas: outerGas } }) : { maxFeePerGas: gasPrice };
    const before = await balances();
    let signedEnvelope: unknown;
    const hash = await writer.run(async () => {
      db.transaction(() => {
        writer.reserve(operation);
        writer.reserveSpend(operation.id, outerGas * grant.maxFeePerGas, 10n ** 18n);
        db.prepare('INSERT INTO funded_proof(id,fingerprint,request_json) VALUES (?,?,?)').run(operation.id, fingerprint({ payment, request }), canonicalJson({ payment, request, data }));
      })();
      return writer.execute(operation, () => viemChain.transactionCount(), async nonce => {
        const prepared = await viemChain.prepareIntent(request, outerGas, nonce, gasPrice);
        const tx = parseTransaction(prepared.raw);
        assert.equal(tx.data, data); assert.equal(tx.to?.toLowerCase(), router.toLowerCase()); assert.equal(tx.nonce, nonce);
        assert.equal(tx.gas, outerGas); assert.equal(tx.gasPrice, gasPrice); assert.equal(tx.chainId, 1874);
        assert.equal(await recoverTransactionAddress({ serializedTransaction: prepared.raw as TransactionSerialized }), relayer.address);
        signedEnvelope = { hash: prepared.hash, nonce, to: tx.to, dataHash: keccak256(data), gas: tx.gas, gasPrice: tx.gasPrice, maximumCostWei: tx.gas! * tx.gasPrice! };
        return prepared;
      }, raw => { sends++; return viemChain.broadcastTransaction(raw); });
    }, operation.id);
    const rawReceipt = await pub.waitForTransactionReceipt({ hash });
    await rpc('evm_mine'); await rpc('evm_mine');
    assert(await viemChain.x402BlockNumber() >= rawReceipt.blockNumber + 2n);
    const r = (await viemChain.x402Receipt(hash))!;
    writer.resolve(hash, r.block, r.status);
    const after = await balances();
    const actualGasCost = rawReceipt.gasUsed * rawReceipt.effectiveGasPrice;
    assert(actualGasCost <= outerGas * gasPrice);
    let proof;
    if (expectFunded) {
      proof = fundedReceipt(r, payment, request, { router, gasTank, feeVault, relayer: relayer.address }, gasPrice);
      assert.equal(before.payer - after.payer, payment.amount);
      assert.equal(after.merchant - before.merchant, payment.amount - feeUSDT);
      assert.equal(after.vault - before.vault, feeUSDT);
      assert.equal(before.tank - after.tank, proof.reimbursement);
      assert.equal(after.relayer - before.relayer, proof.reimbursement - actualGasCost);
      assert(proof.reimbursement <= (BigInt(targetGas) + 40_000n) * gasPrice);
      accepted.set(hash, { payment, request });
    } else {
      assert.throws(() => fundedReceipt(r, payment, request, { router, gasTank, feeVault, relayer: relayer.address }, gasPrice));
      assert.equal(before.payer, after.payer); assert.equal(before.merchant, after.merchant);
      assert.equal(before.vault, after.vault); assert.equal(before.tank, after.tank);
      assert.equal(before.relayer - after.relayer, actualGasCost);
    }
    const result = { hash, expectFunded, payment, request, signedEnvelope, rawReceipt, before, after, actualGasCost,
      reimbursement: proof?.reimbursement ?? 0n, relayerNetGasCostWei: actualGasCost - (proof?.reimbursement ?? 0n) };
    transfers.push(result); db.prepare('UPDATE funded_proof SET result_json=? WHERE id=?').run(canonicalJson(result), operation.id);
    return hash;
  }
  let lastPayment!: GatewayPayment, lastRequest!: IntentRequest;
  const facilitatorSigner: FacilitatorEvmSigner = {
    getAddresses: () => [gateway], // EXPLICIT caller identity advertised before official upto signing.
    readContract: args => pub.readContract({ ...args, account: gateway } as never),
    verifyTypedData: args => pub.verifyTypedData(args as never), getCode: args => pub.getCode(args),
    sendTransaction: async () => { throw new Error('arbitrary_send_disabled'); },
    writeContract: async args => {
      assert.equal(args.functionName, 'settle'); assert(!args.dataSuffix);
      const payment = gatewayPayment(args.address, encodeFunctionData(args as never), gateway);
      const request = await authorizeGatewayPayment(payment, router, { nonce: ++merchantNonce, deadline: payment.deadline, feeUSDT, maxGas: targetGas }, authority);
      lastPayment = payment; lastRequest = request;
      const sim = await viemChain.simulate(request, { gas: outerGas, gasPrice }); assert(sim.accepted, sim.reason);
      return sendRequest(payment, request);
    },
    waitForTransactionReceipt: async ({ hash }) => {
      const r = await pub.waitForTransactionReceipt({ hash }); const prepared = accepted.get(hash); assert(prepared);
      fundedReceipt((await viemChain.x402Receipt(hash))!, prepared.payment, prepared.request, { router, gasTank, feeVault, relayer: relayer.address }, r.effectiveGasPrice);
      return r;
    },
  };
  const pending = new SqlitePendingSettlementStore(db, `local-funded-gateway:${gateway}`);
  const facilitator = new x402Facilitator().register(NETWORK, new ExactFacilitator(facilitatorSigner, { simulateInSettle: true, pendingSettlementStore: pending }))
    .register(NETWORK, new UptoFacilitator(facilitatorSigner, { pendingSettlementStore: pending }));
  const app = new Hono();
  app.get('/supported', c => c.json(facilitator.getSupported()));
  for (const action of ['verify', 'settle'] as const) app.post(`/${action}`, async c => {
    assert.equal(c.req.header('authorization'), 'Bearer synthetic-local-only');
    const body = await c.req.json(); assert.equal(body.paymentRequirements.payTo.toLowerCase(), merchant.address.toLowerCase());
    return c.json(await facilitator[action](body.paymentPayload, body.paymentRequirements));
  });
  const facilitatorHttp = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }); servers.push(facilitatorHttp);
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
  const signer = createX402AccountSigner(payer, pub, session, { async reserve(account, payment, signature) {
    // Explicit UNSPONSORED fixture precondition. No admin call goes through gateway/Router or takes
    // payment fees/reimbursement. Future admin sponsorship needs its own bounded grant and proof.
    const before = await balances();
    const hash = await wallet.writeContract({ address: account, abi: agentAccountAbi, functionName: 'reserve', args: [payment, signature], gas: 300_000n });
    await receipt(hash); adminSetup.push(hash);
    const after = await balances(); assert.deepEqual(after, before);
  } });
  const client = x402Client.fromConfig({ schemes: [{ network: NETWORK, client: new ExactClient(signer) }, { network: NETWORK, client: new UptoClient(signer) }], spendControls: { allowedAssets: [{ network: NETWORK, asset: USDT, maxAmountPerPayment: '10000' }] } });
  const payingFetch = wrapFetchWithPayment(fetch, client);
  for (const scheme of ['exact', 'upto']) {
    const response = await payingFetch(`${paidUrl}/${scheme}`); assert.equal(response.status, 200, await response.text());
    const result = decodePaymentResponseHeader(response.headers.get('payment-response')!); assert(result.success && accepted.has(result.transaction as Hex));
    check(`official @x402/fetch ${scheme}: actual USDT + merchant fee + GasTank reimbursement + Router/gateway/proxy evidence, two-block depth`);
  }
  assert.equal(sends, 2); assert.equal(await pub.getBalance({ address: payer }), 0n);
  // These sends exercise native-success Router refusals. No successful payment or reimbursement is inferred.
  const replayHash = await sendRequest(lastPayment, lastRequest, false); assert(replayHash);
  check('merchant Router intent replay: actual receipt, zero additional USDT/fee/reimbursement; relayer pays failed-attempt gas');
  const reusedPermit = await authorizeGatewayPayment(lastPayment, router, { nonce: ++merchantNonce, deadline: lastPayment.deadline, feeUSDT, maxGas: targetGas }, authority);
  await sendRequest(lastPayment, reusedPermit, false);
  check('fresh merchant Router intent cannot reimburse or repeat an already consumed official Permit2 nonce');
  const unsupported = encodeFunctionData({ abi: agentAccountAbi, functionName: 'bootstrap', args: [1n, BigInt(now + 120), approvalSignature] });
  await assert.rejects(pub.readContract({ address: gateway, abi: fundedGatewayAbi, functionName: 'sponsorshipQuote', args: [unsupported] }));
  check('bootstrap selector has no payment quote and no funded route');
  // A fresh official permit is reserved, then a correctly signed NON-merchant intent is refused by context.
  let captured: { payment: Parameters<typeof signer.signTypedData>[0]; signature: Hex } | undefined;
  const captureSigner = { ...signer, async signTypedData(typed: Parameters<typeof signer.signTypedData>[0]) { const signature = await signer.signTypedData(typed); captured = { payment: typed, signature }; return signature; } };
  const contextClient = x402Client.fromConfig({ schemes: [{ network: NETWORK, client: new ExactClient(captureSigner) }], spendControls: { allowedAssets: [{ network: NETWORK, asset: USDT, maxAmountPerPayment: '10000' }] } });
  // Obtain an official payload without sending it to the facilitator.
  const requirements: PaymentRequirements = { scheme: 'exact', network: NETWORK, asset: USDT, amount: '10000', payTo: merchant.address, maxTimeoutSeconds: 120, extra: { assetTransferMethod: 'permit2' } };
  const payload = await contextClient.createPaymentPayload({ x402Version: 2, resource: { url: `${paidUrl}/exact`, description: 'local context refusal', mimeType: 'application/json' }, accepts: [requirements] });
  assert(captured && payload.payload);
  const auth = (payload.payload as any).permit2Authorization;
  const p = { permitted: { token: USDT, amount: BigInt(auth.permitted.amount) }, nonce: BigInt(auth.nonce), deadline: BigInt(auth.deadline) };
  const badPayment = gatewayPayment(EXACT, encodeFunctionData({ abi: (await import('../../src/x402/call-binding.js')).exactSettlementAbi, functionName: 'settle', args: [p, payer, { to: merchant.address, validAfter: BigInt(auth.witness.validAfter) }, (payload.payload as any).signature] }), gateway);
  const good = await authorizeGatewayPayment(badPayment, router, { nonce: ++merchantNonce, deadline: badPayment.deadline, feeUSDT, maxGas: targetGas }, authority);
  const badIntent = { ...good.intent, signer: owner.address };
  const badRequest = { intent: badIntent, data: good.data, signature: await owner.signTypedData(intentTypedData(badIntent, router)) };
  await sendRequest(badPayment, badRequest, false);
  check('real non-merchant Router signature cannot spend merchant tank: gateway context refuses and no payment/fee/reimbursement occurs');
  // Missing fee allowance refuses before payment, even with a valid merchant intent and reserved permit.
  await receipt(await merchantWallet.writeContract({ address: USDT, abi: tokenAbi, functionName: 'approve', args: [router, 0n], gas: 100_000n }));
  await sendRequest(badPayment, good, false);
  check('missing merchant fee allowance refuses actual funded payment without token transfer or reimbursement');
  await receipt(await merchantWallet.writeContract({ address: USDT, abi: tokenAbi, functionName: 'approve', args: [router, 1_000_000n], gas: 100_000n }));
  const remainingTank = (await balances()).tank;
  await receipt(await merchantWallet.writeContract({ address: gasTank, abi: tankArt.abi, functionName: 'withdraw', args: [remainingTank], gas: 100_000n }));
  await sendRequest(badPayment, good, false);
  check('depleted merchant tank refuses actual funded payment without token transfer, fee or reimbursement');
  assert.equal(sends, 7); assert.equal(writer.rows().length, 7);
  assert.deepEqual(sourceHashes(), startHashes, 'Source changed during evidence run');
  const evidence = { localOnly: true, generatedAt: new Date().toISOString(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceTreeDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
    sourceHashes: startHashes, forkBlock, forkBlockHash: (await pub.getBlock({ blockNumber: BigInt(forkBlock) })).hash, remoteRpc, runtimeHashes, tokenRuntimeHash: keccak256((await pub.getCode({ address: USDT }))!), deployedRuntimeHashes: Object.fromEntries(await Promise.all([router, gasTank, factory, gateway, payer].map(async address => [address, keccak256((await pub.getCode({ address }))!)]))),
    addresses: { payer, owner: owner.address, merchant: merchant.address, relayer: relayer.address, router, gasTank, feeVault, factory, gateway },
    artifacts: Object.fromEntries(['Router', 'GasTank', 'X402AccountFactory', 'X402FundedGateway', 'X402AgentAccount'].map(name => [name, { creationHash: keccak256(artifact(name).bytecode.object) }])),
    versions: { core: '2.29.0', evm: '2.29.0', fetch: '2.29.0', hono: '2.29.0' }, checks, transfers, adminSetupUnfunded: adminSetup, writerRows: writer.rows(),
    productionActivation: 'INACTIVE: no genuine production merchant signing/delegation, funded journal/domain recovery integration, bounded admin grants, enrollment or runtime activation. Local synthetic keys are not Privy evidence.' };
  writeFileSync(`${root}/docs/x402/funded-gateway-fork-evidence.json`, JSON.stringify(JSON.parse(canonicalJson(evidence)), null, 2) + '\n');
  console.log(`Evidence saved; ${sends} real Router sends; production inactive`);
} finally {
  for (const server of servers) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  anvil.kill('SIGTERM'); if (db.open) db.close(); rmSync(temp, { recursive: true, force: true });
}
