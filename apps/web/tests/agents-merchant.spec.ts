import { expect, test, viewAs } from './helpers';

test('merchant sees the agents paying them and simulates a paid request', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/agents');
  await expect(page.getByRole('heading', { name: 'Agents paying you' })).toBeVisible();
  const claims = page.getByRole('heading', { name: /Claims assistant/ });
  await expect(claims).toBeVisible();
  await expect(page.getByText('Caps set by Bluebird Health. Read-only here', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Simulate a request' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Paid and answered/).check();
  await dialog.getByRole('button', { name: 'Send request' }).click();
  await expect(dialog.getByText('Paid and answered: $0.01 settled')).toBeVisible();

  await dialog.getByRole('link', { name: 'View trace' }).click();
  await expect(page).toHaveURL(/\/dashboard\/agents\/requests\/call_/);
  await expect(page.locator('h1')).toContainText('Settled');
  await expect(page.getByText(/402 Payment Required: \$0\.01 USDT/)).toBeVisible();
  await expect(page.getByText('Response body')).toBeVisible();
});

test('an over-cap request is refused before payment and the trace shows where it stopped', async ({
  page,
}) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/agents');
  await page.getByRole('button', { name: 'Simulate a request' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Over the owner’s cap/).check();
  await dialog.getByRole('button', { name: 'Send request' }).click();
  await expect(dialog.getByText('Refused before payment: PerCallCap')).toBeVisible();

  await dialog.getByRole('link', { name: 'View trace' }).click();
  await expect(page).toHaveURL(/\/dashboard\/agents\/requests\/call_/);
  await expect(page.locator('h1')).toContainText('Refused');
  await expect(page.getByText(/Refused by the agent account: PerCallCap/)).toBeVisible();
  await expect(page.getByText('Not reached. Nothing was charged.')).toBeVisible();
  await expect(page.getByText('None: refused before payment')).toBeVisible();

  // The refusal is listed on the agents page too.
  await page.getByRole('link', { name: 'Agents paying you' }).click();
  await expect(page.getByRole('row', { name: /Claims assistant.*PerCallCap/ }).first()).toBeVisible();
});

test('an agent without enough funds is refused at settlement', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/agents');
  await page.getByRole('button', { name: 'Simulate a request' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/Not enough funds/).check();
  await dialog.getByRole('button', { name: 'Send request' }).click();
  await expect(dialog.getByText('Refused before payment: InsufficientFunds')).toBeVisible();
  await dialog.getByRole('link', { name: 'View trace' }).click();
  await expect(page.getByText(/Refused by the facilitator: InsufficientFunds/)).toBeVisible();
});

test('request req_001 shows a completed 402, payment and response with an explorer link', async ({
  page,
}) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/agents/requests/req_001');
  await expect(page.locator('h1')).toContainText('req_001');
  await expect(page.locator('h1')).toContainText('Settled');
  await expect(page.getByText(/Signed with the agent’s session key/)).toBeVisible();
  const record = page.locator('a[href^="/demo/explorer/tx/"]').first();
  await expect(record).toBeVisible();
  const href = await record.getAttribute('href');
  await page.goto(href!);
  await expect(page.getByRole('heading', { name: 'Transaction details' })).toBeVisible();
});
