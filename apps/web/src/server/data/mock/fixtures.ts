import 'server-only';
import type { Address } from 'viem';
import type { Product } from '@pactagent/core/commerce-types';
import type { AgentSession } from '@pactagent/core/platform-types';
import { seedCommerceExtras } from './commerce-extras';
import { seedFinancing } from './financing';
import { createRandom, idFactory } from './ids';
import { seedLab } from './lab';
import {
  agentCall,
  cancelSubscription,
  chargeSubscription,
  customer,
  dec6,
  payInvoice,
  payOrder,
  refundOrder,
  reminderSchedule,
  sponsor,
  subscribe,
  tick,
  USDT,
  refusal,
} from './engine';
import {
  DAY,
  HOUR,
  iso,
  now,
  registerFactory,
  setNow,
  type AgentRecord,
  type CustomerRecord,
  type InvoiceRecord,
  type MockStore,
  type OrderRecord,
  type PlanRecord,
} from './store';

/**
 * The PRD §5.1 story: a software studio with an API product, its client company,
 * the client's AI agent, and the studio's accountant. Neutral, fictional names.
 */
export const DEMO = {
  merchantName: 'Kite Labs',
  customerId: 'cus_acme',
  agentId: 'agt_research',
  invoiceId: 'inv_1042',
  planId: 'plan_growth',
  productId: 'prod_audit',
} as const;

function createStore(): MockStore {
  const random = createRandom(1874);
  const ids = idFactory(random);
  const realNow = Date.now();
  const start = realNow - 40 * DAY;
  const merchantAddress: Address = '0x7a1e5c0d2b9f84c1e3d6a0b5f2c8e91d4b6a3f07';

  const s: MockStore = {
    random,
    ids,
    clock: { base: start, realBase: realNow, offsetDays: 0 },
    merchant: {
      id: 'mer_kite',
      name: DEMO.merchantName,
      address: merchantAddress,
      ownerName: 'Maya Chen',
      ownerEmail: 'maya@kitelabs.example',
      accountantName: 'Priya Nair',
      accountantEmail: 'priya@kitelabs.example',
      settings: {
        brandName: DEMO.merchantName,
        logoUrl: null,
        refundWindowSeconds: 30 * 86_400,
        payoutAddress: merchantAddress,
        payoutMode: 'merchant_wallet',
        webhook: { url: 'https://api.kitelabs.example/webhooks/pact', configured: true },
      },
      agentFeeMinor: USDT(0.0005),
      usdtMinor: USDT(8_420),
      webhookSecret: `whsec_${ids.token(12)}`, // synthetic, generated per seed
      webhookEventTypes: [
        'payment.captured',
        'payment.refunded',
        'invoice.paid',
        'invoice.overdue',
        'subscription.renewed',
        'subscription.refused',
        'subscription.past_due',
        'order.paid',
        'order.refunded',
      ],
      onboarding: { account: true, brand: true, fees: true, integrate: true, test_payment: true },
    },
    otherMerchant: { name: 'Harbor Goods', address: '0x3c9d4e1f7a2b8c05d6e9f1a3b7c2d8e4f0a6b1c9' },
    products: [],
    customers: [],
    orders: [],
    invoices: [],
    plans: [],
    subscriptions: [],
    refusals: [],
    // The story's merchant signed the fee terms and both refund permits when it started.
    fees: { acceptedVersion: 1, permits: { escrow: true, router: true }, usdtPerWbtMinor: USDT(30) },
    relayed: [],
    agents: [],
    agentCalls: [],
    endpoints: [
      {
        id: 'ep_risk',
        method: 'GET',
        path: '/api/risk-score',
        description: 'Invoice risk score for receivables buyers',
        priceMinor: USDT(0.01).toString(),
        scheme: 'exact',
        callsToday: 0,
        revenueTodayMinor: '0',
        refusedToday: 0,
      },
      {
        id: 'ep_usage',
        method: 'GET',
        path: '/api/usage-report',
        description: 'Metered usage report, billed by rows returned',
        priceMinor: USDT(0.05).toString(),
        scheme: 'upto',
        callsToday: 0,
        revenueTodayMinor: '0',
        refusedToday: 0,
      },
    ],
    apiKeys: [
      {
        id: 'key_pk',
        name: 'Storefront',
        kind: 'publishable',
        preview: 'pk_test_…7a92',
        createdAt: iso(start),
        lastUsedAt: iso(realNow - HOUR),
        revokedAt: null,
      },
      {
        id: 'key_sk',
        name: 'Order server',
        kind: 'secret',
        preview: 'sk_test_…13bf',
        createdAt: iso(start),
        lastUsedAt: iso(realNow - 3 * HOUR),
        revokedAt: null,
      },
      {
        id: 'key_old',
        name: 'Old staging server',
        kind: 'secret',
        preview: 'sk_test_…c8d1',
        createdAt: iso(start - 30 * DAY),
        lastUsedAt: iso(start - 2 * DAY),
        revokedAt: iso(start + DAY),
      },
    ],
    webhookEvents: [],
    webhookDeliveries: [],
    accounting: [],
    checkouts: [],
    pending: new Map(),
    drainRuns: [],
    deployedAccounts: new Set(),
    usedNonces: new Set(),
    // Filled by each part's seed once the main story exists (end of createStore).
    commerceExtras: {} as MockStore['commerceExtras'],
    financing: {} as MockStore['financing'],
    lab: {} as MockStore['lab'],
  };

  const at = (ms: number) => {
    setNow(s, ms);
    tick(s);
  };

  // ------------------------------------------------------------ catalog
  const product = (
    id: string,
    name: string,
    description: string,
    dollars: number,
    status: Product['status'] = 'active',
  ): Product => ({
    id,
    merchantId: s.merchant.id,
    name,
    description,
    imageUrl: null,
    status,
    revision: 1,
    prices: [{ currency: 'USDT', amountMinor: USDT(dollars).toString() }],
  });
  s.products.push(
    product(
      'prod_audit',
      'Website audit',
      'A review of your site’s speed, accessibility and checkout, with a prioritised fix list.',
      490,
    ),
    product(
      'prod_sprint',
      'Design sprint',
      'Five days from problem to tested prototype with your team.',
      1200,
    ),
    product('prod_support', 'Integration support', 'One hour with an engineer on your API integration.', 150),
    product(
      'prod_toolkit',
      'Component toolkit',
      'Our React component library and Figma kit, licensed per team.',
      29,
    ),
    product(
      'prod_workshop',
      'Team workshop',
      'A half-day workshop on shipping APIs that agents can pay for.',
      790,
      'draft',
    ),
  );

  const planRecord = (
    id: string,
    name: string,
    description: string,
    dollars: number,
    maxPeriods: number,
  ): PlanRecord => ({
    id,
    name,
    description,
    amountMinor: USDT(dollars),
    periodSeconds: 30 * 86_400,
    maxPeriods,
    createdAt: start,
  });
  s.plans.push(
    planRecord('plan_growth', 'API Growth', '50,000 API calls a month, email support', 49, 12),
    planRecord('plan_scale', 'API Scale', '500,000 API calls a month, priority support', 199, 12),
    planRecord('plan_care', 'Design care', 'Ongoing design support, two requests at a time', 129, 6),
  );

  // ---------------------------------------------------------- customers
  const person = (
    id: string,
    name: string,
    email: string,
    company: string,
    dollars: number,
  ): CustomerRecord => ({
    id,
    name,
    email,
    company,
    address: ids.address(),
    balanceMinor: USDT(dollars),
    passkeys: 1,
    testFundsClaimedAt: null,
    createdAt: start,
  });
  s.customers.push(
    person(DEMO.customerId, 'Jordan Lee', 'jordan@acme-robotics.example', 'Acme Robotics', 1_350),
    person('cus_northwind', 'Alex Morgan', 'alex@northwind.example', 'Northwind Traders', 14_000),
    person('cus_bluebird', 'Dana Park', 'dana@bluebird-health.example', 'Bluebird Health', 6_000),
    person('cus_orbit', 'Sam Okafor', 'sam@orbit-supply.example', 'Orbit Supply', 1_200),
    person('cus_tideworks', 'Lena Fischer', 'lena@tideworks.example', 'Tideworks', 5_000),
    person('cus_monograph', 'Ravi Kumar', 'ravi@monograph.example', 'Monograph Co.', 7_000),
  );
  const byId = (id: string) => customer(s, id);

  // ------------------------------------------------------------- agents
  const agent = (
    id: string,
    customerId: string,
    name: string,
    description: string,
    perCall: number,
    daily: number,
    createdAt: number,
  ): AgentRecord => {
    const session: AgentSession = {
      id,
      name,
      description,
      account: ids.address(),
      sessionKey: ids.address(),
      perCallCapMinor: USDT(perCall).toString(),
      dailyCapMinor: USDT(daily).toString(),
      allowedMerchants: [{ address: s.merchant.address, name: s.merchant.name }],
      expiresAt: iso(realNow + 30 * DAY),
      status: 'active',
      spentTodayMinor: '0',
      callsToday: 0,
      createdAt: iso(createdAt),
    };
    return { session, customerId, spentByDay: {}, callsByDay: {} };
  };
  const research = agent(
    DEMO.agentId,
    DEMO.customerId,
    'Research agent',
    'Scores invoices before Acme pays suppliers',
    0.05,
    0.1,
    start + 4 * DAY,
  );
  const procurement = agent(
    'agt_procurement',
    DEMO.customerId,
    'Procurement bot',
    'Retired after the move to the research agent',
    0.02,
    0.05,
    start,
  );
  procurement.session.status = 'revoked';
  const pricing = agent(
    'agt_pricing',
    'cus_northwind',
    'Pricing bot',
    'Pulls usage reports for Northwind’s pricing team',
    0.05,
    1,
    start + 2 * DAY,
  );
  s.agents.push(research, procurement, pricing);

  // ------------------------------------------------------------ history
  type Event = { at: number; run: () => void };
  const events: Event[] = [];
  const on = (ms: number, run: () => void) => events.push({ at: ms, run });
  const safely = (run: () => void) => () => {
    try {
      run();
    } catch {
      // A refused action in history is recorded by the engine; nothing else to do.
    }
  };

  const newOrder = (customerId: string, productId: string): OrderRecord => {
    const p = s.products.find(item => item.id === productId)!;
    const record: OrderRecord = {
      order: {
        id: ids.next('ord', 2000),
        merchantId: s.merchant.id,
        customerId,
        productId,
        productRevision: p.revision,
        productName: p.name,
        total: p.prices[0],
        refundedMinor: '0',
        status: 'open',
        rail: 'whitechain',
        paymentId: ids.tx(),
        providerSessionId: null,
        createdAt: iso(now(s)),
      },
      payerAddress: null,
      txHash: null,
      feeMinor: 0n,
      paidAt: null,
      refunds: [],
      activity: [{ type: 'order.created', at: iso(now(s)), detail: 'Checkout started', txHash: null }],
    };
    s.orders.unshift(record);
    return record;
  };
  const purchase = (customerId: string, productId: string) => {
    const record = newOrder(customerId, productId);
    try {
      payOrder(s, record, byId(customerId));
    } catch (error) {
      // An abandoned checkout: the session expired without a payment.
      record.order.status = 'expired';
      throw error;
    }
    return record;
  };

  // Subscriptions start before the 14-day window so renewals land inside it.
  on(
    start + 1 * DAY + 3 * HOUR,
    safely(() => subscribe(s, byId('cus_northwind'), s.plans[1])),
  );
  on(
    start + 2 * DAY + 5 * HOUR,
    safely(() => {
      subscribe(s, byId('cus_orbit'), s.plans[0]);
      byId('cus_orbit').balanceMinor = USDT(12);
    }),
  );
  on(
    start + 3 * DAY + 9 * HOUR,
    safely(() => subscribe(s, byId('cus_tideworks'), s.plans[0])),
  );
  on(
    start + 8 * DAY + 2 * HOUR,
    safely(() => {
      subscribe(s, byId('cus_bluebird'), s.plans[0]);
    }),
  );
  on(
    start + 9 * DAY + 4 * HOUR,
    safely(() => subscribe(s, byId('cus_monograph'), s.plans[2])),
  );
  on(
    start + 20 * DAY + 6 * HOUR,
    safely(() => subscribe(s, byId(DEMO.customerId), s.plans[2])),
  );
  on(
    start + 21 * DAY,
    safely(() =>
      cancelSubscription(
        s,
        s.subscriptions.find(sub => sub.customerId === 'cus_tideworks')!,
      ),
    ),
  );

  // Invoices.
  const invoice = (
    id: string,
    number: string,
    customerId: string,
    lines: Array<[string, number, number]>,
    createdAt: number,
    dueAt: number,
    allowPartial: boolean,
  ): InvoiceRecord => {
    const c = byId(customerId);
    const total = lines.reduce((sum, [, qty, price]) => sum + USDT(price) * BigInt(qty), 0n);
    const record: InvoiceRecord = {
      invoice: {
        id,
        status: 'draft',
        hostedUrl: `/invoice/${id}`,
        customerEmail: c.email,
        amount: dec6(total),
        paid: dec6(0n),
        remaining: dec6(total),
        allowPartial,
        dueAt: iso(dueAt),
        memo: '',
        metadata: {},
        createdAt: iso(createdAt),
        lines: lines.map(([description, quantity, price], index) => ({
          id: `${id}_l${index + 1}`,
          description,
          quantity,
          unitAmount: dec6(USDT(price)),
          amount: dec6(USDT(price) * BigInt(quantity)),
        })),
      },
      number,
      customerId,
      customerName: c.company,
      acknowledgement: null,
      reminders: reminderSchedule(dueAt),
      activity: [{ type: 'created', at: iso(createdAt), detail: 'Invoice created' }],
    };
    s.invoices.unshift(record);
    return record;
  };
  const send = (record: InvoiceRecord) => {
    record.invoice.status = 'sent';
    record.activity.push({
      type: 'sent',
      at: iso(now(s)),
      detail: `Sent to ${record.invoice.customerEmail}`,
    });
  };
  const acknowledge = (record: InvoiceRecord) => {
    const c = byId(record.customerId);
    const signed = sponsor(s, {
      action: 'invoice_acknowledge',
      objectId: `${record.invoice.id}:ack`,
      label: `Acknowledgement of ${record.number}`,
      payer: c.address,
    });
    record.acknowledgement = {
      signedAt: iso(now(s)),
      signer: c.address,
      txHash: signed.ok ? signed.txHash : null,
    };
    if (record.invoice.status === 'sent') record.invoice.status = 'acknowledged';
    record.activity.push({
      type: 'acknowledged',
      at: iso(now(s)),
      detail: `${c.name} signed “I owe this invoice”`,
      txHash: signed.ok ? signed.txHash : null,
    });
  };

  on(realNow - 35 * DAY, () => {
    const r = invoice(
      'inv_1039',
      'INV-1039',
      'cus_orbit',
      [['Accessibility fixes', 4, 80]],
      now(s),
      realNow - 3 * DAY,
      false,
    );
    send(r);
  });
  on(realNow - 25 * DAY, () => {
    const r = invoice(
      'inv_1041',
      'INV-1041',
      'cus_northwind',
      [
        ['Checkout redesign, phase 1', 1, 2_000],
        ['QA and launch support', 4, 100],
      ],
      now(s),
      realNow + 5 * DAY,
      false,
    );
    send(r);
  });
  on(realNow - 24 * DAY, () => acknowledge(s.invoices.find(i => i.invoice.id === 'inv_1041')!));
  on(realNow - 20 * DAY, () => {
    const r = invoice(
      'inv_1040',
      'INV-1040',
      'cus_bluebird',
      [['Patient portal audit', 1, 960]],
      now(s),
      realNow + 4 * DAY,
      true,
    );
    send(r);
  });
  on(
    realNow - 6 * DAY - 2 * HOUR,
    safely(() =>
      payInvoice(
        s,
        s.invoices.find(i => i.invoice.id === 'inv_1040')!,
        byId('cus_bluebird'),
        USDT(480),
      ),
    ),
  );
  on(
    realNow - 6 * DAY,
    safely(() =>
      payInvoice(
        s,
        s.invoices.find(i => i.invoice.id === 'inv_1041')!,
        byId('cus_northwind'),
        USDT(2_400),
      ),
    ),
  );
  on(realNow - 26 * HOUR, () =>
    invoice(
      'inv_1043',
      'INV-1043',
      'cus_monograph',
      [['Brand system refresh', 1, 1_750]],
      now(s),
      realNow + 21 * DAY,
      false,
    ),
  );
  on(realNow - 3 * HOUR, () => {
    // The story's invoice: 1,000 USDT, due at the end of the day 30 days from now.
    const due = new Date(realNow + 30 * DAY);
    due.setUTCHours(23, 59, 0, 0);
    const r = invoice(
      DEMO.invoiceId,
      'INV-1042',
      DEMO.customerId,
      [
        ['Platform integration, milestone 2', 1, 800],
        ['Support retainer, November', 1, 200],
      ],
      now(s),
      due.getTime(),
      true,
    );
    r.invoice.memo = 'Thanks for working with us. Milestone 2 covers the payments API and webhooks.';
    send(r);
  });

  // Fourteen days of storefront activity.
  const buyers = ['cus_northwind', 'cus_bluebird', 'cus_monograph', 'cus_tideworks'];
  const todayStart = new Date(realNow).setUTCHours(0, 0, 0, 0);
  const goods = ['prod_audit', 'prod_support', 'prod_support', 'prod_toolkit', 'prod_toolkit', 'prod_sprint'];
  for (let day = 14; day >= 1; day--) {
    const base = realNow - day * DAY;
    const count = random.int(1, 3);
    for (let i = 0; i < count; i++) {
      on(
        base + random.int(8, 20) * HOUR + random.int(0, 59) * 60_000,
        safely(() => purchase(random.pick(buyers), random.pick(goods))),
      );
    }
    // The pricing bot pulls usage reports through the day; the research agent scores invoices.
    for (let i = 0; i < random.int(10, 16); i++) {
      on(base + random.int(6, 22) * HOUR + random.int(0, 59) * 60_000, () =>
        agentCall(s, pricing, s.endpoints[1], s.merchant, '/api/usage-report?team=pricing'),
      );
    }
    for (let i = 0; i < random.int(5, 9); i++) {
      const when = base + random.int(9, 18) * HOUR + random.int(0, 59) * 60_000;
      // Keep today clear so the demo's ten calls fit under the research agent's daily cap.
      if (when < todayStart)
        on(when, () =>
          agentCall(
            s,
            research,
            s.endpoints[0],
            s.merchant,
            `/api/risk-score?invoice=INV-${random.int(880, 990)}`,
          ),
        );
    }
  }

  // Story beats in history.
  on(
    realNow - 12 * DAY,
    safely(() => {
      const r = purchase('cus_tideworks', 'prod_audit');
      on(
        realNow - 11 * DAY,
        safely(() => refundOrder(s, r, USDT(490), 'Project cancelled')),
      );
      on(
        realNow - 11 * DAY + HOUR,
        safely(() => refundOrder(s, r, USDT(50), 'Duplicate request')),
      );
    }),
  );
  on(
    realNow - 10 * DAY,
    safely(() => {
      const r = purchase('cus_bluebird', 'prod_sprint');
      on(
        realNow - 9 * DAY,
        safely(() => refundOrder(s, r, USDT(200), 'Sprint shortened to four days')),
      );
    }),
  );
  on(
    realNow - 5 * DAY,
    safely(() => purchase(DEMO.customerId, 'prod_toolkit')),
  );
  // Two checkouts that were opened and never paid.
  const abandoned: Array<[number, string, string]> = [
    [8, 'cus_monograph', 'prod_sprint'],
    [3, 'cus_northwind', 'prod_audit'],
  ];
  for (const [day, buyer, item] of abandoned) {
    on(realNow - day * DAY + 5 * HOUR, () => {
      newOrder(buyer, item).order.status = 'expired';
    });
  }
  // A couple of sales in the last hours, so "today" is not empty when the demo opens.
  on(
    realNow - 95 * 60_000,
    safely(() => purchase('cus_monograph', 'prod_support')),
  );
  on(
    realNow - 25 * 60_000,
    safely(() => purchase('cus_northwind', 'prod_audit')),
  );
  on(realNow - 6 * DAY + 2 * HOUR, () => {
    const sub = s.subscriptions.find(item => item.customerId === 'cus_northwind');
    if (sub) chargeSubscription(s, sub, { source: 'merchant' });
  });
  on(realNow - 4 * DAY, () => {
    const sub = s.subscriptions.find(item => item.customerId === 'cus_monograph');
    if (sub) chargeSubscription(s, sub, { source: 'merchant', amount: USDT(199) });
  });
  // Bluebird's card-funded balance runs low just before its renewal, so it goes past due.
  on(realNow - 2 * DAY - HOUR, () => {
    byId('cus_bluebird').balanceMinor = USDT(20);
  });
  // A pricing-bot burst that runs into its daily cap.
  on(realNow - 2 * DAY + 20 * HOUR, () => {
    for (let i = 0; i < 8; i++)
      agentCall(s, pricing, s.endpoints[1], s.merchant, '/api/usage-report?team=pricing&full=1');
  });
  // The procurement bot tries a merchant it was never allowed to pay.
  on(realNow - 8 * DAY, () =>
    agentCall(s, procurement, s.endpoints[0], s.otherMerchant, '/api/risk-score?invoice=HG-12'),
  );
  // Background sponsorship refusals from probing traffic.
  const probes: Array<[number, string]> = [
    [13, 'replay'],
    [11, 'dust'],
    [9, 'wrong_selector'],
    [7, 'payer_daily_cap'],
    [5, 'amount_below_fee'],
    [3, 'deadline'],
    [1, 'replay'],
  ];
  for (const [day, reason] of probes) {
    on(realNow - day * DAY + random.int(1, 23) * HOUR, () =>
      refusal(s, { source: 'sponsorship', reason, objectId: ids.tx(), actor: ids.address() }),
    );
  }
  // An account nobody knows signs a refund that would spend the merchant's USDT.
  on(realNow - 4 * DAY + 6 * HOUR, () =>
    refusal(s, { source: 'sponsorship', reason: 'signer_not_merchant', objectId: ids.tx(), actor: ids.address() }),
  );

  // Story beats may schedule follow-ups while running, so always take the earliest pending event.
  const done = new Set<Event>();
  for (;;) {
    let next: Event | undefined;
    for (const event of events) if (!done.has(event) && (!next || event.at < next.at)) next = event;
    if (!next) break;
    done.add(next);
    at(next.at);
    next.run();
  }

  setNow(s, realNow);
  tick(s);
  // One delivery that needed a retry, for the webhook log.
  const retried = s.webhookDeliveries.find(d => d.status === 'delivered');
  if (retried)
    s.webhookDeliveries.splice(s.webhookDeliveries.indexOf(retried) + 1, 0, {
      ...retried,
      id: `${retried.id}a`,
      attempt: 1,
      status: 'failed',
      last_http_status: 503,
      last_error: 'Service unavailable',
      delivered_at: null,
    });
  if (retried) retried.attempt = 2;
  s.commerceExtras = seedCommerceExtras(s);
  s.financing = seedFinancing(s);
  s.lab = seedLab(s);
  return s;
}

registerFactory(createStore);
