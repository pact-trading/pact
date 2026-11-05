import { base, fundCustomer, open, readyMerchant, testCustomer } from './lib.mjs';
const t = await open(process.argv[2]);
const { page, step, shot, call, errors } = t;
const wait = ms => new Promise(r => setTimeout(r, ms));
try {
  await readyMerchant(t);
  const plan = await step('merchant: create a 2-minute plan', () =>
    call('merchant', '/v1/subscriptions/plans', {
      name: 'API Growth',
      description: 'Paid API access',
      amount: '5',
      periodSeconds: 120,
      maxPeriods: 6,
    }),
  );
  await testCustomer(t, 'subscriber@example.test');
  await fundCustomer(t, '40');
  await step('customer: subscribe (approval + mandate, one click)', async () => {
    await page.goto(`${base}/subscribe/${plan.id}`);
    await shot('20-subscribe');
    await page.getByRole('button', { name: /^Subscribe ·/ }).click();
    await page
      .getByText(/You’re subscribed|Manage subscription|Subscribed/)
      .first()
      .waitFor({ timeout: 120000 });
    await shot('21-subscribed');
  });
  const sub = await step('keeper charges the first period', async () => {
    for (let i = 0; i < 60; i++) {
      const [s] = (await call('customer', '/v1/commerce/me/subscriptions')).data;
      if (s?.periodsCharged >= 1) return s;
      await wait(1000);
    }
    throw new Error('first period was not charged');
  });
  await step('merchant: an early pull is refused on chain', async () => {
    await page.getByRole('button', { name: /^Business 0x/ }).click();
    await page.waitForURL(`${base}/dashboard`);
    await page.goto(`${base}/dashboard/subscriptions/${sub.id}`);
    await page.getByRole('button', { name: 'Run renewal now' }).click();
    await page.getByText('Refused by the contract: Too early').waitFor({ timeout: 60000 });
    await shot('22-too-early');
  });
  await step('customer: cancel from the portal', async () => {
    await page.getByRole('button', { name: /^Customer / }).click();
    await page.waitForURL(/\/portal/);
    await page.goto(`${base}/portal/subscriptions/${sub.id}`);
    await page.getByRole('button', { name: 'Cancel subscription' }).first().click();
    // The portal may confirm in a dialog.
    const confirm = page.getByRole('dialog').getByRole('button', { name: /Cancel subscription|Confirm/ });
    if (await confirm.count()) await confirm.first().click();
    for (let i = 0; i < 40; i++) {
      const s = await call('customer', `/v1/commerce/me/subscriptions/${sub.id}`);
      if (s.status === 'cancelled') break;
      await wait(1000);
    }
    await page.reload();
    await shot('23-cancelled');
  });
  await step('merchant: a pull after cancel is refused on chain', async () => {
    await page.getByRole('button', { name: /^Business 0x/ }).click();
    await page.waitForURL(`${base}/dashboard`);
    await page.goto(`${base}/dashboard/subscriptions/${sub.id}`);
    await page.getByRole('button', { name: 'Run renewal now' }).click();
    await page.getByText('Refused by the contract: Cancelled').waitFor({ timeout: 60000 });
    await shot('24-after-cancel');
  });
  const detail = await call('merchant', `/v1/subscriptions/${sub.id}`);
  console.log(
    JSON.stringify(
      detail.charges.map(c => `${c.status}${c.reason ? `:${c.reason}` : ''}:${c.txHash ? 'tx' : 'notx'}`),
    ),
  );
} finally {
  console.log(errors.length ? `browser errors:\n${errors.join('\n')}` : 'no browser errors');
  await t.browser.close();
}
