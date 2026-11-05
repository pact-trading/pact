import { base, open, readyMerchant, testCustomer } from './lib.mjs';
const t = await open(process.argv[2]);
const { page, call } = t;
const perPage = new Map();
let current = '';
page.on('pageerror', e => perPage.set(current, [...(perPage.get(current) ?? []), e.message.slice(0, 160)]));
page.on('console', m => {
  if (m.type() === 'error' && !/privy|Failed to load resource|favicon/i.test(m.text()))
    perPage.set(current, [...(perPage.get(current) ?? []), `console: ${m.text().slice(0, 160)}`]);
});
const visit = async path => {
  current = path;
  const response = await page.goto(`${base}${path}`);
  await page.waitForTimeout(1200);
  const notWired = await page.getByText('Not connected yet').count();
  const status = response?.status();
  if (status && status >= 400) perPage.set(path, [...(perPage.get(path) ?? []), `HTTP ${status}`]);
  if (notWired) perPage.set(path, [...(perPage.get(path) ?? []), 'shows "Not connected yet"']);
};
try {
  await readyMerchant(t);
  const product = await call('merchant', '/v1/commerce/products', {
    name: 'Sweep product',
    status: 'active',
    prices: [{ currency: 'USDT', amountMinor: '2000000' }],
  });
  const plan = await call('merchant', '/v1/subscriptions/plans', {
    name: 'Sweep plan',
    amount: '2',
    periodSeconds: 600,
  });
  const invoice = await call('merchant', '/v1/invoices?expand=detail', {
    customerEmail: 'sweeper@example.test',
    amount: '3',
    dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  });
  const link = await call('merchant', '/v1/payment-links', {
    kind: 'product',
    name: 'Sweep link',
    amount: '2',
  });
  for (const path of [
    '/dashboard',
    '/dashboard/onboarding',
    '/dashboard/products',
    `/dashboard/products/${product.id}`,
    '/dashboard/orders',
    '/dashboard/orders/new',
    '/dashboard/customers',
    '/dashboard/invoices',
    '/dashboard/invoices/new',
    `/dashboard/invoices/${invoice.id}`,
    '/dashboard/payment-links',
    '/dashboard/payment-links/new',
    `/dashboard/payment-links/${link.id}`,
    '/dashboard/plans',
    '/dashboard/plans/new',
    '/dashboard/subscriptions',
    '/dashboard/refunds',
    '/dashboard/gas-tank',
    '/dashboard/security',
    '/dashboard/paid-api',
    '/dashboard/agents',
    '/dashboard/developers',
    '/dashboard/exports',
    '/dashboard/settings',
    '/dashboard/financing',
  ])
    await visit(path);
  await testCustomer(t, 'sweeper@example.test');
  for (const path of [
    '/portal',
    '/portal/purchases',
    '/portal/subscriptions',
    '/portal/invoices',
    '/portal/agents',
    '/portal/account',
    `/buy/${product.id}`,
    `/subscribe/${plan.id}`,
    `/invoice/${invoice.id}`,
    `/l/${link.id}`,
  ])
    await visit(path);
} finally {
  for (const [path, errors] of perPage) console.log(`${path}: ${[...new Set(errors)].join(' | ')}`);
  if (!perPage.size) console.log('no errors on any page');
  await t.browser.close();
}
