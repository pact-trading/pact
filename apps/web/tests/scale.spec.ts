import { expect, test, viewAs } from './helpers';

test('AI agent pays ten x402 calls in USDT and the eleventh is refused over its daily cap', async ({ page }) => {
  await viewAs(page, 'customer');
  await page.goto('/portal/agents/agt_research');
  await page.getByRole('button', { name: 'Run the agent: 11 paid calls' }).click();
  await expect(page.getByText('10 paid, 1 refused')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/Refused by the agent account: DailyCap/)).toBeVisible();

  await viewAs(page, 'merchant');
  await page.goto('/dashboard/paid-api');
  await expect(page.getByRole('cell', { name: /Research agent/ }).first()).toBeVisible();
});

test('drain attack: every attempt is refused and the tank does not move', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/security');
  await page.getByRole('button', { name: 'Run the drain attack' }).click();
  await expect(page.getByText(/All \d+ attempts refused/)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Unchanged. Only real payments move the tank.')).toBeVisible();
});

test('accountant gets a read-only view and an export that reconciles', async ({ page }) => {
  await viewAs(page, 'accountant');
  await page.goto('/dashboard/exports');
  await expect(page.getByText('Reconciles with the chain')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Products' })).toHaveCount(0);

  const csv = await page.request.get('/api/export?format=csv');
  expect(csv.status()).toBe(200);
  const body = await csv.text();
  expect(body.split('\r\n')[0]).toContain('"Date (UTC)","Type"');
  expect(body).toContain('"TOTAL"');

  await page.goto('/dashboard/invoices');
  await expect(page.getByRole('link', { name: 'New invoice' })).toHaveCount(0);
});
