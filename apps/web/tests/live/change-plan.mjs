import { base, fundCustomer, open, readyMerchant, testCustomer } from './lib.mjs';
const t = await open(process.argv[2]);
const { page, step, shot, call, errors } = t;
const wait = ms => new Promise(r => setTimeout(r, ms));
try {
  await readyMerchant(t);
  const basic = await step('merchant: two plans', async () => {
    const b = await call('merchant', '/v1/subscriptions/plans', {
      name: 'Basic',
      amount: '2',
      periodSeconds: 600,
      maxPeriods: 6,
    });
    await call('merchant', '/v1/subscriptions/plans', {
      name: 'Pro',
      amount: '5',
      periodSeconds: 600,
      maxPeriods: 6,
    });
    return b;
  });
  await testCustomer(t, 'switcher@example.test');
  await fundCustomer(t, '60');
  const sub = await step('customer: subscribe to Basic', async () => {
    await page.goto(`${base}/subscribe/${basic.id}`);
    await page.getByRole('button', { name: /^Subscribe ·/ }).click();
    await page
      .getByText(/You’re subscribed|Manage subscription/)
      .first()
      .waitFor({ timeout: 120000 });
    return (await call('customer', '/v1/commerce/me/subscriptions')).data[0];
  });
  await step('customer: switch to Pro (approval, new mandate, swap intent)', async () => {
    await page.goto(`${base}/portal/subscriptions/${sub.id}`);
    const select = page.getByLabel('New plan').first();
    const options = await select.locator('option').allTextContents();
    await select.selectOption({ label: options.find(o => o.includes('Pro')) });
    await page.getByRole('button', { name: 'Switch plan' }).first().click();
    await page
      .getByText(/Switched to Pro/)
      .first()
      .waitFor({ timeout: 120000 });
    await shot('70-switched');
  });
  await step('old plan cancelled, Pro active', async () => {
    let mine;
    for (let i = 0; i < 30; i++) {
      mine = (await call('customer', '/v1/commerce/me/subscriptions')).data;
      if (mine.some(s => s.plan === 'Pro' && s.status === 'active')) break;
      await wait(1000);
    }
    console.log(`  ${mine.map(s => `${s.plan}:${s.status}`).join(', ')}`);
    if (
      !mine.some(s => s.plan === 'Pro' && s.status === 'active') ||
      !mine.some(s => s.plan === 'Basic' && s.status === 'cancelled')
    )
      throw new Error('plan change did not settle');
  });
} finally {
  console.log(errors.length ? `browser errors:\n${errors.join('\n')}` : 'no browser errors');
  await t.browser.close();
}
