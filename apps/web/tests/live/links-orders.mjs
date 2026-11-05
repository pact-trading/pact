import { base, customerEmail, fundCustomer, open, readyMerchant, testCustomer } from './lib.mjs';
const t = await open(process.argv[2]);
const { page, step, shot, call, errors } = t;
const wait = ms => new Promise(r => setTimeout(r, ms));
try {
  await readyMerchant(t);
  const link = await step('merchant: create a payment link', () =>
    call('merchant', '/v1/payment-links', {
      kind: 'product',
      name: 'Logo design',
      amount: '2',
      description: 'A new logo, two rounds of changes',
    }),
  );
  await step('merchant: links page', async () => {
    await page.goto(`${base}/dashboard/payment-links`);
    await page.getByText('Logo design').first().waitFor({ timeout: 20000 });
    await shot('60-links');
  });
  await testCustomer(t, 'link-buyer@example.test');
  await fundCustomer(t, '25');
  await step('customer: pay through the link', async () => {
    await page.goto(`${base}/l/${link.id}`);
    await shot('61-link-page');
    await page
      .getByRole('button', { name: /^Continue/ })
      .first()
      .click();
    await page.waitForURL(/\/checkout\/hp_/, { timeout: 30000 });
    await page.getByRole('button', { name: /^Pay / }).click();
    await page
      .getByText(/Payment complete/)
      .first()
      .waitFor({ timeout: 120000 });
  });
  const order = await step('merchant: manual order for the customer', async () => {
    await page.getByRole('button', { name: /^Business 0x/ }).click();
    await page.waitForURL(`${base}/dashboard`);
    return call('merchant', '/v1/manual-orders', {
      customer: { kind: 'new', name: 'Link Buyer', email: customerEmail('link-buyer@example.test') },
      lines: [{ productId: null, description: 'Consulting hour', quantity: 2, unitMinor: '1500000' }],
      note: 'Thanks for the call',
    });
  });
  await step('customer: pay the manual order', async () => {
    await page.getByRole('button', { name: /^Customer / }).click();
    await page.waitForURL(/\/portal/);
    await page.goto(`${base}/pay/${order.orderId}`);
    await shot('62-pay-order');
    await page
      .getByRole('button', { name: /^Continue/ })
      .first()
      .click();
    await page.waitForURL(/\/checkout\/hp_/, { timeout: 30000 });
    await page.getByRole('button', { name: /^Pay / }).click();
    await page
      .getByText(/Payment complete/)
      .first()
      .waitFor({ timeout: 120000 });
  });
  await step('merchant: order list, detail and a refund on the manual order', async () => {
    await page.getByRole('button', { name: /^Business 0x/ }).click();
    await page.waitForURL(`${base}/dashboard`);
    for (let i = 0; i < 30; i++) {
      const o = (await call('merchant', '/v1/manual-orders')).data[0];
      if (o.status === 'paid') break;
      await wait(1000);
    }
    await page.goto(`${base}/dashboard/orders`);
    await page.getByText('Consulting hour').first().waitFor({ timeout: 20000 });
    await shot('63-orders');
    await page.goto(`${base}/dashboard/orders/${order.orderId}`);
    await page.getByRole('textbox', { name: 'Amount' }).first().fill('1');
    await page.getByRole('button', { name: 'Refund $1.00' }).first().click();
    await page.getByText('Refund of $1.00 confirmed').first().waitFor({ timeout: 90000 });
    await shot('64-manual-refund');
  });
  await step('merchant: link counts the payment; developers page lists keys', async () => {
    const extras = (await call('merchant', '/v1/payment-links/extras')).data[link.id];
    if (extras.payments !== 1) throw new Error(`link payments ${extras.payments}`);
    await page.goto(`${base}/dashboard/developers`);
    await page.waitForTimeout(1500);
    await shot('65-developers');
  });
} finally {
  console.log(errors.length ? `browser errors:\n${errors.join('\n')}` : 'no browser errors');
  await t.browser.close();
}
