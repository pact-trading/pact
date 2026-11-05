import { api, base, open, readyMerchant, testCustomer, testnet } from './lib.mjs';
const t = await open(process.argv[2]);
const { page, step, shot, call, errors } = t;
try {
  await readyMerchant(t);
  const product = await step('merchant: create product', () =>
    call('merchant', '/v1/commerce/products', {
      name: 'API access',
      status: 'active',
      prices: [{ currency: 'USDT', amountMinor: '1000000' }],
    }),
  );
  await testCustomer(t, 'agent-owner@example.test');
  await step('customer: become a customer of the business', async () => {
    // Starting a checkout records the customer with the business, which an agent may then pay.
    const token = await t.cookie('pact_session');
    const r = await fetch(`${api}/v1/commerce/checkout-sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': `k${Date.now()}`,
      },
      body: JSON.stringify({ productId: product.id, rail: 'whitechain' }),
    });
    if (!r.ok) throw new Error(`checkout ${r.status}`);
  });
  await step('customer: create an agent (two signatures, no gas)', async () => {
    await page.goto(`${base}/portal/agents`);
    await page.getByRole('button', { name: 'Create agent' }).click();
    await page.waitForURL(/\/portal\/agents\/agt_/, { timeout: 120000 });
    await shot('40-agent');
  });
  await step('customer: add USDT to the agent', async () => {
    // Testnet: the business wallet in this browser swaps 0.02 WBT straight into the agent account.
    const [button, toast] = testnet
      ? ['Swap 0.02 WBT into it', 'USDT swapped into the agent account']
      : ['Add 1 test USDT', '1 test USDT added to the agent account'];
    await page.getByRole('button', { name: button }).click();
    await page.getByText(toast).waitFor({ timeout: 120000 });
  });
  await step('customer: run 11 paid calls', async () => {
    await page.getByRole('button', { name: 'Run the agent: 11 paid calls' }).click();
    await page.waitForTimeout(2000);
    for (let i = 0; i < 120; i++) {
      const { data } = await call('customer', '/v1/commerce/me/agents');
      const detail = await call('customer', `/v1/commerce/me/agents/${data[0].id}`);
      if (detail.calls.length >= 11) {
        console.log(
          `  ${detail.calls
            .map(c => (c.status === 'settled' ? 'ok' : c.reason))
            .reverse()
            .join(' ')}`,
        );
        break;
      }
      await page.waitForTimeout(1000);
    }
    await page.waitForTimeout(3000);
    await shot('41-agent-run');
  });
  await step('merchant: paid API and agents pages', async () => {
    await page.getByRole('button', { name: /^Business 0x/ }).click();
    await page.waitForURL(`${base}/dashboard`);
    await page.goto(`${base}/dashboard/paid-api`);
    await page.waitForTimeout(1500);
    await shot('42-paid-api');
    await page.goto(`${base}/dashboard/agents`);
    await page.waitForTimeout(1500);
    await shot('43-merchant-agents');
  });
} finally {
  console.log(errors.length ? `browser errors:\n${errors.join('\n')}` : 'no browser errors');
  await t.browser.close();
}
