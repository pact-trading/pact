import { base, fundCustomer, open, readyMerchant, testCustomer } from './lib.mjs';
const t = await open(process.argv[2]);
const { page, step, shot, call, errors } = t;
try {
  await readyMerchant(t);
  const product = await step('merchant: create product via API', () =>
    call('merchant', '/v1/commerce/products', {
      name: 'Website audit',
      description: 'A one-off review of your site.',
      status: 'active',
      prices: [{ currency: 'USDT', amountMinor: '3000000' }],
    }),
  );
  await testCustomer(t);
  await fundCustomer(t, '25');
  await step('customer: buy product (approval + payment, one click)', async () => {
    await page.goto(`${base}/buy/${product.id}`);
    await page
      .getByRole('button', { name: /Continue|Pay|Buy/ })
      .first()
      .click();
    await page.waitForURL(/\/checkout\//, { timeout: 30000 });
    await shot('10-checkout');
    await page.getByRole('button', { name: /^Pay / }).click();
    await page
      .getByText(/Payment (received|complete)|Paid|Thank you|Receipt/i)
      .first()
      .waitFor({ timeout: 120000 });
    await shot('11-paid');
  });
  const order = await step('merchant: order is paid on chain', async () => {
    for (let i = 0; i < 30; i++) {
      // The API lists orders by id, not by date: find this product's order.
      const { data } = await call('merchant', '/v1/commerce/orders?limit=100');
      const mine = data.find(o => o.productId === product.id);
      if (mine?.status === 'paid') return mine;
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('order did not become paid');
  });
  await step('merchant: partial refund 1 USDT from the order page', async () => {
    await page.getByRole('button', { name: /^Business 0x/ }).click();
    await page.waitForURL(`${base}/dashboard`);
    await page.goto(`${base}/dashboard/orders/${order.id}`);
    await shot('12-order');
    await page.getByLabel('Amount').fill('1');
    await page.getByRole('button', { name: 'Refund $1.00' }).click();
    await page.getByText('Refund of $1.00 confirmed').first().waitFor({ timeout: 90000 });
  });
  await step('merchant: full refund of the remaining 2 USDT', async () => {
    for (let i = 0; i < 30; i++) {
      await page.reload();
      if (await page.getByText('Up to $2.00 is refundable.').count()) break;
      await page.waitForTimeout(1000);
    }
    await page.getByLabel('Amount').fill('2');
    await page.getByRole('button', { name: 'Refund $2.00' }).click();
    await page.getByText('Refund of $2.00 confirmed').first().waitFor({ timeout: 90000 });
  });
  await step('merchant: a third refund is refused', async () => {
    for (let i = 0; i < 30; i++) {
      await page.reload();
      if (await page.getByText('Fully refunded').count()) break;
      await page.waitForTimeout(1000);
    }
    await page.getByRole('button', { name: 'Try another refund' }).click();
    await page.getByRole('button', { name: 'Refund $1.00' }).click();
    await page.getByText('Refused by the payment contract').first().waitFor({ timeout: 60000 });
    await shot('13-refund-refused');
  });
  await step('customer: portal shows the refunds', async () => {
    await page.getByRole('button', { name: /^Customer / }).click();
    await page.waitForURL(/\/portal/);
    await page.goto(`${base}/portal/purchases/${order.id}`);
    await shot('14-portal-purchase');
  });
  console.log(JSON.stringify({ product: product.id, order: order.id }));
} finally {
  console.log(errors.length ? `browser errors:\n${errors.join('\n')}` : 'no browser errors');
  await t.browser.close();
}
