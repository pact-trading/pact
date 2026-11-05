import 'server-only';
import type { Address, Hex } from 'viem';
import type { RefusalEvent, RefusalSource, SponsoredAction } from '@pactagent/core/platform-types';
import { toMinor } from '@/lib/format';
import { reasonDetail } from '@/lib/reasons';
import { DataError } from '../errors';
import {
  hooks,
  DAY,
  dayKey,
  iso,
  now,
  type AgentRecord,
  type CustomerRecord,
  type InvoiceRecord,
  type MockStore,
  type OrderRecord,
  type PlanRecord,
  type SubscriptionRecord,
} from './store';

/** API decimal format: 6 places, e.g. "1000.000000". */
export function dec6(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  return `${negative ? '-' : ''}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, '0')}`;
}

export const USDT = (dollars: number) => BigInt(Math.round(dollars * 1_000_000));
export const WEI = (wbt: number) => BigInt(Math.round(wbt * 1e9)) * 1_000_000_000n;

/** Approximate gas per sponsored action, in wei. */
const GAS: Record<SponsoredAction, bigint> = {
  payment: WEI(0.00031),
  refund: WEI(0.00026),
  subscribe: WEI(0.00034),
  renewal: WEI(0.00028),
  cancel: WEI(0.00014),
  invoice_acknowledge: WEI(0.00012),
  account_setup: WEI(0.00052),
  agent_settlement: WEI(0.00012),
};

export const SECURITY_LAYERS = [
  {
    id: 1,
    name: 'Function allowlist',
    enforcedIn: 'contract',
    stops: 'Using the relayer to run arbitrary transactions',
    reasons: ['wrong_selector', 'target_refused'],
  },
  {
    id: 2,
    name: 'Per-merchant gas tank',
    enforcedIn: 'contract',
    stops: "One merchant's gas paying for another merchant's traffic",
    reasons: ['tank_limit'],
  },
  {
    id: 3,
    name: 'Daily caps per payer and merchant',
    enforcedIn: 'contract',
    stops: 'Spam from one payer or one merchant',
    reasons: ['payer_daily_cap', 'merchant_daily_sponsorship_cap'],
  },
  {
    id: 4,
    name: 'Minimum amount, fee covers gas',
    enforcedIn: 'contract',
    stops: "Dust payments at the merchant's expense",
    reasons: ['dust', 'fee_too_low'],
  },
  {
    id: 5,
    name: 'Signature, nonce and deadline',
    enforcedIn: 'contract',
    stops: 'Replays and stale intents',
    reasons: ['invalid_signature', 'replay', 'deadline'],
  },
  {
    id: 6,
    name: 'Simulate before broadcast',
    enforcedIn: 'relayer',
    stops: 'Paying gas for transactions that would fail',
    reasons: ['simulation_refused'],
  },
  {
    id: 7,
    name: 'Gas caps per call',
    enforcedIn: 'relayer',
    stops: 'Gas price spikes and gas-heavy calls',
    reasons: ['gas_limit', 'gas_price'],
  },
  {
    id: 8,
    name: 'Hot wallet float and circuit breaker',
    enforcedIn: 'relayer',
    stops: 'A bug or leaked key emptying the float',
    reasons: ['circuit_open', 'circuit_budget'],
  },
] as const;

export function layerFor(reason: string): number | null {
  return SECURITY_LAYERS.find(layer => (layer.reasons as readonly string[]).includes(reason))?.id ?? null;
}

export { reasonDetail } from '@/lib/reasons';

export function customer(s: MockStore, id: string): CustomerRecord {
  const found = s.customers.find(c => c.id === id);
  if (!found) throw new DataError('not_found', 'Customer was not found.', 404);
  return found;
}

export function plan(s: MockStore, id: string): PlanRecord {
  const found = s.plans.find(p => p.id === id);
  if (!found) throw new DataError('not_found', 'Plan was not found.', 404);
  return found;
}

// ------------------------------------------------------------ side effects

export function webhook(s: MockStore, type: string, objectId: string) {
  const at = iso(now(s));
  const event = { id: s.ids.next('evt', 4000), type, object_id: objectId, created_at: at };
  s.webhookEvents.unshift(event);
  if (s.merchant.settings.webhook.configured) {
    s.webhookDeliveries.unshift({
      id: s.ids.next('dlv', 7000),
      event_id: event.id,
      attempt: 1,
      status: 'delivered',
      next_at: at,
      last_http_status: 200,
      last_error: null,
      delivered_at: at,
    });
  }
  return event;
}

export function refusal(
  s: MockStore,
  input: {
    source: RefusalSource;
    reason: string;
    objectId: string;
    actor: string | null;
    txHash?: Hex | null;
    detail?: string;
  },
): RefusalEvent {
  const event: RefusalEvent = {
    id: s.ids.next('rfs', 5000),
    objectId: input.objectId,
    reason: input.reason,
    txHash: input.txHash ?? null,
    createdAt: iso(now(s)),
    source: input.source,
    layer: input.source === 'sponsorship' ? layerFor(input.reason) : null,
    detail: input.detail ?? reasonDetail(input.reason),
    actor: input.actor,
  };
  s.refusals.unshift(event);
  if (input.source === 'subscription') webhook(s, 'subscription.refused', input.objectId);
  if (input.source === 'sponsorship') webhook(s, 'intent.refused', input.objectId);
  return event;
}

function spentTodayWei(s: MockStore) {
  const today = dayKey(now(s));
  return s.gas.ledger
    .filter(entry => entry.createdAt.startsWith(today))
    .reduce((sum, entry) => sum + BigInt(entry.gasWei), 0n);
}

function payerActionsToday(s: MockStore, payer: string) {
  const today = dayKey(now(s));
  return s.gas.ledger.filter(
    entry => entry.createdAt.startsWith(today) && entry.objectId.startsWith(`${payer}:`),
  ).length;
}

export const gasUsd = (s: MockStore, gasWei: bigint) => (gasWei * s.gas.wbtUsdMinor) / 10n ** 18n;

/**
 * The relayer submits a signed request and the merchant's tank pays the gas.
 * Applies the contract limits; a refusal spends nothing.
 */
export function sponsor(
  s: MockStore,
  input: {
    action: SponsoredAction;
    objectId: string;
    label: string;
    payer: string;
    feeMinor?: bigint;
    amountMinor?: bigint;
  },
): { ok: true; txHash: Hex; gasWei: bigint } | { ok: false; refusal: RefusalEvent } {
  const variance = BigInt(85 + s.random.int(0, 30));
  const gasWei = (GAS[input.action] * variance) / 100n;
  const refuse = (reason: string) => ({
    ok: false as const,
    refusal: refusal(s, { source: 'sponsorship', reason, objectId: input.objectId, actor: input.payer }),
  });
  if (input.amountMinor !== undefined && input.amountMinor < BigInt(s.gas.policy.minimumAmountMinor))
    return refuse('dust');
  if (input.feeMinor !== undefined && input.action === 'payment' && input.feeMinor < gasUsd(s, gasWei))
    return refuse('fee_too_low');
  // Agent settlements are limited by the agent's own session caps instead of the payer count.
  if (
    input.action !== 'agent_settlement' &&
    payerActionsToday(s, input.payer) >= s.gas.policy.perPayerDailyActions
  )
    return refuse('payer_daily_cap');
  if (spentTodayWei(s) + gasWei > s.gas.dailyCapWei) return refuse('merchant_daily_sponsorship_cap');
  if (s.gas.balanceWei < gasWei) return refuse('tank_limit');
  const txHash = s.ids.tx();
  s.gas.balanceWei -= gasWei;
  s.gas.ledger.unshift({
    id: s.ids.next('gas', 9000),
    createdAt: iso(now(s)),
    action: input.action,
    objectId: `${input.payer}:${input.objectId}`,
    label: input.label,
    gasWei: gasWei.toString(),
    gasUsdMinor: gasUsd(s, gasWei).toString(),
    feeMinor: (input.feeMinor ?? 0n).toString(),
    txHash,
  });
  return { ok: true, txHash, gasWei };
}

export function feeFor(s: MockStore, amount: bigint) {
  const fee = (amount * BigInt(s.merchant.feeBps)) / 10_000n;
  return fee < USDT(0.05) ? USDT(0.05) : fee;
}

/** The customer's smart account is deployed by the relayer on first use, at the merchant's cost. */
export function ensureAccount(s: MockStore, c: CustomerRecord) {
  if (s.deployedAccounts.has(c.id)) return;
  const deployed = sponsor(s, {
    action: 'account_setup',
    objectId: c.id,
    label: `Account setup for ${c.name}`,
    payer: c.address,
  });
  if (deployed.ok) s.deployedAccounts.add(c.id);
}

// ---------------------------------------------------------------- payments

/** Pulls `amount` from the customer to the merchant in one sponsored transaction. */
export function collect(
  s: MockStore,
  c: CustomerRecord,
  input: {
    amount: bigint;
    objectId: string;
    label: string;
    type: 'Payment' | 'Subscription' | 'Invoice';
    orderId: string | null;
    action: SponsoredAction;
  },
): { txHash: Hex; feeMinor: bigint; gasWei: bigint } {
  if (c.balanceMinor < input.amount)
    throw new DataError('insufficient_funds', 'Not enough funds in the account.');
  ensureAccount(s, c);
  const feeMinor = feeFor(s, input.amount);
  const sponsored = sponsor(s, {
    action: input.action,
    objectId: input.objectId,
    label: input.label,
    payer: c.address,
    feeMinor,
    amountMinor: input.amount,
  });
  if (!sponsored.ok) throw new DataError(sponsored.refusal.reason, sponsored.refusal.detail);
  c.balanceMinor -= input.amount;
  s.merchant.usdtMinor += input.amount - feeMinor;
  s.accounting.push({
    id: s.ids.next('acc', 20000),
    at: now(s),
    type: input.type,
    objectId: input.objectId,
    orderId: input.orderId,
    customer: c.email,
    grossMinor: input.amount,
    feeMinor,
    gasWei: sponsored.gasWei,
    refundOf: null,
    txHash: sponsored.txHash,
  });
  return { txHash: sponsored.txHash, feeMinor, gasWei: sponsored.gasWei };
}

export function payOrder(s: MockStore, record: OrderRecord, c: CustomerRecord) {
  const amount = BigInt(record.order.total.amountMinor);
  const paymentId = record.order.paymentId ?? s.ids.tx();
  const paid = collect(s, c, {
    amount,
    objectId: paymentId,
    label: record.order.productName,
    type: 'Payment',
    orderId: record.order.id,
    action: 'payment',
  });
  const at = iso(now(s));
  record.order.status = 'paid';
  record.order.paymentId = paymentId;
  record.txHash = paid.txHash;
  record.feeMinor = paid.feeMinor;
  record.gasWei = paid.gasWei;
  record.paidAt = now(s);
  record.payerAddress = c.address;
  record.activity.push({
    type: 'payment.captured',
    at,
    detail: `Payment of ${dec6(amount)} USDT confirmed`,
    txHash: paid.txHash,
  });
  webhook(s, 'payment.captured', paymentId);
  webhook(s, 'order.paid', record.order.id);
  for (const hook of hooks.orderPaid) hook(s, record);
}

export function refundableMinor(record: OrderRecord) {
  const confirmed = record.refunds
    .filter(r => r.status !== 'failed')
    .reduce((sum, r) => sum + BigInt(r.amountMinor), 0n);
  return BigInt(record.order.total.amountMinor) - confirmed;
}

export function refundOrder(s: MockStore, record: OrderRecord, amount: bigint, reason: string) {
  const c = customer(s, record.order.customerId);
  const objectId = record.order.paymentId ?? record.order.id;
  // A fully refunded order still reaches the contract, which refuses it and leaves a record.
  if (!['paid', 'partially_refunded', 'refunded'].includes(record.order.status)) {
    throw new DataError('not_paid', 'This order has no confirmed payment to refund.', 409);
  }
  const windowEnds = (record.paidAt ?? 0) + s.merchant.settings.refundWindowSeconds * 1000;
  if (now(s) > windowEnds) {
    const event = refusal(s, {
      source: 'refund',
      reason: 'refund_window_closed',
      objectId,
      actor: s.merchant.name,
    });
    throw new DataError(event.reason, event.detail);
  }
  if (amount <= 0n || amount > refundableMinor(record)) {
    const event = refusal(s, {
      source: 'refund',
      reason: 'refund_limit',
      objectId,
      actor: s.merchant.name,
      txHash: s.ids.tx(),
    });
    throw new DataError(
      event.reason,
      `${event.detail} At most ${dec6(refundableMinor(record))} USDT can be refunded.`,
    );
  }
  const sponsored = sponsor(s, {
    action: 'refund',
    objectId: `${record.order.id}:refund`,
    label: `Refund for ${record.order.productName}`,
    payer: s.merchant.address,
  });
  if (!sponsored.ok) throw new DataError(sponsored.refusal.reason, sponsored.refusal.detail);
  const at = iso(now(s));
  record.refunds.push({
    id: s.ids.next('ref', 3000),
    amountMinor: amount.toString(),
    reason,
    status: 'succeeded',
    txHash: sponsored.txHash,
    createdAt: at,
  });
  record.order.refundedMinor = (BigInt(record.order.refundedMinor) + amount).toString();
  record.order.status = refundableMinor(record) === 0n ? 'refunded' : 'partially_refunded';
  record.activity.push({
    type: 'payment.refunded',
    at,
    detail: `Refund of ${dec6(amount)} USDT: ${reason}`,
    txHash: sponsored.txHash,
  });
  c.balanceMinor += amount;
  s.merchant.usdtMinor -= amount;
  s.accounting.push({
    id: s.ids.next('acc', 20000),
    at: now(s),
    type: 'Refund',
    objectId: record.refunds.at(-1)!.id,
    orderId: record.order.id,
    customer: c.email,
    grossMinor: -amount,
    feeMinor: 0n,
    gasWei: sponsored.gasWei,
    refundOf: objectId,
    txHash: sponsored.txHash,
  });
  webhook(s, 'payment.refunded', objectId);
  webhook(s, 'order.refunded', record.order.id);
}

// ----------------------------------------------------------- subscriptions

export function subscribe(
  s: MockStore,
  c: CustomerRecord,
  p: PlanRecord,
  options: { chargeNow?: boolean } = { chargeNow: true },
) {
  ensureAccount(s, c);
  const sub: SubscriptionRecord = {
    id: s.ids.next('sub', 6000),
    chainId: s.ids.tx(),
    planId: p.id,
    customerId: c.id,
    status: 'active',
    nextChargeAt: now(s),
    createdAt: now(s),
    signedAt: now(s),
    periodsCharged: 0,
    retryCount: 0,
    cancelledAt: null,
    replacedBy: null,
    charges: [],
  };
  const signed = sponsor(s, {
    action: 'subscribe',
    objectId: sub.id,
    label: `Subscription to ${p.name}`,
    payer: c.address,
  });
  if (!signed.ok) throw new DataError(signed.refusal.reason, signed.refusal.detail);
  s.subscriptions.unshift(sub);
  webhook(s, 'subscription.created', sub.id);
  if (options.chargeNow !== false) chargeSubscription(s, sub, { source: 'keeper' });
  return sub;
}

/** One renewal pull. The contract refuses early, cancelled, over-cap or exhausted pulls. */
export function chargeSubscription(
  s: MockStore,
  sub: SubscriptionRecord,
  options: { source: 'keeper' | 'merchant'; amount?: bigint },
) {
  const p = plan(s, sub.planId);
  const c = customer(s, sub.customerId);
  const amount = options.amount ?? p.amountMinor;
  const at = now(s);
  const refuse = (reason: string) => {
    const event = refusal(s, {
      source: 'subscription',
      reason,
      objectId: sub.id,
      actor: s.merchant.name,
      txHash: s.ids.tx(),
    });
    sub.charges.unshift({
      id: s.ids.next('chg', 8000),
      period: sub.periodsCharged + 1,
      amount: dec6(amount),
      status: 'refused',
      reason,
      txHash: event.txHash,
      at: iso(at),
    });
    return event;
  };
  if (sub.status === 'cancelled') return refuse('cancelled');
  if (amount > p.amountMinor) return refuse('cap_exceeded');
  if (p.maxPeriods !== null && sub.periodsCharged >= p.maxPeriods) return refuse('max_periods');
  if (at < sub.nextChargeAt) return refuse('too_early');
  if (c.balanceMinor < amount) {
    const event = refuse('insufficient_funds');
    sub.retryCount += 1;
    if (sub.retryCount > 3) {
      sub.status = 'paused';
    } else {
      sub.status = 'past_due';
      sub.nextChargeAt = at + DAY;
      sub.charges[0].status = 'retry_scheduled';
      webhook(s, 'subscription.past_due', sub.id);
    }
    return event;
  }
  const paid = collect(s, c, {
    amount,
    objectId: sub.id,
    label: `${p.name} renewal`,
    type: 'Subscription',
    orderId: null,
    action: sub.periodsCharged === 0 ? 'subscribe' : 'renewal',
  });
  sub.periodsCharged += 1;
  sub.retryCount = 0;
  sub.status = 'active';
  sub.nextChargeAt = Math.max(sub.nextChargeAt, sub.createdAt) + p.periodSeconds * 1000;
  sub.charges.unshift({
    id: s.ids.next('chg', 8000),
    period: sub.periodsCharged,
    amount: dec6(amount),
    status: 'charged',
    reason: null,
    txHash: paid.txHash,
    at: iso(at),
  });
  webhook(s, 'subscription.renewed', sub.id);
  return null;
}

export function cancelSubscription(s: MockStore, sub: SubscriptionRecord) {
  if (sub.status === 'cancelled') return;
  const c = customer(s, sub.customerId);
  const signed = sponsor(s, {
    action: 'cancel',
    objectId: `${sub.id}:cancel`,
    label: 'Subscription cancellation',
    payer: c.address,
  });
  if (!signed.ok) throw new DataError(signed.refusal.reason, signed.refusal.detail);
  sub.status = 'cancelled';
  sub.cancelledAt = now(s);
  webhook(s, 'subscription.cancelled', sub.id);
}

// ------------------------------------------------------------------ agents

export function agentCall(
  s: MockStore,
  record: AgentRecord,
  endpoint: MockStore['endpoints'][number],
  merchant: { name: string; address: Address },
  url: string,
) {
  const session = record.session;
  const at = now(s);
  const today = dayKey(at);
  const price = BigInt(endpoint.priceMinor);
  const amount = endpoint.scheme === 'upto' ? (price * BigInt(s.random.int(35, 90))) / 100n : price;
  let reason: string | null = null;
  if (session.status === 'revoked') reason = 'SessionRevoked';
  else if (new Date(session.expiresAt).getTime() < at) reason = 'SessionExpired';
  else if (!session.allowedMerchants.some(m => m.address === merchant.address)) reason = 'MerchantDenied';
  else if (price > BigInt(session.perCallCapMinor)) reason = 'PerCallCap';
  else if ((record.spentByDay[today] ?? 0n) + price > BigInt(session.dailyCapMinor)) reason = 'DailyCap';

  let txHash: Hex | null = null;
  if (!reason) {
    const sponsored = sponsor(s, {
      action: 'agent_settlement',
      objectId: `${session.id}:${s.ids.token(4)}`,
      label: `x402 ${endpoint.method} ${endpoint.path}`,
      payer: session.account,
    });
    if (!sponsored.ok) reason = sponsored.refusal.reason;
    else {
      txHash = sponsored.txHash;
      record.spentByDay[today] = (record.spentByDay[today] ?? 0n) + price;
      record.callsByDay[today] = (record.callsByDay[today] ?? 0) + 1;
      if (merchant.address === s.merchant.address) {
        s.merchant.usdtMinor += amount - s.merchant.agentFeeMinor;
        s.accounting.push({
          id: s.ids.next('acc', 20000),
          at,
          type: 'Agent payment',
          objectId: session.id,
          orderId: null,
          customer: session.name,
          grossMinor: amount,
          feeMinor: s.merchant.agentFeeMinor,
          gasWei: sponsored.gasWei,
          refundOf: null,
          txHash,
        });
      }
    }
  }
  if (reason) refusal(s, { source: 'agent', reason, objectId: session.id, actor: session.name });
  const score = (0.42 + s.random.next() * 0.5).toFixed(2);
  const call = {
    id: s.ids.next('call', 30000),
    agentId: session.id,
    agentName: session.name,
    merchantName: merchant.name,
    method: 'GET' as const,
    url,
    scheme: endpoint.scheme,
    priceMinor: price.toString(),
    amountMinor: reason ? '0' : amount.toString(),
    status: reason ? ('refused' as const) : ('settled' as const),
    reason,
    txHash,
    responseStatus: reason ? (402 as const) : (200 as const),
    responseBody: reason
      ? null
      : endpoint.path.startsWith('/api/risk-score')
        ? JSON.stringify({
            invoice: url.split('=')[1] ?? null,
            score: Number(score),
            band: Number(score) > 0.7 ? 'low' : 'medium',
          })
        : JSON.stringify({ rows: s.random.int(40, 400), metered: amount.toString() }),
    createdAt: iso(at),
  };
  s.agentCalls.unshift(call);
  return call;
}

// ---------------------------------------------------------------- invoices

export function payInvoice(s: MockStore, record: InvoiceRecord, c: CustomerRecord, amount: bigint) {
  const remaining = toMinor(record.invoice.remaining);
  if (amount <= 0n || amount > remaining)
    throw new DataError('invalid_amount', `Enter an amount up to ${dec6(remaining)} USDT.`);
  if (!record.invoice.allowPartial && amount !== remaining)
    throw new DataError('partial_not_allowed', 'This invoice must be paid in full.');
  // A financed invoice is paid to whoever holds the claim (mock/financing.ts); otherwise to the merchant.
  let paid: { txHash: Hex; feeMinor: bigint; gasWei: bigint } | null = null;
  for (const route of hooks.invoiceCollect) paid ??= route(s, record, c, amount);
  paid ??= collect(s, c, {
    amount,
    objectId: record.invoice.id,
    label: `Invoice ${record.number}`,
    type: 'Invoice',
    orderId: null,
    action: 'payment',
  });
  const paidTotal = toMinor(record.invoice.paid) + amount;
  const total = toMinor(record.invoice.amount);
  record.invoice.paid = dec6(paidTotal);
  record.invoice.remaining = dec6(total - paidTotal);
  record.invoice.status = paidTotal >= total ? 'paid' : 'partially_paid';
  record.activity.push({
    type: 'payment',
    at: iso(now(s)),
    detail: `Payment of ${dec6(amount)} USDT received`,
    amount: dec6(amount),
    txHash: paid.txHash,
  });
  if (record.invoice.status === 'paid') {
    record.activity.push({ type: 'paid', at: iso(now(s)), detail: 'Invoice paid in full' });
    webhook(s, 'invoice.paid', record.invoice.id);
  }
  for (const hook of hooks.invoicePaid) hook(s, record, amount);
  return paid;
}

// ------------------------------------------------------------------ keeper

/** Runs the keeper's scheduled work up to the current demo time. */
export function tick(s: MockStore) {
  const at = now(s);
  for (const sub of s.subscriptions) {
    let guard = 0;
    while ((sub.status === 'active' || sub.status === 'past_due') && sub.nextChargeAt <= at && guard++ < 24) {
      const p = plan(s, sub.planId);
      if (p.maxPeriods !== null && sub.periodsCharged >= p.maxPeriods) {
        sub.status = 'cancelled';
        sub.cancelledAt = at;
        break;
      }
      const before = sub.nextChargeAt;
      chargeSubscription(s, sub, { source: 'keeper' });
      if (sub.nextChargeAt === before) break;
    }
  }
  for (const record of s.invoices) {
    const inv = record.invoice;
    if (!inv.dueAt || inv.status === 'draft' || inv.status === 'paid') continue;
    for (const reminder of record.reminders) {
      if (!reminder.sentAt && new Date(reminder.dueAt).getTime() <= at) {
        reminder.sentAt = reminder.dueAt;
        record.activity.push({
          type: 'reminder',
          at: reminder.dueAt,
          detail:
            reminder.stage === 'overdue'
              ? 'Overdue notice sent'
              : `Reminder sent (${reminder.stage === 'seven_days' ? '7 days' : '1 day'} before due)`,
        });
        webhook(s, reminder.stage === 'overdue' ? 'invoice.overdue' : 'invoice.reminder_due', inv.id);
      }
    }
    if (new Date(inv.dueAt).getTime() < at && inv.status !== 'overdue') {
      inv.status = 'overdue';
      record.activity.push({ type: 'overdue', at: inv.dueAt, detail: 'Invoice is past its due date' });
    }
  }
  for (const checkout of s.checkouts) {
    if (checkout.status === 'open' && checkout.expiresAt < at) checkout.status = 'expired';
  }
  for (const agent of s.agents) {
    if (agent.session.status === 'active' && new Date(agent.session.expiresAt).getTime() < at)
      agent.session.status = 'expired';
  }
  for (const hook of hooks.tick) hook(s);
}

export function reminderSchedule(dueAt: number) {
  return [
    { stage: 'seven_days' as const, dueAt: iso(dueAt - 7 * DAY), sentAt: null, channel: 'email' as const },
    { stage: 'one_day' as const, dueAt: iso(dueAt - DAY), sentAt: null, channel: 'email' as const },
    { stage: 'overdue' as const, dueAt: iso(dueAt + 60_000), sentAt: null, channel: 'webhook' as const },
  ];
}
