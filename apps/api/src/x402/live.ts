import type { Hono } from 'hono';
import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
import type { FacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme as ExactServer } from '@x402/evm/exact/server';
import type { Address, Hex, PublicClient } from 'viem';
import type { Db } from '../db.js';
import type { ViemChain } from '../chain.js';
import { Permit2Facilitator } from './facilitator.js';
import { X402WriteCoordinator } from './write-coordinator.js';
import { SqliteX402Journal } from './sqlite-journal.js';
import { SqliteAccountReservationAdapter } from './sqlite-reservations.js';
import { ViemX402WritePorts } from './viem-write-ports.js';
import type { MerchantSponsorshipPolicy } from './write-ports.js';
import { NETWORK, USDT } from './constants.js';
import type { X402Service } from './routes.js';

/** The paid API each merchant offers agents in live mode: an invoice risk score at $0.01 a call. */
export const PAID_ENDPOINT = { path: 'risk-score', priceMinor: '10000', scheme: 'exact' as const, description: 'Invoice risk score used by investors and agents' };
export const paidPath = (merchantId: string) => `/x402/merchants/${merchantId}/${PAID_ENDPOINT.path}`;

/**
 * Wires the existing x402 pieces for live mode: our facilitator settles real USDT through Permit2 on
 * the shared relayer journal, reservations go through the same writer, and every registered merchant
 * gets a paid endpoint behind the official @x402/hono middleware. The relayer pays settlement gas
 * (no merchant-tank reimbursement for x402 yet), within a per-merchant daily budget. The budget counts
 * each call at its worst case (reservation and settlement gas at twice the gas price, about 0.008 WBT at
 * Whitechain's 5 gwei); actual spend is around a tenth of that.
 */
export async function createLiveX402(db: Db, chain: ViemChain, publicClient: PublicClient, runtimeHashes: Record<string, Hex>, { merchantDailyLimitWei = 50_000_000_000_000_000n }: { merchantDailyLimitWei?: bigint } = {}) {
  const merchants: Address[] = [];
  const refreshMerchants = () => {
    const rows = db.prepare('SELECT address FROM merchants').all() as Array<{ address: Address }>;
    merchants.splice(0, merchants.length, ...rows.map(r => r.address), ...(rows.length ? [] : ['0x000000000000000000000000000000000000dEaD' as Address]));
  };
  refreshMerchants();
  const sponsorship: MerchantSponsorshipPolicy = {
    async authorize(request) {
      refreshMerchants();
      if (!merchants.some(m => m.toLowerCase() === request.merchant.toLowerCase())) throw new Error('merchant_not_registered');
      const price = await chain.gasPrice();
      const maxFeePerGas = price * 2n > 100_000_000_000n ? 100_000_000_000n : price * 2n;
      return { policyId: 'live-relayer-paid', maxFeePerGas, merchantDailyLimitWei, merchantDailyCalls: 500 };
    },
  };
  const coordinator = new X402WriteCoordinator({ db, writer: chain.writer, ports: new ViemX402WritePorts(chain), sponsorship, maxSpendPerMinuteWei: 100_000_000_000_000_000n, confirmations: 1n });
  const journal = new SqliteX402Journal(coordinator);
  const reservations = new SqliteAccountReservationAdapter(coordinator, 300_000n);
  const facilitator = new Permit2Facilitator({ publicClient, journal, runtimeHashes, merchants, maxAmount: 1_000_000n, maxGas: 500_000n });
  await facilitator.initialize();

  // Our resource server talks to the facilitator in process; external callers still need a merchant key.
  const local: FacilitatorClient = {
    verify: (payload, requirements) => { refreshMerchants(); return facilitator.verify(payload as never, requirements as never) as never; },
    // With 1-second blocks the first answer is usually "pending"; wait for confirmation, so the paid
    // response carries the settled transaction. The journal returns the stored result on each retry.
    settle: async (payload, requirements) => {
      refreshMerchants();
      for (let i = 0; ; i++) {
        const result = await facilitator.settle(payload as never, requirements as never);
        if (result.success || !/pending/.test(String(result.errorReason)) || i >= 60) return result as never;
        await new Promise(r => setTimeout(r, 500));
        await journal.reconcile();
      }
    },
    getSupported: async () => facilitator.getSupported() as never,
  };
  const resource = new x402ResourceServer(local).register(NETWORK, new ExactServer());
  await resource.initialize();
  const middlewares = new Map<string, ReturnType<typeof paymentMiddleware>>();
  const mountPaidApi = (app: Hono) => {
    app.get('/x402/merchants/:merchantId/risk-score', async (c, next) => {
      const merchantId = c.req.param('merchantId');
      const merchant = db.prepare('SELECT address FROM merchants WHERE id=?').get(merchantId) as { address: Address } | undefined;
      if (!merchant) return c.json({ error: 'merchant_not_found' }, 404);
      let middleware = middlewares.get(merchantId);
      if (!middleware) {
        middleware = paymentMiddleware({
          [`GET ${paidPath(merchantId)}`]: { accepts: { scheme: 'exact', network: NETWORK, payTo: merchant.address, price: { asset: USDT, amount: PAID_ENDPOINT.priceMinor, extra: { assetTransferMethod: 'permit2' } }, maxTimeoutSeconds: 120 }, description: PAID_ENDPOINT.description },
        }, resource, undefined, undefined, false);
        middlewares.set(merchantId, middleware);
      }
      return middleware(c, next);
    }, c => {
      // The paid response: a deterministic illustrative score, so repeated calls are comparable.
      const invoice = c.req.query('invoice') ?? 'demo';
      let hash = 0; for (const ch of invoice) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
      return c.json({ invoice, riskScore: 20 + (hash % 60), model: 'illustrative', paid: true });
    });
  };
  const service: X402Service = {
    facilitator,
    // External resource servers must use a merchant secret whose address is the payTo.
    async authorize(request, payTo) {
      const key = request.headers.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
      if (!key) return false;
      const { keyHash } = await import('../db.js');
      const row = db.prepare("SELECT m.address FROM api_keys k JOIN merchants m ON m.id=k.merchant_id WHERE k.hash=? AND k.kind='secret' AND k.revoked_at IS NULL").get(keyHash(key)) as { address: string } | undefined;
      return !!row && row.address.toLowerCase() === payTo.toLowerCase();
    },
  };
  return { facilitator, journal, reservations, service, mountPaidApi, refreshMerchants };
}
export type LiveX402 = Awaited<ReturnType<typeof createLiveX402>>;
