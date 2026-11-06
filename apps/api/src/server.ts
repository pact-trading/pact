import { Identities, PrivyIdentity, identityConfig } from './identity.js';
import { WalletIdentity } from './wallet-identity.js';
import { LocalFaucet } from './local-faucet.js';
import { createPublicClient, defineChain, http as rpcTransport } from 'viem';
import { createLiveX402, type LiveX402 } from './x402/live.js';
import { AgentService } from './agents.js';
import { startOwnedRelayer } from './runtime-ownership.js';
import { ApprovalService, approvalConfig } from './approval.js';
import { startBackgroundJobs } from './background.js';
import { serve } from '@hono/node-server';
import { openDb, seedMerchant } from './db.js';
import { FakeChain, ViemChain, type Addresses } from './chain.js';
import { ViemFinancingChain } from './financing/chain.js';
import { FinancingService } from './financing/service.js';
import { Relayer, allowedTargets } from './relayer.js';
import { createApp } from './app.js';
import { Indexer } from './indexer.js';
import { runKeeper } from './keeper.js';
import { KeeperRenewals } from './subscriptions-live.js';
import { SponsorshipBudget, sponsorshipLimits } from './sponsorship.js';
import { Treasury, treasuryConfig } from './treasury.js';
import { deliverWebhooks } from './webhooks.js';
import { deliverNotifications, mailSender } from './notifications.js';
import { deliverTelegram, pollTelegram, telegramClient, telegramConfig } from './telegram.js';
import type { Address, Hex } from 'viem';

const addresses: Addresses = {
  router: process.env.ROUTER_ADDRESS as Address,
  escrow: process.env.ESCROW_ADDRESS as Address,
  subscription: process.env.SUBSCRIPTION_ADDRESS as Address,
  fees: process.env.FEE_SCHEDULE_ADDRESS as Address,
};
// Invoice financing is optional: the receivables contract and investor registry deployed beside the suite.
const financingAddresses = process.env.RECEIVABLES_ADDRESS && process.env.INVESTOR_REGISTRY_ADDRESS
  ? { receivables: process.env.RECEIVABLES_ADDRESS as Address, registry: process.env.INVESTOR_REGISTRY_ADDRESS as Address }
  : undefined;
if (financingAddresses) addresses.receivables = financingAddresses.receivables;
const live = process.env.CHAIN_ADAPTER === 'viem';
if (live && (!process.env.RPC_URL || !process.env.RELAYER_PRIVATE_KEY || Object.values(addresses).some(x => !x))) throw new Error('Viem adapter requires RPC_URL, RELAYER_PRIVATE_KEY and ROUTER_ADDRESS, ESCROW_ADDRESS, SUBSCRIPTION_ADDRESS, FEE_SCHEDULE_ADDRESS');
const privyConfig = identityConfig(process.env);
const chain = live ? new ViemChain(process.env.RPC_URL!, process.env.RELAYER_PRIVATE_KEY as Hex, addresses) : new FakeChain(true);
// Constructing the adapter performs no network writes. Acquire by its actual
// signing identity before opening/migrating the runtime DB, binding the writer,
// exposing HTTP, or starting any background job (including crash recovery).
await startOwnedRelayer({ chainId: chain.writer.chainId, relayer: chain.writer.relayer }, async () => {
  const db = openDb(process.env.DATABASE_PATH ?? './settle.sqlite');
  if (process.env.BOOTSTRAP_MERCHANT_ADDRESS && !db.prepare('SELECT 1 FROM merchants LIMIT 1').get()) {
    const keys = seedMerchant(db, process.env.BOOTSTRAP_MERCHANT_ADDRESS);
    console.info('Bootstrap keys (shown once):', keys);
  }
  const relayer = new Relayer(chain, addresses.router ?? '0x0000000000000000000000000000000000000001', allowedTargets({ escrow: addresses.escrow ?? '0x0000000000000000000000000000000000000002', subscription: addresses.subscription ?? '0x0000000000000000000000000000000000000003', receivables: live ? financingAddresses?.receivables : undefined }), { minAmount: BigInt(process.env.RELAYER_MIN_AMOUNT_MINOR ?? '1000000'), maxGas: 1_000_000n, maxGasPrice: 100_000_000_000n,
    // Global ceiling for the one relayer, and a lower one per merchant so testers do not block each other.
    maxSpendPerMinute: BigInt(process.env.RELAYER_MAX_SPEND_PER_MINUTE_WEI ?? '10000000000000000'),
    maxSpendPerMerchantPerMinute: BigInt(process.env.RELAYER_MAX_SPEND_PER_MERCHANT_PER_MINUTE_WEI ?? process.env.RELAYER_MAX_SPEND_PER_MINUTE_WEI ?? '10000000000000000') });
  const approval = new ApprovalService(db, chain, approvalConfig(process.env, addresses.escrow ?? '0x0000000000000000000000000000000000000002', relayer.minimumAmount));
  // The gas Pact absorbs on calls that move no money to a merchant, per merchant per day.
  const sponsorship = new SponsorshipBudget(db, sponsorshipLimits(process.env));
  // Merchants sign in with a wallet (EIP-4361); customers with Privy email or, on a local fork, a test wallet.
  const verifier = live ? createPublicClient({ transport: rpcTransport(process.env.RPC_URL!, { retryCount: 0, timeout: 10_000 }) }) : undefined;
  const wallet = new WalletIdentity(db, {
    origin: process.env.PACT_WEB_ORIGIN ?? process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000',
    allowLocalEmail: process.env.PACT_LOCAL_FORK === '1',
    verify: verifier ? (address, message, signature) => verifier.verifyMessage({ address, message, signature }) : undefined,
  });
  const identity = new Identities(privyConfig ? new PrivyIdentity(db, privyConfig) : undefined, wallet);
  const faucet = live && process.env.PACT_LOCAL_FORK === '1' ? new LocalFaucet(process.env.RPC_URL!) : undefined;
  // The keeper key pulls renewals itself (the contract allows it); each renewal's fee covers its gas.
  // x402 in live mode: our facilitator, each merchant's paid API, and customer-owned agent accounts.
  let x402Live: LiveX402 | undefined, agents: AgentService | undefined;
  if (live && process.env.X402_FACTORY_ADDRESS && process.env.X402_RUNTIME_HASHES) {
    const pub = createPublicClient({ chain: defineChain({ id: 1874, name: 'Whitechain Sepolia', nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 }, rpcUrls: { default: { http: [process.env.RPC_URL!] } } }), transport: rpcTransport(process.env.RPC_URL!, { retryCount: 0, timeout: 10_000 }), pollingInterval: 500 });
    x402Live = await createLiveX402(db, chain as ViemChain, pub as never, JSON.parse(process.env.X402_RUNTIME_HASHES), {
      merchantDailyLimitWei: process.env.X402_MERCHANT_DAILY_LIMIT_WEI ? BigInt(process.env.X402_MERCHANT_DAILY_LIMIT_WEI) : undefined,
    });
    agents = new AgentService(db, chain as ViemChain, pub as never, process.env.X402_FACTORY_ADDRESS as Address, x402Live, `http://127.0.0.1:${process.env.PORT ?? 3001}`);
  }
  const renewals = new KeeperRenewals(db, chain);
  // Live mode: keep the FeeSchedule's WBT price near the pool's and the relayer in gas from its fees.
  const treasury = live && process.env.TREASURY_ENABLED !== 'false' ? new Treasury(chain as ViemChain, process.env.RPC_URL!, addresses.fees, treasuryConfig(process.env)) : undefined;
  const telegram = telegramConfig();
  const confirmations = BigInt(process.env.CONFIRMATIONS ?? '2');
  const financing = live && financingAddresses
    ? new FinancingService(db, new ViemFinancingChain(process.env.RPC_URL!, financingAddresses, chain as ViemChain), {
      baseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000', escrow: addresses.escrow,
      startBlock: BigInt(process.env.FINANCING_DEPLOYMENT_BLOCK ?? process.env.DEPLOYMENT_BLOCK ?? '0'), confirmations,
    })
    : undefined;
  const registryOwner = faucet && process.env.INVESTOR_REGISTRY_OWNER ? process.env.INVESTOR_REGISTRY_OWNER as Address : undefined;
  const app = createApp({ telegram, renewals, identity, wallet, faucet, agents, x402Live, db, chain, relayer, approval, sponsorship, financing, registryOwner, baseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000', router: addresses.router, escrow: addresses.escrow, subscription: addresses.subscription, fees: addresses.fees });
  const http = serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3001), hostname: process.env.HOST });
  console.info(`Settle API listening on ${process.env.PORT ?? 3001}`);
  const indexer = new Indexer(db, chain, BigInt(process.env.DEPLOYMENT_BLOCK ?? '0'), confirmations);
  const mail = mailSender();
  const telegramCall = telegram && telegramClient(telegram.token);
  const stopJobs = startBackgroundJobs([
    { name: 'approval', intervalMs: 1000, run: () => approval.reconcile() },
    { name: 'indexer', intervalMs: 1000, run: () => indexer.poll() },
    { name: 'keeper', intervalMs: 15_000, run: () => runKeeper(db, chain, new Date(), renewals) },
    { name: 'webhooks', intervalMs: 1000, run: () => deliverWebhooks(db) },
    { name: 'notifications', intervalMs: 5000, run: () => deliverNotifications(db, mail) },
    ...(treasury ? [{ name: 'treasury', intervalMs: 60_000, run: () => treasury.run() }] : []),
    ...(telegramCall ? [
      { name: 'telegram-updates', intervalMs: 3000, run: () => pollTelegram(db, telegramCall) },
      { name: 'telegram-delivery', intervalMs: 3000, run: () => deliverTelegram(db, telegramCall) },
    ] : []),
    ...(x402Live ? [{ name: 'x402', intervalMs: 1000, run: () => x402Live!.journal.reconcile() }] : []),
    ...(financing ? [
      { name: 'financing-indexer', intervalMs: 2000, run: () => financing.poll() },
      // Record dates and defaults: Pact's keeper sends the calls anyone may make.
      { name: 'financing-keeper', intervalMs: 15_000, run: () => financing.keep() },
    ] : []),
  ], (name, error) => console.error(`Background ${name} failed:`, error));

  // Do not release ownership on signal, HTTP close, or timer cancellation. Existing
  // requests/RPCs can still be writing. The kernel lock lasts until process exit.
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    stopJobs();
    http.close();
    // Active I/O drains naturally. A hung operation is recovered from its durable
    // journal after termination; never release the lock while it may still run.
    setTimeout(() => { console.error('Relayer shutdown timed out'); process.exit(1); }, 10_000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
});
