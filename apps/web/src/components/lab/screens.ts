import type { ViewerRole } from '@pactagent/core/platform-types';
import type { LabExamples } from '@/server/data/parts/lab';

/** Seeded ids, matching DEMO in server/data/mock/fixtures.ts. */
export interface ScreenIds extends LabExamples {
  customerId: string;
  agentId: string;
  invoiceId: string;
  planId: string;
  productId: string;
}

export interface Screen {
  title: string;
  /** The example path, with seeded ids filled in. */
  path: string;
  /** Who opens it; null for public pages. */
  role: ViewerRole | null;
  note?: string;
}

export interface ScreenArea {
  area: string;
  description: string;
  screens: Screen[];
}

/** Every screen in the app, grouped by area, with a working example from the seeded story. */
export function screenAreas(ids: ScreenIds): ScreenArea[] {
  const order = ids.storeOrderId;
  const sub = ids.subscriptionId;
  const m = (title: string, path: string, note?: string): Screen => ({ title, path, role: 'merchant', note });
  const c = (title: string, path: string, note?: string): Screen => ({ title, path, role: 'customer', note });
  const pub = (title: string, path: string, note?: string): Screen => ({ title, path, role: null, note });
  const areas: ScreenArea[] = [
    {
      area: 'Public and sign-in',
      description: 'Pages anyone can open.',
      screens: [
        pub('Home', '/'),
        pub('Demo viewpoints', '/demo', 'Pick who you are'),
        pub('Sign in', '/login'),
        pub('Terms', '/legal/terms'),
        pub('Privacy', '/legal/privacy'),
      ],
    },
    {
      area: 'Merchant: sell',
      description: 'Maya Chen runs Kite Labs.',
      screens: [
        m('Overview', '/dashboard'),
        m('Onboarding', '/dashboard/onboarding'),
        m('Products', '/dashboard/products'),
        m('Product detail', `/dashboard/products/${ids.productId}`),
        m('Orders and payments', '/dashboard/orders'),
        ...(order ? [m('Order detail', `/dashboard/orders/${order}`, 'Jordan’s toolkit order')] : []),
        m('New order', '/dashboard/orders/new'),
        m('Payment links', '/dashboard/payment-links'),
        m('New payment link', '/dashboard/payment-links/new'),
        m('Payment link detail', '/dashboard/payment-links/link_audit_deposit'),
        m('Refunds', '/dashboard/refunds'),
        m('Customers', '/dashboard/customers'),
        m('Customer detail', `/dashboard/customers/${ids.customerId}`),
      ],
    },
    {
      area: 'Merchant: bill',
      description: 'Invoices, plans and subscriptions.',
      screens: [
        m('Invoices', '/dashboard/invoices'),
        m('New invoice', '/dashboard/invoices/new'),
        m('Invoice detail', `/dashboard/invoices/${ids.invoiceId}`),
        m('Plans', '/dashboard/plans'),
        m('New plan', '/dashboard/plans/new'),
        m('Subscriptions', '/dashboard/subscriptions'),
        ...(sub ? [m('Subscription detail', `/dashboard/subscriptions/${sub}`)] : []),
        m('Invoice financing', '/dashboard/financing'),
        m('Financing detail', '/dashboard/financing/inv_1060', 'Eligible, ready to list'),
        m('Financing in grace', '/dashboard/financing/inv_1051', 'Past maturity; +7 days defaults it'),
      ],
    },
    {
      area: 'Merchant: operate',
      description: 'Agents, fees, security, books and settings.',
      screens: [
        m('Paid API', '/dashboard/paid-api'),
        m('Agent budgets', '/dashboard/agents'),
        m('Agent request', '/dashboard/agents/requests/req_001'),
        m('Fees', '/dashboard/fees'),
        m('Security', '/dashboard/security', 'Run the drain attack'),
        {
          title: 'Accounting and exports',
          path: '/dashboard/exports',
          role: 'accountant',
          note: 'Read-only',
        },
        m('Settings', '/dashboard/settings'),
      ],
    },
    {
      area: 'Customer: pay',
      description: 'Jordan Lee pays Kite Labs. Dollars only, no crypto steps.',
      screens: [
        c('Product checkout', `/buy/${ids.productId}`, 'Continue opens the checkout'),
        c('Subscribe to a plan', `/subscribe/${ids.planId}`),
        c('Invoice to pay', `/invoice/${ids.invoiceId}`),
        c('Payment link', '/l/link_audit_deposit'),
        c('Tip jar link', '/l/link_tip_jar'),
        c('Order to pay', '/pay/ord_manual_1'),
      ],
    },
    {
      area: 'Customer: portal',
      description: 'Receipts, subscriptions, invoices and agents.',
      screens: [
        c('Portal overview', '/portal'),
        c('Purchases', '/portal/purchases'),
        ...(order ? [c('Receipt', `/portal/purchases/${order}`)] : []),
        c('Subscriptions', '/portal/subscriptions'),
        ...(sub ? [c('Subscription detail', `/portal/subscriptions/${sub}`)] : []),
        c('Invoices', '/portal/invoices'),
        c('AI agents', '/portal/agents'),
        c('Agent detail', `/portal/agents/${ids.agentId}`, 'Run the agent'),
        c('Account', '/portal/account'),
      ],
    },
    {
      area: 'Investor',
      description: 'Arjun Mehta at Lotus Capital funds invoices.',
      screens: [
        { title: 'Marketplace', path: '/investor', role: 'investor' },
        {
          title: 'Investment detail',
          path: '/investor/invoices/inv_1057',
          role: 'investor',
          note: 'Part sold',
        },
        {
          title: 'Position, split',
          path: '/investor/invoices/inv_1055',
          role: 'investor',
          note: 'Transfer it',
        },
        { title: 'Portfolio', path: '/investor/portfolio', role: 'investor' },
      ],
    },
    {
      area: 'Compliance',
      description: 'Elena Novak keeps the investor registry the receivable token checks.',
      screens: [
        { title: 'Investor registry', path: '/compliance', role: 'compliance', note: 'Approve Northgate' },
      ],
    },
    {
      area: 'Developer',
      description: 'Integrate Pact into a separate app.',
      screens: [
        pub('Checkout playground', '/playground'),
        m('Integration hub', '/dashboard/developers'),
        m('Webhook log', '/dashboard/developers?tab=webhooks', 'Simulate deliveries'),
        pub('Quickstart', '/docs'),
        c('Demo storefront', '/demo/store'),
        ...(order ? [c('Store confirmation', `/demo/store/orders/${order}`)] : []),
      ],
    },
    {
      area: 'Demo tools',
      description: 'Review aids that exist only with mock data.',
      screens: [
        pub('Screens index', '/demo/screens'),
        ...(ids.txHash ? [pub('Mock explorer transaction', `/demo/explorer/tx/${ids.txHash}`)] : []),
      ],
    },
  ];
  return areas;
}

/** Opens the screen as the right viewer, through the shareable /demo/as link. */
export const screenHref = (screen: Screen) =>
  screen.role ? `/demo/as/${screen.role}?next=${encodeURIComponent(screen.path)}` : screen.path;
