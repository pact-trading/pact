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
import { openDb } from '../../src/db.js';
import { ViemChain } from '../../src/chain.js';
import { ViemX402WritePorts } from '../../src/x402/viem-write-ports.js';
import { X402WriteCoordinator } from '../../src/x402/write-coordinator.js';
import { SqliteX402Journal } from '../../src/x402/sqlite-journal.js';
import { SqliteAccountReservationAdapter, ReservationPendingError } from '../../src/x402/sqlite-reservations.js';
import type { MerchantSponsorshipPolicy } from '../../src/x402/write-ports.js';
import { canonicalJson } from '../../src/x402/sqlite-store.js';
import { ExactEvmScheme as ExactServer } from '@x402/evm/exact/server';
import { UptoEvmScheme as UptoServer } from '@x402/evm/upto/server';
import { ExactEvmScheme as ExactClient } from '@x402/evm/exact/client';
import { UptoEvmScheme as UptoClient } from '@x402/evm/upto/client';
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch';
import { createPublicClient, createWalletClient, decodeFunctionData, parseTransaction, recoverTransactionAddress, defineChain, http, keccak256, parseAbi, toHex, type Address, type Hex, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Permit2Facilitator } from '../../src/x402/facilitator.js';
import { x402Routes } from '../../src/x402/routes.js';
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
const envelopes: unknown[] = [];
const rawReceipts: unknown[] = [];
const temp = mkdtempSync(join(tmpdir(), 'x402-real-fork-journal-'));
const databasePath = join(temp, 'journal.sqlite');
let db = openDb(databasePath);
let rpcId = 0;
async function rpc(method: string, params: unknown[] = []) {
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000), body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
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
  const session = privateKeyToAccount(toHex(0x402beefn, { size: 32 }));
  const merchant = privateKeyToAccount(toHex(0x402cafen, { size: 32 }));
  const wallet = createWalletClient({ chain, account: owner, transport: http(url) });
  await rpc('anvil_setBalance', [relayer.address, toHex(10n ** 20n)]);
  await rpc('anvil_setBalance', [owner.address, toHex(10n ** 20n)]);
  // Package deadlines use wall clock. Advance local fork time only, never the remote node.
  await rpc('evm_setNextBlockTimestamp', [Math.floor(Date.now() / 1000)]);
  await rpc('evm_mine');
  const receipt = async (hash: Hex) => { const r = await pub.waitForTransactionReceipt({ hash }); assert.equal(r.status, 'success'); return r; };
  const runtimeHashes = {} as Record<typeof PERMIT2 | typeof EXACT | typeof UPTO, Hex>;
  for (const address of [PERMIT2, EXACT]) assert.equal(keccak256((await pub.getCode({ address }))!), reference.runtimes[address].hash);
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
  const art = artifact('X402AgentAccount');
  const deployed = await receipt(await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [owner.address], gas: 4_000_000n }));
  const payer = deployed.contractAddress!;
  const tokenAbi = parseAbi(['function transfer(address,uint256)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'event Transfer(address indexed from,address indexed to,uint256 value)']);
  const holder = '0xC0DFd2a61DF78dF2e8b491a90e3765Fbf480689a' as Address;
  const holderBefore = await pub.readContract({ address: USDT, abi: tokenAbi, functionName: 'balanceOf', args: [holder] });
  await rpc('anvil_impersonateAccount', [holder]);
  await rpc('anvil_setBalance', [holder, toHex(10n ** 18n)]);
  const donor = createWalletClient({ chain, account: holder, transport: http(url) });
  await receipt(await donor.writeContract({ address: USDT, abi: tokenAbi, functionName: 'transfer', args: [payer, 1_000_000n], gas: 100_000n }));
  await rpc('anvil_stopImpersonatingAccount', [holder]);
  assert.equal(await pub.readContract({ address: USDT, abi: tokenAbi, functionName: 'balanceOf', args: [holder] }), holderBefore - 1_000_000n);
  assert.equal(await pub.getBalance({ address: payer }), 0n);
  const now = Math.floor(Date.now() / 1000);
  await receipt(await wallet.writeContract({ address: payer, abi: art.abi, functionName: 'configureSession', args: [session.address, 10_000n, 100_000n, BigInt(now + 3600), [merchant.address]], gas: 500_000n }));
  const bootstrapDeadline = BigInt(now + 300);
  const approvalDigest = await pub.readContract({ address: payer, abi: art.abi, functionName: 'bootstrapDigest', args: [1_000_000n, 0n, bootstrapDeadline] }) as Hex;
  const approvalSignature = await owner.sign({ hash: approvalDigest });
  await receipt(await wallet.writeContract({ address: payer, abi: agentAccountAbi, functionName: 'bootstrap', args: [1_000_000n, bootstrapDeadline, approvalSignature], gas: 200_000n }));
  assert.equal(await pub.readContract({ address: USDT, abi: tokenAbi, functionName: 'allowance', args: [payer, PERMIT2] }), 1_000_000n);
  await assert.rejects(pub.simulateContract({ address: payer, abi: agentAccountAbi, functionName: 'bootstrap', args: [1_000_000n, bootstrapDeadline, approvalSignature] }));
  check('bounded owner-signed gasless bootstrap and bootstrap replay refusal; payer WBT remains zero');

  // Bypass client-side spend controls to prove refusals originate in the actual account.
  const reservation = { spender: EXACT, amount: 10_001n, nonce: 999n, deadline: BigInt(now + 120), to: merchant.address, facilitator: '0x0000000000000000000000000000000000000000' as Address, validAfter: 0n };
  const signReservation = async (p: typeof reservation) => {
    const digest = await pub.readContract({ address: payer, abi: art.abi, functionName: 'permitDigest', args: [p] }) as Hex;
    const hash = await pub.readContract({ address: payer, abi: agentAccountAbi, functionName: 'sessionDigest', args: [digest] });
    return session.sign({ hash });
  };
  let reservationSignature = await signReservation(reservation);
  await assert.rejects(pub.simulateContract({ address: payer, abi: art.abi, functionName: 'reserve', args: [reservation, reservationSignature] }), /PerCallCap/);
  reservation.amount = 10_000n; reservation.to = relayer.address;
  reservationSignature = await signReservation(reservation);
  await assert.rejects(pub.simulateContract({ address: payer, abi: art.abi, functionName: 'reserve', args: [reservation, reservationSignature] }), /MerchantDenied/);
  check('onchain per-call and merchant allowlist refusals, bypassing client-side guards');

  // One real ViemChain signer/writer, used by BOTH reservation and settlement adapters.
  // Fixture-only owner/admin writes above use a distinct synthetic owner, never this relayer.
  const addresses = { router: EXACT, escrow: EXACT, subscription: EXACT, fees: EXACT }; // Unused domain addresses; x402 transport never calls them.
  let viemChain = new ViemChain(url, relayerKey, addresses);
  const gasPrice = await pub.getGasPrice();
  assert(gasPrice > 0n && gasPrice <= 100_000_000_000n);
  const policyId = 'SYNTHETIC_LOCAL_ANVIL_NO_M7_REIMBURSEMENT';
  let syntheticDailyLimit = 10n ** 18n;
  const sponsorship: MerchantSponsorshipPolicy = { async authorize(request) {
    assert.equal(new URL(url).hostname, '127.0.0.1');
    assert.equal(await viemChain.chainId(), 1874);
    assert.equal(request.merchant.toLowerCase(), merchant.address.toLowerCase());
    assert.equal(request.payer.toLowerCase(), payer.toLowerCase());
    return { policyId, maxFeePerGas: gasPrice, merchantDailyLimitWei: syntheticDailyLimit, merchantDailyCalls: 100 };
  } };
  let submissions = 0, totalBroadcasts = 0, injectAcceptedTimeout = false;
  let crashSnapshot: Buffer | undefined;
  let timeoutHash: Hex | undefined;
  const mineDepth = async () => { await rpc('evm_mine'); await rpc('evm_mine'); };
  function transport() {
    const ports = new ViemX402WritePorts(viemChain);
    assert.equal(ports.writer, viemChain.writer);
    const prepare = ports.prepare.bind(ports), broadcast = ports.broadcast.bind(ports);
    ports.prepare = async (request, nonce) => {
      const result = await prepare(request, nonce);
      const signed = parseTransaction(result.raw);
      assert.equal(await recoverTransactionAddress({ serializedTransaction: result.raw as TransactionSerialized }), relayer.address);
      assert.equal(signed.nonce, nonce); assert.equal(signed.chainId, 1874);
      assert.equal(signed.to!.toLowerCase(), request.to.toLowerCase()); assert.equal(signed.data, request.data);
      assert.equal(signed.gas, request.gas); assert.equal(signed.gasPrice, gasPrice);
      assert.equal(signed.value ?? 0n, 0n);
      const budget = db.prepare('SELECT cost_wei FROM relayer_spend_reservations WHERE operation_id=(SELECT operation_id FROM relayer_operations WHERE nonce=? AND relayer=?)').get(nonce, relayer.address.toLowerCase()) as { cost_wei: string };
      assert.equal(BigInt(budget.cost_wei), signed.gas! * signed.gasPrice!);
      envelopes.push({ hash: result.hash, signer: relayer.address, nonce, chainId: signed.chainId, to: signed.to, dataHash: keccak256(signed.data!), gas: String(signed.gas), gasPrice: String(signed.gasPrice), maximumCostWei: budget.cost_wei });
      return result;
    };
    ports.broadcast = async raw => {
      totalBroadcasts++;
      const signed = parseTransaction(raw);
      const settlement = [EXACT, UPTO].some(a => a.toLowerCase() === signed.to?.toLowerCase());
      if (settlement) submissions++;
      const hash = await broadcast(raw); // Real eth_sendRawTransaction, existing ViemChain only.
      const actual = await pub.waitForTransactionReceipt({ hash });
      assert.equal(actual.transactionHash, keccak256(raw));
      assert(actual.gasUsed <= signed.gas!);
      assert.equal(actual.effectiveGasPrice, signed.gasPrice);
      assert(actual.gasUsed * actual.effectiveGasPrice <= signed.gas! * signed.gasPrice!);
      assert.equal(actual.from.toLowerCase(), relayer.address.toLowerCase());
      rawReceipts.push(actual);
      const row = viemChain.writer.rows().find(r => r.tx_hash === hash)!;
      assert.equal(row.phase, 'broadcasting');
      if (settlement && injectAcceptedTimeout) {
        injectAcceptedTimeout = false; timeoutHash = hash;
        // The actual transaction is accepted/mined, but neither broadcast completion nor receipt
        // has been persisted. This is the durable image a new process would see after a crash.
        crashSnapshot = db.serialize();
        throw new Error('synthetic transport timeout AFTER real Anvil acceptance');
      }
      if (settlement) await mineDepth(); // Actual successor blocks, not forged confirmation counts.
      return hash; // Reservations intentionally return BEFORE depth to exercise confirmation gating.
    };
    return ports;
  }
  let ports = transport();
  let coordinator = new X402WriteCoordinator({ db, writer: viemChain.writer, ports, sponsorship, maxSpendPerMinuteWei: 10n ** 18n, confirmations: 2n });
  let journal = new SqliteX402Journal(coordinator);
  let reservations = new SqliteAccountReservationAdapter(coordinator, 300_000n);
  let facilitator = new Permit2Facilitator({ publicClient: pub, journal, runtimeHashes, merchants: [merchant.address], maxAmount: 1_000_000n, maxGas: 500_000n });
  await facilitator.initialize();
  let lastRequest: { paymentPayload: PaymentPayload; paymentRequirements: PaymentRequirements };
  function createFacilitatorApp() {
    const app = new Hono();
    app.use('/settle', async (c, next) => { lastRequest = await c.req.raw.clone().json(); await next(); });
    app.route('/', x402Routes({ facilitator, authorize: async req => req.headers.get('authorization') === 'Bearer synthetic-local-only' }));
    return app;
  }
  let app = createFacilitatorApp();
  const facilitatorHttp = serve({ fetch: request => app.fetch(request), port: 0, hostname: '127.0.0.1' }); servers.push(facilitatorHttp);
  await new Promise<void>(r => facilitatorHttp.on('listening', r));
  const facUrl = `http://127.0.0.1:${(facilitatorHttp.address() as { port: number }).port}`;
  const facClient = new HTTPFacilitatorClient({ url: facUrl, createAuthHeaders: async () => ({ verify: { Authorization: 'Bearer synthetic-local-only' }, settle: { Authorization: 'Bearer synthetic-local-only' }, supported: {} }) });
  const resource = new x402ResourceServer(facClient).register(NETWORK, new ExactServer()).register(NETWORK, new UptoServer());
  const paid = new Hono();
  paid.use(paymentMiddleware({
    'GET /exact': { accepts: { scheme: 'exact', network: NETWORK, payTo: merchant.address, price: { asset: USDT, amount: '10000', extra: { assetTransferMethod: 'permit2' } }, maxTimeoutSeconds: 120 } },
    'GET /overcap': { accepts: { scheme: 'exact', network: NETWORK, payTo: merchant.address, price: { asset: USDT, amount: '10001', extra: { assetTransferMethod: 'permit2' } }, maxTimeoutSeconds: 120 } },
    'GET /upto': { accepts: { scheme: 'upto', network: NETWORK, payTo: merchant.address, price: { asset: USDT, amount: '10000', extra: { assetTransferMethod: 'permit2' } }, maxTimeoutSeconds: 120 } },
  }, resource));
  paid.get('/exact', c => c.json({ paid: true }));
  paid.get('/overcap', c => c.json({ paid: true }));
  paid.get('/upto', c => { setSettlementOverrides(c, { amount: '4000' }); return c.json({ paid: true, metered: 4000 }); });
  const resourceHttp = serve({ fetch: paid.fetch, port: 0, hostname: '127.0.0.1' }); servers.push(resourceHttp);
  await new Promise<void>(r => resourceHttp.on('listening', r));
  const paidUrl = `http://127.0.0.1:${(resourceHttp.address() as { port: number }).port}`;
  const signer = createX402AccountSigner(payer, pub, session, { async reserve(account, payment, signature) {
    await pub.simulateContract({ address: account, abi: agentAccountAbi, functionName: 'reserve', args: [payment, signature], account: relayer.address });
    const before = totalBroadcasts;
    try { await reservations.reserve(account, payment, signature); assert.fail('reservation returned before two successor blocks'); }
    catch (error) {
      assert(error instanceof ReservationPendingError && error.reason === 'settlement_pending', String(error));
      const row = db.prepare('SELECT state,receipt_json FROM x402_operations WHERE operation_key=?').get(error.operationId) as { state: string; receipt_json: string };
      assert.equal(row.state, 'pending');
      assert(row.receipt_json);
      await mineDepth(); await journal.reconcile();
      await reservations.reserve(account, payment, signature);
      assert.equal(totalBroadcasts, before + 1); // Same signature, confirmed reservation, no resend.
    }
  } });
  const client = x402Client.fromConfig({ schemes: [{ network: NETWORK, client: new ExactClient(signer) }, { network: NETWORK, client: new UptoClient(signer) }], spendControls: { allowedAssets: [{ network: NETWORK, asset: USDT, maxAmountPerPayment: '10000' }] } });
  const payingFetch = wrapFetchWithPayment(fetch, client);
  const merchantBefore = await pub.readContract({ address: USDT, abi: tokenAbi, functionName: 'balanceOf', args: [merchant.address] });
  await assert.rejects(payingFetch(`${paidUrl}/overcap`));
  assert.equal(totalBroadcasts, 0);
  check('unmodified official client spend-control refusal at 10001 before any reservation or settlement');
  for (let i = 0; i < 10; i++) {
    const res = await payingFetch(`${paidUrl}/exact`);
    const body = await res.text(); assert.equal(res.status, 200, body);
    const settlement = decodePaymentResponseHeader(res.headers.get('payment-response')!);
    assert(settlement.success); assert(settlement.transaction);
    const tx = await pub.getTransactionReceipt({ hash: settlement.transaction as Hex });
    const transferLogs = await pub.getContractEvents({ address: USDT, abi: tokenAbi, eventName: 'Transfer', fromBlock: tx.blockNumber, toBlock: tx.blockNumber });
    assert(transferLogs.some(l => l.transactionHash === tx.transactionHash && l.args.from?.toLowerCase() === payer.toLowerCase() && l.args.to?.toLowerCase() === merchant.address.toLowerCase() && l.args.value === 10_000n));
    transfers.push({ scheme: 'exact', amount: '10000', transaction: settlement.transaction, block: String(tx.blockNumber), localOnly: true });
  }
  assert.equal(await pub.readContract({ address: USDT, abi: tokenAbi, functionName: 'balanceOf', args: [merchant.address] }), merchantBefore + 100_000n);
  check('SQLite reservation confirmation depth proven on every signature, same writer and no resend');
  check('10 unmodified @x402/fetch + @x402/hono exact calls, official USDT Transfer logs and balance deltas');
  await assert.rejects(payingFetch(`${paidUrl}/exact`), /DailyCap|0x/i);
  assert.equal(submissions, 10);
  check('11th call refused by account daily cap before settlement');
  const previous = lastRequest!;
  const beforeReplay = submissions;
  const [retryA, retryB] = await Promise.all([facilitator.settle(previous.paymentPayload, previous.paymentRequirements), facilitator.settle(previous.paymentPayload, previous.paymentRequirements)]);
  assert(retryA.success && retryB.success); assert.equal(retryA.transaction, retryB.transaction); assert.equal(submissions, beforeReplay);
  const reverify = await facilitator.verify(previous.paymentPayload, previous.paymentRequirements); assert(!reverify.isValid);
  const tx = await pub.getTransaction({ hash: retryA.transaction as Hex });
  await assert.rejects(pub.call({ account: relayer.address, to: tx.to!, data: tx.input }));
  check('concurrent duplicate settle returns original receipt; direct proxy replay fails on consumed Permit2 nonce');
  const tampered = structuredClone(previous.paymentPayload);
  (tampered.payload as any).permit2Authorization.witness.to = relayer.address;
  assert(!(await facilitator.verify(tampered, previous.paymentRequirements)).isValid);
  check('signed recipient tampering refused');
  // Owner can raise policy; counters from prior sessions are retained. Upto reserves 10000 but transfers 4000.
  await receipt(await wallet.writeContract({ address: payer, abi: art.abi, functionName: 'configureSession', args: [session.address, 10_000n, 200_000n, BigInt(now + 3600), [merchant.address]], gas: 500_000n }));
  const uptoResponse = await payingFetch(`${paidUrl}/upto`);
  assert.equal(uptoResponse.status, 200, await uptoResponse.text());
  const uptoSettlement = decodePaymentResponseHeader(uptoResponse.headers.get('payment-response')!);
  assert(uptoSettlement.success);
  assert.equal(await pub.readContract({ address: USDT, abi: tokenAbi, functionName: 'balanceOf', args: [merchant.address] }), merchantBefore + 104_000n);
  transfers.push({ scheme: 'upto', ceiling: '10000', amount: '4000', transaction: uptoSettlement.transaction, localOnly: true });
  const uptoReceipt = await pub.getTransactionReceipt({ hash: uptoSettlement.transaction as Hex });
  const uptoLogs = await pub.getContractEvents({ address: USDT, abi: tokenAbi, eventName: 'Transfer', fromBlock: uptoReceipt.blockNumber, toBlock: uptoReceipt.blockNumber });
  assert(uptoLogs.some(l => l.transactionHash === uptoReceipt.transactionHash && l.args.from?.toLowerCase() === payer.toLowerCase() && l.args.to?.toLowerCase() === merchant.address.toLowerCase() && l.args.value === 4_000n));
  const excess = await facilitator.verify(lastRequest!.paymentPayload, { ...lastRequest!.paymentRequirements, amount: '10001' });
  assert(!excess.isValid && excess.invalidReason?.includes('amount_mismatch'));
  const uptoTx = await pub.getTransaction({ hash: uptoSettlement.transaction as Hex });
  const uptoAbi = JSON.parse(readFileSync(`${root}/contracts/x402-reference/out/x402UptoPermit2Proxy.sol/x402UptoPermit2Proxy.json`, 'utf8')).abi;
  const decodedUpto = decodeFunctionData({ abi: uptoAbi, data: uptoTx.input });
  const uptoArgs = [...decodedUpto.args!];
  await assert.rejects(pub.simulateContract({ account: merchant.address, address: UPTO, abi: uptoAbi, functionName: 'settle', args: uptoArgs }), /UnauthorizedFacilitator/);
  uptoArgs[1] = 10_001n;
  await assert.rejects(pub.simulateContract({ account: relayer.address, address: UPTO, abi: uptoAbi, functionName: 'settle', args: uptoArgs }), /AmountExceedsPermitted/);
  check('upto USDT Transfer event, over-ceiling refusal and unauthorized facilitator refusal');
  const day = (await pub.getBlock()).timestamp / 86400n;
  assert.equal(await pub.readContract({ address: payer, abi: art.abi, functionName: 'reservedPerDay', args: [day] }), 110_000n);
  check('upto transfers actual 4000 of 10000 authorized, consumes full ceiling in account daily budget');
  const beforeBudgetRefusal = totalBroadcasts;
  const budgetPayment = { ...reservation, to: merchant.address, nonce: 123456n };
  const budgetSignature = await signReservation(budgetPayment);
  coordinator.config.maxSpendPerMinuteWei = 1n;
  await assert.rejects(reservations.reserve(payer, budgetPayment, budgetSignature), /circuit_budget/);
  coordinator.config.maxSpendPerMinuteWei = 10n ** 18n;
  syntheticDailyLimit = 1n;
  budgetPayment.nonce++;
  await assert.rejects(reservations.reserve(payer, budgetPayment, await signReservation(budgetPayment)), /merchant_daily_sponsorship_cap/);
  syntheticDailyLimit = 10n ** 18n;
  assert.equal(totalBroadcasts, beforeBudgetRefusal);
  check('real SQLite shared per-minute and merchant daily gas reservations refuse before signing/broadcast');

  // A fresh official client payment, real transfer, then transport ambiguity and process restart.
  injectAcceptedTimeout = true;
  const ambiguous = await payingFetch(`${paidUrl}/exact`);
  assert.equal(ambiguous.status, 402, await ambiguous.text());
  assert(timeoutHash && crashSnapshot);
  const acceptedRequest = lastRequest!;
  const beforeRestart = totalBroadcasts;
  assert.equal(viemChain.writer.rows().find(r => r.tx_hash === timeoutHash)!.phase, 'uncertain');
  assert.equal((await pub.getTransactionReceipt({ hash: timeoutHash })).status, 'success');
  const balancesAfterAccepted = await pub.readContract({ address: USDT, abi: tokenAbi, functionName: 'balanceOf', args: [merchant.address] });
  assert.equal(balancesAfterAccepted, merchantBefore + 114_000n);
  db.close(); writeFileSync(databasePath, crashSnapshot);
  db = openDb(databasePath);
  viemChain = new ViemChain(url, relayerKey, addresses); // Simulated new process, same configured signer.
  ports = transport();
  coordinator = new X402WriteCoordinator({ db, writer: viemChain.writer, ports, sponsorship, maxSpendPerMinuteWei: 10n ** 18n, confirmations: 2n });
  journal = new SqliteX402Journal(coordinator);
  reservations = new SqliteAccountReservationAdapter(coordinator, 300_000n);
  facilitator = new Permit2Facilitator({ publicClient: pub, journal, runtimeHashes, merchants: [merchant.address], maxAmount: 1_000_000n, maxGas: 500_000n });
  await facilitator.initialize();
  app = createFacilitatorApp(); // Replace the HTTP service's dependencies as a restarted process would.
  assert.equal(viemChain.writer.rows().find(r => r.tx_hash === timeoutHash)!.phase, 'broadcasting');
  const beforeDepth = await facilitator.settle(acceptedRequest.paymentPayload, acceptedRequest.paymentRequirements);
  assert.equal(beforeDepth.success, false); assert.equal(beforeDepth.transaction, timeoutHash);
  await assert.rejects(viemChain.writer.run(async () => assert.fail('uncertain nonce hold must block unrelated writes')), /uncertain|pending|unresolved/i);
  await mineDepth(); await journal.reconcile();
  const recovered = await Promise.all([facilitator.settle(acceptedRequest.paymentPayload, acceptedRequest.paymentRequirements), facilitator.settle(acceptedRequest.paymentPayload, acceptedRequest.paymentRequirements)]);
  assert(recovered.every(r => r.success && r.transaction === timeoutHash));
  const recoveredHttp = await fetch(`${facUrl}/settle`, { method: 'POST', headers: { authorization: 'Bearer synthetic-local-only', 'content-type': 'application/json' }, body: JSON.stringify(acceptedRequest) });
  assert.equal(recoveredHttp.status, 200);
  assert.deepEqual(await recoveredHttp.json(), recovered[0]);
  assert.equal(totalBroadcasts, beforeRestart);
  assert.equal(viemChain.writer.rows().find(r => r.tx_hash === timeoutHash)!.phase, 'confirmed');
  assert.equal(await pub.readContract({ address: USDT, abi: tokenAbi, functionName: 'balanceOf', args: [merchant.address] }), balancesAfterAccepted);
  transfers.push({ scheme: 'exact', amount: '10000', transaction: timeoutHash, acceptedTimeoutRestart: true, localOnly: true });
  check('accepted-but-timeout real USDT transfer; broadcasting crash image reopened, depth held, concurrent retry recovers without resend');
  const writerRows = viemChain.writer.rows();
  assert.equal(writerRows.length, 24); assert(writerRows.every(r => r.phase === 'confirmed'));
  assert.deepEqual(writerRows.map(r => r.nonce).sort((a, b) => a! - b!), Array.from({ length: 24 }, (_, i) => i));
  const schemas = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name LIKE '%operations'").all();
  assert(!JSON.stringify(schemas).includes('raw_transaction'));
  check('24 contiguous relayer nonces: 12 reservations and 12 settlements through one AccountWriter; durable cost reservations retained across restart');
  await receipt(await wallet.writeContract({ address: payer, abi: art.abi, functionName: 'revokeSession', gas: 100_000n }));
  await assert.rejects(payingFetch(`${paidUrl}/exact`));
  assert.equal(await pub.getBalance({ address: payer }), 0n);
  check('revoked session refused; payer still has zero native gas');
  const evidence = { localOnly: true, generatedAt: new Date().toISOString(), sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sourceTreeDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0, testedSourceHashes: Object.fromEntries(['api/scripts/x402/fork-journal.ts', 'apps/api/src/chain.ts', 'apps/api/src/x402/viem-write-ports.ts', 'apps/api/src/x402/write-coordinator.ts', 'contracts/src/X402AgentAccount.sol'].map(path => [path, keccak256(toHex(readFileSync(`${root}/${path}`)))])), forkBlock, forkBlockHash: (await pub.getBlock({ blockNumber: BigInt(forkBlock) })).hash, remoteRpc, sponsorshipPolicy: policyId, reimbursement: 'NONE: synthetic local relayer funds only', confirmations: 'two successor blocks', envelopes, rawReceipts, writerRows, rootArtifact: { name: 'X402AgentAccount', creationBytecodeHash: keccak256(art.bytecode.object) }, versions: { core: '2.29.0', evm: '2.29.0', fetch: '2.29.0', hono: '2.29.0' }, runtimeHashes, payer, merchant: merchant.address, relayer: relayer.address, checks, transfers, productionActivation: 'INACTIVE: funded M7 gateway, reviewed routing/witness and reimbursement integration, canonical upto deployment, root runtime integration required' };
  writeFileSync(`${root}/docs/x402/fork-journal-evidence.json`, JSON.stringify(JSON.parse(canonicalJson(evidence)), null, 2) + '\n');
  console.log(`Evidence saved: ${root}/docs/x402/fork-journal-evidence.json`);
} finally {
  for (const server of servers) { if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
  anvil.kill('SIGTERM');
  if (db.open) db.close();
  rmSync(temp, { recursive: true, force: true });
}
