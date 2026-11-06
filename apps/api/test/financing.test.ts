import { describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionData, hexToString, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { openDb, seedMerchant, now } from '../src/db.js';
import { FakeChain, escrowAbi } from '../src/chain.js';
import { Relayer, allowedTargets } from '../src/relayer.js';
import { createApp } from '../src/app.js';
import { ApprovalService } from '../src/approval.js';
import { IdentityError, type PrivyIdentity } from '../src/identity.js';
import { intentTypedData } from '../src/typed-data.js';
import { receivablesAbi } from '../src/financing/chain.js';
import { FinancingService } from '../src/financing/service.js';
import { paymentGas } from '../src/financing/terms.js';
import { invoiceRef } from '../src/financing/store.js';
import { FakeFinancingChain, RECEIVABLES, REGISTRY } from './helpers/fake-financing.js';

const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const router = '0x0000000000000000000000000000000000000001' as Address;
const escrow = '0x0000000000000000000000000000000000000002' as Address;
const subscription = '0x0000000000000000000000000000000000000003' as Address;
const merchantAccount = privateKeyToAccount(hash(11)), merchant = merchantAccount.address;
const payer = privateKeyToAccount(hash(22));
const wallets = { payer: payer.address, alice: privateKeyToAccount(hash(33)).address, bob: privateKeyToAccount(hash(44)).address, officer: privateKeyToAccount(hash(55)).address } as const;
const USDT = 1_000_000n;
const json = (value: unknown) => JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));

function fixture() {
  const db = openDb(), chain = new FakeChain(true), fin = new FakeFinancingChain();
  const keys = seedMerchant(db, merchant);
  const identity = {
    handles: () => false,
    async authenticate(token: string) {
      const address = wallets[token as keyof typeof wallets];
      if (!address) throw new IdentityError('invalid_identity_token', 401);
      return { userId: `wallet:${token}`, sessionId: token, expiresAt: Math.floor(Date.now() / 1000) + 300, email: token === 'payer' ? 'client@acme.test' : null, wallet: { address, id: null }, kind: 'wallet' };
    },
    async merchantFor() { throw new IdentityError('merchant_not_registered', 403); },
  } as unknown as PrivyIdentity;
  chain.approval.state.balance = 5_000n * USDT;
  chain.approval.state.allowance = 5_000n * USDT;
  const approval = new ApprovalService(db, chain, { enabled: true, escrow, minimumAmount: USDT });
  const financing = new FinancingService(db, fin, { baseUrl: 'http://localhost:3000', escrow, clockCacheMs: 0, confirmations: 0n });
  const app = createApp({ db, chain, identity, approval, financing, relayer: new Relayer(chain, router, allowedTargets({ escrow: escrow, subscription: subscription, receivables: RECEIVABLES })), router, escrow, subscription });
  const call = async (path: string, token: string, body?: unknown) => {
    const r = await app.request(path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body !== undefined ? { body: json(body) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  const ok = async (path: string, token: string, body?: unknown) => {
    const r = await call(path, token, body);
    if (r.status !== 200 && r.status !== 201) throw new Error(`${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  /** An invoice the customer has acknowledged, due in `days` days. */
  const invoice = async (amount = '1000', days = 30) => {
    const created = await ok('/v1/invoices?expand=detail', keys.secretKey, { customerEmail: 'client@acme.test', customerName: 'Acme Ltd', dueAt: new Date(Date.now() + days * 86_400_000 + 3_600_000).toISOString(), lines: [{ description: 'Audit', quantity: 1, unitAmount: amount }] });
    db.prepare('INSERT INTO invoice_acknowledgements VALUES (?,?,?,?,?)').run(created.id, payer.address.toLowerCase(), '0x', keccak256(stringToHex(`ack:${created.id}`)), now());
    db.prepare("UPDATE invoices SET status='acknowledged' WHERE id=?").run(created.id);
    return created as { id: string; amount: string; dueAt: string };
  };
  /** The merchant signs the listing and Pact relays it: the contract's Listed event, then the API applies it. */
  const discounts = new Map<string, number>(), sold = new Map<string, bigint>();
  let nextClaim = 0n;
  type ListOrder = { merchant: Address; invoiceId: string; debtor: Address; face: bigint; maturity: bigint; discountBps: number; deadline: bigint };
  const list = async (invoiceId: string, claimId: bigint) => {
    const prepared = await ok(`/v1/financing/invoices/${invoiceId}/list`, keys.secretKey, {});
    nextClaim = claimId;
    const view = await ok(`/v1/financing/invoices/${invoiceId}/list/relay`, keys.secretKey, { order: prepared.order, signatures: [sig] });
    const call = fin.relayed.at(-1)!;
    const order = call.args[0] as ListOrder;
    return { view, prepared, call, maturity: Number(order.maturity), discountBps: order.discountBps };
  };
  // What the contracts do with a relayed signed order (the fake does not run them): list, approve in
  // the registry, sell units. Tests override this for other outcomes.
  const relays = ({ contract, functionName, args }: { contract: string; functionName: string; args: readonly unknown[] }) => {
    if (contract === 'usdt' && functionName === 'permit') return [];
    if (functionName === 'listWithSig') {
      const o = args[0] as ListOrder;
      const ref = keccak256(stringToHex(o.invoiceId));
      const ack = (db.prepare('SELECT typed_hash FROM invoice_acknowledgements WHERE invoice_id=?').get(o.invoiceId) as { typed_hash: Hex }).typed_hash;
      fin.active.set(`${merchant.toLowerCase()}:${ref.toLowerCase()}`, nextClaim);
      fin.claims.set(nextClaim.toString(), { merchant, maturity: o.maturity, status: 'listed', face: o.face, sold: 0n, collected: 0n, reserve: 0n });
      discounts.set(nextClaim.toString(), o.discountBps);
      return [{ name: 'Listed', args: { claimId: nextClaim, merchant, invoiceRef: ref, face: o.face, maturity: o.maturity, discountBps: o.discountBps, ackHash: ack, debtor: o.debtor } }];
    }
    if (functionName === 'decideWithSig') {
      const d = args[0] as { officer: Address; investor: Address; approve: boolean; expiresAt: bigint; region: Hex };
      if (!fin.officers.has(d.officer.toLowerCase())) return 'NotOfficer';
      if (!d.approve) { fin.approved.delete(d.investor.toLowerCase()); return [{ contract: 'registry' as const, name: 'InvestorRevoked', args: { investor: d.investor, officer: d.officer } }]; }
      fin.approved.add(d.investor.toLowerCase());
      return [{ contract: 'registry' as const, name: 'InvestorApproved', args: { investor: d.investor, expiresAt: d.expiresAt, region: d.region, officer: d.officer } }];
    }
    if (functionName === 'buyWithSig') {
      const o = args[0] as { claimId: bigint; investor: Address; units: bigint };
      if (!fin.approved.has(o.investor.toLowerCase())) return 'NotApproved';
      const id = o.claimId.toString(), units = o.units;
      const price = units - (units * BigInt(discounts.get(id)!)) / 10_000n, fee = units / 200n, reserve = units / 10n;
      sold.set(id, (sold.get(id) ?? 0n) + units);
      const closes = sold.get(id) === fin.claims.get(id)!.face;
      return [
        { name: 'Purchased', args: { claimId: o.claimId, investor: o.investor, units, price, fee, reserve, upfront: price - fee - reserve } },
        ...(closes ? [{ name: 'ListingClosed', args: { claimId: o.claimId, sold: sold.get(id) } }] : []),
      ];
    }
    return 'reverted';
  };
  fin.onRelay = relays;
  const sig = `0x${'ab'.repeat(64)}1b`;
  /** An investor applies and a compliance officer approves them: the officer signs, Pact relays. */
  const approve = async (who: 'alice' | 'bob', organization: string) => {
    await ok('/v1/investor/me/application', who, { name: `${organization} desk`, organization, email: `${who}@fund.test`, region: 'GB' });
    const prepared = await ok(`/v1/compliance/investors/${wallets[who]}`, 'officer', { decision: 'approve' });
    return ok(`/v1/compliance/investors/${wallets[who]}/relay`, 'officer', { order: prepared.order, signatures: [sig] });
  };
  /** An investor buys `units`: it signs the order (and a USDT permit), Pact relays it. */
  const buy = async (who: 'alice' | 'bob', invoiceId: string, _claimId: bigint, units: bigint, _discountBps: number, _closes = false) => {
    fin.balances.set(wallets[who].toLowerCase(), 10_000n * USDT);
    const prepared = await ok(`/v1/investor/listings/${invoiceId}/purchase`, who, { faceMinor: units.toString() });
    return { prepared, view: await ok(`/v1/investor/listings/${invoiceId}/purchase/relay`, who, { order: prepared.order, signatures: prepared.typedData.map(() => sig) }) };
  };
  return { db, chain, fin, financing, keys, call, ok, invoice, list, approve, buy, sig };
}

describe('invoice financing API', () => {
  it('lists an acknowledged invoice, refuses unapproved investors, sells it and routes the customer payment to the contract', async () => {
    const f = fixture();
    f.fin.officers.add(wallets.officer.toLowerCase());
    const inv = await f.invoice();
    const overview = await f.ok('/v1/financing', f.keys.secretKey);
    expect(overview.invoices).toHaveLength(1);
    expect(overview.invoices[0]).toMatchObject({ status: 'eligible', terms: { faceMinor: '1000000000', discountBps: 300, priceMinor: '970000000', upfrontMinor: '865000000' } });

    const { view: listed, prepared, call, discountBps } = await f.list(inv.id, 1n);
    // The merchant only signs: Pact relays the listing, so the merchant needs no WBT.
    expect(prepared.typedData[0]).toMatchObject({ primaryType: 'List', domain: { name: 'Pact Receivables', verifyingContract: RECEIVABLES }, message: { merchant: merchant.toLowerCase(), invoiceId: inv.id, nonce: '0' } });
    expect(prepared.lines).toContainEqual({ label: 'Gas', value: 'Paid by Pact: you only sign' });
    expect(call).toMatchObject({ contract: 'receivables', functionName: 'listWithSig' });
    // The contract gets the invoice id, the debtor and the customer's signature, and checks them itself.
    const order = call.args[0] as { invoiceId: string; debtor: Address };
    expect(order.invoiceId).toBe(inv.id);
    expect(order.debtor.toLowerCase()).toBe(payer.address.toLowerCase());
    expect(call.args[1]).toBe('0x');
    expect(f.db.prepare('SELECT invoice_id FROM fin_claims WHERE id=?').get('1')).toEqual({ invoice_id: inv.id });
    expect(invoiceRef(inv.id)).toBe(keccak256(stringToHex(inv.id)));
    expect(listed).toMatchObject({ status: 'requested', funding: { open: true, soldMinor: '0' } });
    expect(listed.timeline.map((e: { kind: string }) => e.kind)).toContain('requested');
    expect((await f.call(`/v1/financing/invoices/${inv.id}/list`, f.keys.secretKey, {})).body.error.code).toBe('already_requested');

    const market = await f.ok('/v1/investor/marketplace', 'alice');
    expect(market.listings.map((l: { invoiceId: string }) => l.invoiceId)).toEqual([inv.id]);
    expect(market.listings[0].debtor.email).toBeNull();
    expect(market.investor.approval.status).toBe('pending');

    // Not approved: the contract would revert, so the API refuses and records it for compliance.
    await f.ok('/v1/investor/me/application', 'alice', { name: 'Ana Silva', organization: 'Lotus Capital', email: 'ana@lotus.test', region: 'GB' });
    f.fin.balances.set(wallets.alice.toLowerCase(), 10_000n * USDT);
    const refused = await f.call(`/v1/investor/listings/${inv.id}/purchase`, 'alice', { faceMinor: (600n * USDT).toString() });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toMatchObject({ code: 'not_approved' });
    expect(refused.body.error.message).toMatch(/Lotus Capital is not an approved investor/);
    // Retrying the same refused purchase is refused again but recorded once.
    expect((await f.call(`/v1/investor/listings/${inv.id}/purchase`, 'alice', { faceMinor: (600n * USDT).toString() })).body.error.code).toBe('not_approved');
    expect((await f.call('/v1/compliance/registry', 'alice')).body.error.code).toBe('not_compliance_officer');
    const registry = await f.ok('/v1/compliance/registry', 'officer');
    expect(registry.refusals).toHaveLength(1);
    expect(registry.investors.find((i: { address: string }) => i.address === wallets.alice.toLowerCase())).toMatchObject({ organization: 'Lotus Capital', approval: { status: 'pending', region: 'GB' } });

    // The officer signs a Decision; Pact's relayer submits it, so the officer needs no gas.
    const approval = await f.ok(`/v1/compliance/investors/${wallets.alice}`, 'officer', { decision: 'approve' });
    expect(approval.typedData[0]).toMatchObject({ primaryType: 'Decision', domain: { name: 'Pact Investor Registry', verifyingContract: REGISTRY }, message: { officer: wallets.officer.toLowerCase(), investor: wallets.alice.toLowerCase(), approve: true, nonce: '0' } });
    expect(hexToString(approval.order.region as Hex, { size: 2 })).toBe('GB');
    const entry = await f.approve('alice', 'Lotus Capital');
    expect(entry.approval.status).toBe('approved');
    expect(f.fin.relayed.at(-1)).toMatchObject({ contract: 'registry', functionName: 'decideWithSig' });

    // The investor signs the purchase and, with no allowance yet, a USDT permit for the price.
    const { prepared: purchase, view: holding } = await f.buy('alice', inv.id, 1n, 600n * USDT, discountBps);
    expect(purchase.typedData.map((t: { primaryType: string }) => t.primaryType)).toEqual(['Purchase', 'Permit']);
    expect(purchase.typedData[0].message).toMatchObject({ claimId: '1', investor: wallets.alice.toLowerCase(), units: '600000000', maxPrice: '582000000', nonce: '0' });
    expect(purchase.typedData[1]).toMatchObject({ domain: { name: 'Tether USD', version: '1' }, message: { spender: RECEIVABLES, value: '582000000' } });
    const relayed = f.fin.relayed.at(-1)!;
    expect(relayed).toMatchObject({ contract: 'receivables', functionName: 'buyWithSig' });
    expect((relayed.args[2] as { value: bigint }).value).toBe(582n * USDT);
    expect(holding.holders).toEqual([expect.objectContaining({ you: true, faceMinor: '600000000', paidMinor: '582000000', organization: 'Lotus Capital' })]);
    expect(holding.otherHolders).toBe(0);

    await f.approve('bob', 'Harbor Fund');
    await f.buy('bob', inv.id, 1n, 400n * USDT, discountBps, true);
    f.fin.claims.set('1', { ...f.fin.claims.get('1')!, status: 'funded', sold: 1_000n * USDT });
    const funded = await f.ok(`/v1/financing/invoices/${inv.id}`, f.keys.secretKey);
    expect(funded).toMatchObject({ status: 'funded', funding: { soldMinor: '1000000000', upfrontMinor: '865000000', open: false }, reserve: { heldMinor: '100000000' } });
    expect(funded.holders).toHaveLength(2);
    expect(funded.ledger.map((r: { type: string }) => r.type)).toEqual(expect.arrayContaining(['Financing advance', 'Financing reserve']));
    // The invoice's own financing status feeds the dashboard count and the export.
    expect(f.db.prepare('SELECT financing_status FROM invoices WHERE id=?').get(inv.id)).toEqual({ financing_status: 'financed' });
    expect((await f.ok('/v1/dashboard', f.keys.secretKey)).metrics.financedInvoices).toBe(1);

    // The customer pays as usual; the payment now goes to the receivables contract.
    const started = await f.ok(`/v1/commerce/me/invoices/${inv.id}/payments`, 'payer', {});
    const offer = await f.ok(`/v1/commerce/me/payments/${started.paymentId}/intent`, 'payer');
    expect(offer.intent.target).toBe(RECEIVABLES);
    expect(offer.intent.maxGas).toBe(paymentGas(2));
    expect(decodeFunctionData({ abi: receivablesAbi, data: offer.data }).args).toEqual([1n, started.paymentId, 1_000n * USDT]);

    // The escrow is refused for a financed invoice, even with a valid signature.
    const escrowData = encodeFunctionData({ abi: escrowAbi, functionName: 'chargeInvoice', args: [started.paymentId, merchant, 1_000n * USDT, 2_592_000n] });
    const escrowIntent = { ...offer.intent, target: escrow, dataHash: keccak256(escrowData), nonce: '7' };
    const escrowSignature = await payer.signTypedData(intentTypedData({ ...escrowIntent, amount: BigInt(escrowIntent.amount), nonce: 7n, deadline: BigInt(escrowIntent.deadline) }, router) as never);
    const toEscrow = await f.call(`/v1/commerce/me/payments/${started.paymentId}/intent`, 'payer', { intent: escrowIntent, data: escrowData, signature: escrowSignature });
    expect(toEscrow.status).toBe(422);
    expect(toEscrow.body.error.code).toBe('invoice_financed');

    const intent = { ...offer.intent, amount: BigInt(offer.intent.amount), nonce: BigInt(offer.intent.nonce), deadline: BigInt(offer.intent.deadline) };
    const signature = await payer.signTypedData(intentTypedData(intent, router) as never);
    const submitted = await f.ok(`/v1/commerce/me/payments/${started.paymentId}/intent`, 'payer', { intent: offer.intent, data: offer.data, signature });
    expect(submitted.status).toBe('submitted');
    expect(f.db.prepare('SELECT status FROM payments WHERE id=?').get(started.paymentId)).toEqual({ status: 'captured' });
    expect(f.db.prepare('SELECT status,paid_minor FROM invoices WHERE id=?').get(inv.id)).toEqual({ status: 'paid', paid_minor: '1000000000' });
    expect(f.db.prepare('SELECT claim_id FROM financed_payments WHERE payment_id=?').get(started.paymentId)).toEqual({ claim_id: '1' });
    // Not refundable through the escrow: the money went to the holders.
    expect((await f.call(`/v1/payments/${started.paymentId}/refund-intent`, f.keys.secretKey, { amount: '1', reason: 'test' })).body.error.code).toBe('financed_payment_not_refundable');

    // The contract's events for that payment reach the financing indexer.
    f.fin.transaction(router, RECEIVABLES, [
      { name: 'Paid', args: { claimId: 1n, paymentId: started.paymentId, payer: payer.address, amount: 1_000n * USDT, toHolders: 1_000n * USDT, toMerchant: 0n } },
      { name: 'HolderPaid', args: { claimId: 1n, holder: wallets.alice, amount: 600n * USDT, source: 0 } },
      { name: 'HolderPaid', args: { claimId: 1n, holder: wallets.bob, amount: 400n * USDT, source: 0 } },
      { name: 'Settled', args: { claimId: 1n, fromReserve: 0n, reserveReleased: 100n * USDT } },
    ]);
    await f.financing.poll();
    const repaid = await f.ok(`/v1/financing/invoices/${inv.id}`, f.keys.secretKey);
    expect(repaid).toMatchObject({ status: 'repaid', receivedMinor: '1000000000', outstandingMinor: '0', reserve: { heldMinor: '0', releasedMinor: '100000000' }, late: false });
    expect(repaid.timeline.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['payment', 'reserve', 'repaid', 'funded', 'advance']));
    expect(f.db.prepare('SELECT financing_status FROM invoices WHERE id=?').get(inv.id)).toEqual({ financing_status: 'repaid' });
    const portfolio = await f.ok('/v1/investor/portfolio', 'alice');
    expect(portfolio.totals).toMatchObject({ investedMinor: '582000000', receivedMinor: '600000000', closed: 1, open: 0 });
    const overviewAfter = await f.ok('/v1/financing', f.keys.secretKey);
    expect(overviewAfter).toMatchObject({ advancedMinor: '865000000', forwardedMinor: '1000000000', reserveHeldMinor: '0' });
  });

  it('defaults after the grace period, then the merchant buys the claim back and payments go to the escrow again', async () => {
    const f = fixture();
    f.fin.officers.add(wallets.officer.toLowerCase());
    const inv = await f.invoice('200', 10);
    const { maturity, discountBps } = await f.list(inv.id, 1n);
    await f.approve('alice', 'Lotus Capital');
    await f.buy('alice', inv.id, 1n, 200n * USDT, discountBps, true);
    f.fin.claims.set('1', { ...f.fin.claims.get('1')!, status: 'funded', sold: 200n * USDT });

    f.fin.time = maturity + 3 * 86_400;
    expect((await f.ok(`/v1/financing/invoices/${inv.id}`, f.keys.secretKey))).toMatchObject({ status: 'overdue', late: true, outstandingMinor: '202000000' });
    expect(await f.financing.keep()).toBe(0);

    f.fin.time = maturity + 8 * 86_400;
    expect(await f.financing.keep()).toBe(1);
    expect(f.fin.keeperCalls).toEqual([{ functionName: 'markDefault', claimId: 1n }]);
    f.fin.transaction(wallets.officer, RECEIVABLES, [
      { name: 'HolderPaid', args: { claimId: 1n, holder: wallets.alice, amount: 20n * USDT, source: 1 } },
      { name: 'Defaulted', args: { claimId: 1n, fromReserve: 20n * USDT, buyBackOwed: 182n * USDT } },
    ]);
    await f.financing.poll();
    const defaulted = await f.ok(`/v1/financing/invoices/${inv.id}`, f.keys.secretKey);
    expect(defaulted).toMatchObject({ status: 'defaulted', frozen: true, buyBackMinor: '182000000', reserve: { heldMinor: '0', toInvestorsMinor: '20000000' }, transfers: { open: false } });

    f.fin.owedBy.set('1', 182n * USDT);
    f.fin.balances.set(merchant.toLowerCase(), 100n * USDT);
    expect((await f.call(`/v1/financing/invoices/${inv.id}/buy-back`, f.keys.secretKey, {})).body.error.code).toBe('insufficient_funds');
    f.fin.balances.set(merchant.toLowerCase(), 1_000n * USDT);
    // The merchant signs USDT permits for the holders' money and the network fee, then the buy-back
    // as a Router intent: it pays the gas in USDT on top, like a refund, and needs no WBT.
    const buyBack = await f.ok(`/v1/financing/invoices/${inv.id}/buy-back`, f.keys.secretKey, {});
    expect(buyBack.typedData.map((t: { primaryType: string }) => t.primaryType)).toEqual(['Permit', 'Permit', 'Intent']);
    expect(buyBack.typedData.slice(0, 2).map((t: { message: { spender: string } }) => t.message.spender)).toEqual([RECEIVABLES, router]);
    expect(buyBack.order).toMatchObject({ claimId: '1', owed: '182000000', permits: 'receivables,router' });
    expect(buyBack.lines.find((l: { label: string }) => l.label === 'Network fee').value).toMatch(/^Up to \$\d/);
    const data = encodeFunctionData({ abi: receivablesAbi, functionName: 'buyBack', args: [1n] });
    const intent = { signer: merchant, merchant, target: RECEIVABLES, dataHash: keccak256(data), amount: 182n * USDT, nonce: BigInt(buyBack.order.nonce), deadline: BigInt(buyBack.order.deadline), maxGas: Number(buyBack.order.maxGas) };
    // Only the merchant's own signature moves its money.
    const forged = await payer.signTypedData(intentTypedData(intent, router) as never);
    expect((await f.call(`/v1/financing/invoices/${inv.id}/buy-back/relay`, f.keys.secretKey, { order: buyBack.order, signatures: [f.sig, f.sig, forged] })).body.error.code).toBe('invalid_signature');
    // The Router transaction lands on the same chain the financing indexer reads.
    const broadcast = f.chain.broadcastTransaction.bind(f.chain);
    vi.spyOn(f.chain, 'broadcastTransaction').mockImplementation(async raw => {
      const hash = await broadcast(raw);
      f.fin.adopt(hash, router, [
        { name: 'HolderPaid', args: { claimId: 1n, holder: wallets.alice, amount: 182n * USDT, source: 2 } },
        { name: 'BoughtBack', args: { claimId: 1n, amount: 182n * USDT } },
      ]);
      return hash;
    });
    const signature = await merchantAccount.signTypedData(intentTypedData(intent, router) as never);
    const bought = await f.ok(`/v1/financing/invoices/${inv.id}/buy-back/relay`, f.keys.secretKey, { order: buyBack.order, signatures: [f.sig, f.sig, signature] });
    expect(f.fin.relayed.filter(r => r.contract === 'usdt').map(r => String(r.args[1]).toLowerCase())).toEqual([RECEIVABLES, router]);
    expect(bought).toMatchObject({ status: 'bought_back', receivedMinor: '202000000', buyBackMinor: '0' });
    expect(bought.ledger.map((r: { type: string }) => r.type)).toContain('Financing buy-back');
    f.fin.active.clear();
    f.fin.claims.set('1', { ...f.fin.claims.get('1')!, status: 'bought_back' });
    expect(await f.financing.route(inv.id, merchant)).toBeNull();
  });

  it('moves units, cost and receipts with a transfer and closes transfers at the record date', async () => {
    const f = fixture();
    f.fin.officers.add(wallets.officer.toLowerCase());
    const inv = await f.invoice('1000', 20);
    const { maturity, discountBps } = await f.list(inv.id, 1n);
    await f.approve('alice', 'Lotus Capital');
    await f.approve('bob', 'Harbor Fund');
    await f.buy('alice', inv.id, 1n, 1_000n * USDT, discountBps, true);
    f.fin.claims.set('1', { ...f.fin.claims.get('1')!, status: 'funded', sold: 1_000n * USDT });
    f.fin.transaction(router, RECEIVABLES, [
      { name: 'Paid', args: { claimId: 1n, paymentId: hash(1), payer: payer.address, amount: 500n * USDT, toHolders: 500n * USDT, toMerchant: 0n } },
      { name: 'HolderPaid', args: { claimId: 1n, holder: wallets.alice, amount: 500n * USDT, source: 0 } },
    ]);
    await f.financing.poll();

    const listing = await f.ok(`/v1/investor/listings/${inv.id}`, 'alice');
    expect(listing.owned).toBe(true);
    expect(listing.counterparties).toEqual([expect.objectContaining({ id: wallets.bob.toLowerCase(), organization: 'Harbor Fund', approved: true })]);
    const prepared = await f.ok(`/v1/investor/listings/${inv.id}/transfer`, 'alice', { to: wallets.bob, faceMinor: (400n * USDT).toString() });
    expect(prepared.typedData[0]).toMatchObject({ primaryType: 'Transfer', message: { claimId: '1', from: wallets.alice.toLowerCase(), to: wallets.bob.toLowerCase(), units: '400000000' } });
    // The contract moves what the units already received with them, pro rata.
    f.fin.onRelay = ({ functionName, args }) => {
      if (functionName !== 'transferWithSig') return 'reverted';
      const o = args[0] as { claimId: bigint; from: Address; to: Address; units: bigint };
      return [{ name: 'Transferred', args: { claimId: o.claimId, from: o.from, to: o.to, units: o.units, received: 200n * USDT } }];
    };
    await f.ok(`/v1/investor/listings/${inv.id}/transfer/relay`, 'alice', { order: prepared.order, signatures: [`0x${'ab'.repeat(64)}1b`] });
    expect(f.fin.relayed.at(-1)).toMatchObject({ functionName: 'transferWithSig' });
    // A refusal the simulation finds is reported in words, and nothing is sent.
    f.fin.onRelay = () => 'InvalidSignature';
    const bad = await f.call(`/v1/investor/listings/${inv.id}/transfer/relay`, 'alice', { order: prepared.order, signatures: [`0x${'ab'.repeat(64)}1b`] });
    expect(bad.body.error).toMatchObject({ code: 'invalid_signature' });
    // Pact relays a bounded number of orders per wallet an hour.
    for (let i = 0; i < 20; i++) f.db.prepare('INSERT INTO fin_relays VALUES (?,?,?,?)').run(`frel_${i}`, wallets.alice.toLowerCase(), '0x', now());
    const limited = await f.call(`/v1/investor/listings/${inv.id}/transfer/relay`, 'alice', { order: prepared.order, signatures: [`0x${'ab'.repeat(64)}1b`] });
    expect(limited.body.error.code).toBe('relay_limit');
    f.db.prepare("DELETE FROM fin_relays WHERE id LIKE 'frel\\_%' ESCAPE '\\'").run();
    const merchantView = await f.ok(`/v1/financing/invoices/${inv.id}`, f.keys.secretKey);
    const byId = Object.fromEntries(merchantView.holders.map((h: { id: string }) => [h.id, h]));
    expect(byId[wallets.alice.toLowerCase()]).toMatchObject({ faceMinor: '600000000', receivedMinor: '300000000' });
    expect(byId[wallets.bob.toLowerCase()]).toMatchObject({ faceMinor: '400000000', receivedMinor: '200000000', paidMinor: (((1_000n * USDT - 1_000n * USDT * BigInt(discountBps) / 10_000n) * 400n) / 1_000n).toString() });

    // A revoked recipient is refused and recorded; after the record date nothing moves.
    f.fin.approved.delete(wallets.bob.toLowerCase());
    expect((await f.call(`/v1/investor/listings/${inv.id}/transfer`, 'alice', { to: wallets.bob, faceMinor: (100n * USDT).toString() })).body.error.code).toBe('transfer_refused');
    f.fin.approved.add(wallets.bob.toLowerCase());
    f.fin.time = maturity - 3_600;
    const closed = await f.call(`/v1/investor/listings/${inv.id}/transfer`, 'alice', { to: wallets.bob, faceMinor: (100n * USDT).toString() });
    expect(closed.body.error.message).toMatch(/record date/);
    expect((await f.ok('/v1/compliance/registry', 'officer')).refusals).toHaveLength(2);
  });

  it('refuses what the contract would: a used acknowledgement, and a payment that leaves dust', async () => {
    const f = fixture();
    f.fin.officers.add(wallets.officer.toLowerCase());
    const used = await f.invoice('100', 20);
    f.fin.acknowledgements.set(keccak256(stringToHex(`ack:${used.id}`)).toLowerCase(), 9n);
    expect((await f.call(`/v1/financing/invoices/${used.id}/list`, f.keys.secretKey, {})).body.error.code).toBe('acknowledgement_used');

    const created = await f.ok('/v1/invoices?expand=detail', f.keys.secretKey, { customerEmail: 'client@acme.test', dueAt: new Date(Date.now() + 20 * 86_400_000).toISOString(), allowPartial: true, lines: [{ description: 'Audit', quantity: 1, unitAmount: '100' }] });
    f.db.prepare('INSERT INTO invoice_acknowledgements VALUES (?,?,?,?,?)').run(created.id, payer.address.toLowerCase(), '0x', keccak256(stringToHex(`ack:${created.id}`)), now());
    f.db.prepare("UPDATE invoices SET status='acknowledged' WHERE id=?").run(created.id);
    const { discountBps } = await f.list(created.id, 1n);
    await f.approve('alice', 'Lotus Capital');
    await f.buy('alice', created.id, 1n, 100n * USDT, discountBps, true);
    f.fin.claims.set('1', { ...f.fin.claims.get('1')!, status: 'funded', sold: 100n * USDT });
    const partial = await f.ok(`/v1/commerce/me/invoices/${created.id}/payments`, 'payer', { amountMinor: (100n * USDT - USDT / 2n).toString() });
    const refused = await f.call(`/v1/commerce/me/payments/${partial.paymentId}/intent`, 'payer');
    expect(refused.status).toBe(422);
    expect(refused.body.error.code).toBe('financed_payment_amount');
  });

  it('refuses an invoice already pledged, signs decisions for the investor’s current version and cancels unsent orders', async () => {
    const f = fixture();
    f.fin.officers.add(wallets.officer.toLowerCase());
    // Sold or paid while listed under an earlier claim: the contract keeps it pledged for good.
    const pledged = await f.invoice('100', 20);
    f.fin.pledged.add(`${merchant.toLowerCase()}:${invoiceRef(pledged.id).toLowerCase()}`);
    expect((await f.call(`/v1/financing/invoices/${pledged.id}/list`, f.keys.secretKey, {})).body.error.code).toBe('already_financed');

    // A decision signed before a later one (approve, then revoke) cannot run after it: it carries the version.
    await f.ok('/v1/investor/me/application', 'alice', { name: 'Ana', organization: 'Lotus Capital', email: 'ana@lotus.test', region: 'GB' });
    f.fin.versions.set(wallets.alice.toLowerCase(), 3n);
    f.fin.nonces.set(`registry:${wallets.officer.toLowerCase()}`, 5n);
    const decision = await f.ok(`/v1/compliance/investors/${wallets.alice}`, 'officer', { decision: 'approve' });
    expect(decision.typedData[0].types.Decision.map((t: { name: string }) => t.name)).toEqual(['officer', 'investor', 'approve', 'expiresAt', 'region', 'version', 'nonce', 'deadline']);
    expect(decision.typedData[0].message).toMatchObject({ version: '3', nonce: '5' });
    // Signed orders last ten minutes.
    expect(Number(decision.order.deadline) - f.fin.time).toBe(600);

    // An investor cancels the orders it signed that did not run: one signature, relayed by Pact.
    f.fin.nonces.set(`receivables:${wallets.alice.toLowerCase()}`, 2n);
    f.fin.onRelay = ({ contract, functionName, args }) => {
      if (contract === 'usdt') return 'reverted';
      if (functionName !== 'cancelNonceWithSig') return 'reverted';
      const key = `${contract}:${String(args[0]).toLowerCase()}`;
      const nonce = f.fin.nonces.get(key) ?? 0n;
      f.fin.nonces.set(key, nonce + 1n);
      return [{ contract, name: 'NonceCancelled', args: { signer: args[0], nonce } }];
    };
    const cancel = await f.ok('/v1/investor/orders/cancel', 'alice', {});
    expect(cancel.typedData[0]).toMatchObject({ primaryType: 'Cancel', domain: { name: 'Pact Receivables', verifyingContract: RECEIVABLES }, message: { signer: wallets.alice.toLowerCase(), nonce: '2' } });
    expect((await f.call('/v1/investor/orders/cancel/relay', 'alice', { order: { ...cancel.order, signer: wallets.bob.toLowerCase() }, signatures: [`0x${'ab'.repeat(64)}1b`] })).body.error.code).toBe('order_mismatch');
    expect(await f.ok('/v1/investor/orders/cancel/relay', 'alice', { order: cancel.order, signatures: [`0x${'ab'.repeat(64)}1b`] })).toEqual({ cancelled: true, nonce: '3' });
    expect(f.fin.relayed.at(-1)).toMatchObject({ contract: 'receivables', functionName: 'cancelNonceWithSig' });

    // Officers cancel unsent decisions the same way; other wallets cannot use the registry route.
    expect((await f.call('/v1/compliance/orders/cancel', 'alice', {})).body.error.code).toBe('not_compliance_officer');
    const officerCancel = await f.ok('/v1/compliance/orders/cancel', 'officer', {});
    expect(officerCancel.typedData[0]).toMatchObject({ domain: { name: 'Pact Investor Registry', verifyingContract: REGISTRY }, message: { nonce: '5' } });
    expect(await f.ok('/v1/compliance/orders/cancel/relay', 'officer', { order: officerCancel.order, signatures: [`0x${'ab'.repeat(64)}1b`] })).toEqual({ cancelled: true, nonce: '6' });
    // The decision signed with nonce 5 is now dead; the contract would refuse it.
    f.fin.onRelay = () => 'InvalidSignature';
    expect((await f.call(`/v1/compliance/investors/${wallets.alice}/relay`, 'officer', { order: decision.order, signatures: [`0x${'ab'.repeat(64)}1b`] })).body.error.code).toBe('invalid_signature');
  });

  it('says financing is unavailable where the contracts are not deployed', async () => {
    const db = openDb(), chain = new FakeChain();
    const keys = seedMerchant(db, merchant);
    const app = createApp({ db, chain, relayer: new Relayer(chain, router, allowedTargets({ escrow: escrow, subscription: subscription })), router, escrow, subscription });
    for (const path of ['/v1/financing', '/v1/financing/invoices/inv_1', '/v1/investor/marketplace', '/v1/compliance/registry']) {
      const r = await app.request(path, { headers: { authorization: `Bearer ${keys.secretKey}` } });
      expect(r.status).toBe(501);
      expect((await r.json()).error.code).toBe('financing_unavailable');
    }
    expect((await (await app.request('/v1/network')).json()).contracts).toMatchObject({ receivables: null, investorRegistry: null });
  });

  it('takes a listing down with the merchant’s signature, and lets any wallet withdraw a credit by signing', async () => {
    const f = fixture();
    const inv = await f.invoice('500', 30);
    await f.list(inv.id, 4n);
    // Cancelling is signed (EIP-712 CancelListing) and relayed: the merchant needs no WBT.
    f.fin.nonces.set(`receivables:${merchant.toLowerCase()}`, 1n);
    const prepared = await f.ok(`/v1/financing/invoices/${inv.id}/cancel`, f.keys.secretKey, {});
    expect(prepared.typedData[0]).toMatchObject({ primaryType: 'CancelListing', domain: { name: 'Pact Receivables', verifyingContract: RECEIVABLES }, message: { merchant: merchant.toLowerCase(), claimId: '4', nonce: '1' } });
    expect((await f.call(`/v1/financing/invoices/${inv.id}/cancel/relay`, f.keys.secretKey, { order: { ...prepared.order, claimId: '5' }, signatures: [f.sig] })).body.error.code).toBe('order_mismatch');
    f.fin.onRelay = ({ functionName, args }) => functionName === 'cancelWithSig' ? [{ name: 'Cancelled', args: { claimId: args[1] as bigint } }] : 'reverted';
    const cancelled = await f.ok(`/v1/financing/invoices/${inv.id}/cancel/relay`, f.keys.secretKey, { order: prepared.order, signatures: [f.sig] });
    expect(f.fin.relayed.at(-1)).toMatchObject({ contract: 'receivables', functionName: 'cancelWithSig', args: [merchant, 4n, BigInt(prepared.order.deadline), f.sig] });
    expect(f.db.prepare('SELECT status FROM fin_claims WHERE id=?').get('4')).toEqual({ status: 'cancelled' });
    // Off the marketplace: the invoice can be listed again.
    expect(cancelled.status).toBe('eligible');

    // A credit the contract could not deliver: its owner signs a Withdraw, Pact relays it.
    expect((await f.call('/v1/financing/withdraw', 'alice', {})).body.error.code).toBe('nothing_to_withdraw');
    f.fin.credits.set(wallets.alice.toLowerCase(), 12n * USDT);
    const withdraw = await f.ok('/v1/financing/withdraw', 'alice', {});
    expect(withdraw.typedData[0]).toMatchObject({ primaryType: 'Withdraw', message: { account: wallets.alice.toLowerCase(), nonce: '0' } });
    expect(withdraw.order).toMatchObject({ amount: '12000000' });
    f.fin.onRelay = ({ functionName, args }) => {
      if (functionName !== 'withdrawWithSig') return 'reverted';
      f.fin.credits.delete(String(args[0]).toLowerCase());
      return [{ name: 'Withdrawal', args: { account: args[0] as Address, amount: 12n * USDT } }];
    };
    expect(await f.ok('/v1/financing/withdraw/relay', 'alice', { order: withdraw.order, signatures: [f.sig] })).toEqual({ address: wallets.alice.toLowerCase(), claimableMinor: '0' });
    expect(f.fin.relayed.at(-1)).toMatchObject({ functionName: 'withdrawWithSig' });
  });

  it('charges a merchant’s relayed listings to its daily sponsorship budget', async () => {
    const f = fixture();
    const inv = await f.invoice('300', 30);
    // Listing is free for the merchant, but counts against the gas Pact absorbs for it each day.
    f.db.prepare("INSERT INTO sponsored_spend VALUES ('earlier',?,?,?,'subscribe',?)").run(f.keys.merchantId, new Date().toISOString().slice(0, 10), (10n ** 18n).toString(), new Date().toISOString());
    const prepared = await f.ok(`/v1/financing/invoices/${inv.id}/list`, f.keys.secretKey, {});
    const refused = await f.call(`/v1/financing/invoices/${inv.id}/list/relay`, f.keys.secretKey, { order: prepared.order, signatures: [f.sig] });
    expect(refused.body.error.code).toBe('sponsorship_budget');
    expect(f.fin.relayed).toHaveLength(0);
    f.db.prepare("DELETE FROM sponsored_spend WHERE operation_id='earlier'").run();
    await f.list(inv.id, 7n);
    expect(f.db.prepare("SELECT kind FROM sponsored_spend WHERE merchant_id=?").all(f.keys.merchantId)).toEqual([{ kind: 'financing_list' }]);
  });

  it('refuses ineligible invoices with the reason', async () => {
    const f = fixture();
    const inv = await f.invoice('1000', 30);
    f.db.prepare('DELETE FROM invoice_acknowledgements WHERE invoice_id=?').run(inv.id);
    const view = await f.ok(`/v1/financing/invoices/${inv.id}`, f.keys.secretKey);
    expect(view.status).toBeNull();
    expect(view.ineligibleReason).toMatch(/acknowledge/);
    const listed = await f.call(`/v1/financing/invoices/${inv.id}/list`, f.keys.secretKey, {});
    expect(listed.body.error).toMatchObject({ code: 'not_eligible' });
    const soon = await f.invoice('1000', 0);
    expect((await f.ok(`/v1/financing/invoices/${soon.id}`, f.keys.secretKey)).ineligibleReason).toMatch(/record date/);
  });
});
