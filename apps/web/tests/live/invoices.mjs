import { base, customerEmail, fundCustomer, open, readyMerchant, testCustomer } from './lib.mjs';
const t = await open(process.argv[2]);
const { page, step, shot, call, errors } = t;
const wait = ms => new Promise(r => setTimeout(r, ms));
try {
  await readyMerchant(t);
  const invoice = await step('merchant: create invoice via API', () =>
    call('merchant', '/v1/invoices?expand=detail', {
      customerEmail: customerEmail('client@acme.test'),
      customerName: 'Jordan Lee',
      dueAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      lines: [{ description: 'Website audit', quantity: 2, unitAmount: '2' }],
    }),
  );
  await step('merchant: invoice list and detail render', async () => {
    await page.goto(`${base}/dashboard/invoices`);
    await page.getByText(invoice.number).first().waitFor({ timeout: 20000 });
    await page.goto(`${base}/dashboard/invoices/${invoice.id}`);
    await page.getByText('Jordan Lee').first().waitFor();
    await shot('30-merchant-invoice');
  });
  await testCustomer(t, 'client@acme.test');
  await fundCustomer(t, '25');
  await step('customer: acknowledge the invoice', async () => {
    await page.goto(`${base}/invoice/${invoice.id}`);
    await shot('31-invoice');
    await page.getByRole('button', { name: 'Acknowledge invoice' }).click();
    for (let i = 0; i < 20; i++) {
      if ((await call('customer', `/v1/commerce/me/invoices/${invoice.id}`)).acknowledgement) break;
      await wait(500);
    }
    const detail = await call('customer', `/v1/commerce/me/invoices/${invoice.id}`);
    if (!detail.acknowledgement) throw new Error('not acknowledged');
  });
  await step('customer: pay the invoice (approval + payment)', async () => {
    await page.reload();
    await page
      .getByRole('button', { name: /^Pay \$4\.00/ })
      .first()
      .click();
    await page.waitForURL(/\/checkout\/hp_/, { timeout: 30000 });
    await page.getByRole('button', { name: /^Pay / }).click();
    await page
      .getByText(/Payment complete/)
      .first()
      .waitFor({ timeout: 120000 });
    await shot('32-invoice-paid');
  });
  await step('merchant: invoice is paid with its activity', async () => {
    let detail;
    for (let i = 0; i < 30; i++) {
      detail = await call('merchant', `/v1/invoices/${invoice.id}?expand=detail`);
      if (detail.status === 'paid') break;
      await wait(1000);
    }
    if (detail.status !== 'paid') throw new Error(`status ${detail.status}`);
    console.log(`  activity: ${detail.activity.map(a => a.type).join(', ')}`);
    await page.getByRole('button', { name: /^Business 0x/ }).click();
    await page.waitForURL(`${base}/dashboard`);
    await page.goto(`${base}/dashboard/invoices/${invoice.id}`);
    await shot('33-merchant-invoice-paid');
  });
} finally {
  console.log(errors.length ? `browser errors:\n${errors.join('\n')}` : 'no browser errors');
  await t.browser.close();
}
