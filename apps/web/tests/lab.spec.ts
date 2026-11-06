import { confirmPasskey, expect, test, viewAs } from './helpers';
import type { Page } from '@playwright/test';

/** Picks a review scenario in the demo bar and waits for the server to apply it. */
async function chooseScenario(page: Page, id: string, banner: RegExp) {
  await page.getByLabel('Review scenario').selectOption(id);
  await expect(page.getByText(banner).first()).toBeVisible();
}

test('the empty scenario shows empty states, and happy brings the data back', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/customers');
  await expect(page.getByRole('link', { name: 'Jordan Lee' })).toBeVisible();
  await chooseScenario(page, 'empty', /Every list reads as empty/);
  await page.goto('/dashboard/customers');
  await expect(page.getByText('No customers found')).toBeVisible();

  await page.getByRole('button', { name: 'Happy path' }).click();
  await expect(page.getByText(/Every list reads as empty/)).toBeHidden();
  await page.goto('/dashboard/customers');
  await expect(page.getByRole('link', { name: 'Jordan Lee' })).toBeVisible();
});

test('the error scenario shows the error state with Retry', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard');
  await chooseScenario(page, 'error', /Every read fails with a 503/);
  await page.goto('/dashboard/customers');
  await expect(page.getByRole('heading', { name: 'This page couldn’t load' })).toBeVisible();
  const retry = page.getByRole('button', { name: 'Retry' });
  await expect(retry).toBeVisible();

  // Still failing while the scenario is on; recovers once it is off.
  await retry.click();
  await expect(page.getByRole('heading', { name: 'This page couldn’t load' })).toBeVisible();
  await page.getByRole('button', { name: 'Happy path' }).click();
  await expect(page.getByText(/Every read fails with a 503/)).toBeHidden();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('link', { name: 'Jordan Lee' })).toBeVisible();
});

test('insufficient funds sends checkout to add funds', async ({ page }) => {
  await viewAs(page, 'customer');
  await page.goto('/demo/store');
  await chooseScenario(page, 'insufficient-funds', /balance drops to \$0/);
  await page.getByRole('button', { name: 'Buy Website audit' }).click();
  await expect(page).toHaveURL(/\/checkout\/cs_/);
  await expect(
    page
      .locator('main')
      .getByText(/add funds/i)
      .first(),
  ).toBeVisible();
});

test('reset returns the scenario to the happy path', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/fees');
  await chooseScenario(page, 'terms-unsigned', /has not signed Pact’s fee terms/);
  await expect(page.getByLabel('Review scenario')).toHaveValue('terms-unsigned');
  await expect(page.getByRole('button', { name: 'Sign fee terms' })).toBeVisible();
  await page.getByRole('button', { name: 'Reset demo data' }).click();
  await expect(page.getByLabel('Review scenario')).toHaveValue('happy');
  await expect(page.getByText(/has not signed Pact’s fee terms/)).toBeHidden();
});

test('a store purchase is fulfilled once and a duplicate webhook is ignored', async ({ page }) => {
  await viewAs(page, 'customer');
  await page.goto('/demo/store');
  await page.getByRole('button', { name: 'Buy Website audit' }).click();
  await expect(page).toHaveURL(/\/checkout\/cs_/);
  const pay = page
    .locator('main')
    .getByRole('button', { name: /Pay \$490\.00/ })
    .first();
  await pay.click();
  await confirmPasskey(page);
  await expect(pay).toBeHidden({ timeout: 10_000 });

  await page.goto('/demo/store');
  await page
    .getByRole('link', { name: /Website audit/ })
    .first()
    .click();
  await expect(page).toHaveURL(/\/demo\/store\/orders\/ord_/);
  // Paid first, then fulfilled when the order.paid webhook reaches the store.
  await expect(page.getByTestId('store-status')).toHaveText(/Fulfilled/, { timeout: 25_000 });
  await expect(page.getByTestId('fulfilments')).toHaveText('1');

  await page.getByRole('button', { name: 'Send duplicate' }).click();
  await expect(page.getByText(/ignored it/)).toBeVisible();
  await expect(page.getByTestId('duplicates')).toHaveText('1');
  await expect(page.getByTestId('fulfilments')).toHaveText('1');
});

test('every screen in the index opens without an error', async ({ page }) => {
  test.setTimeout(420_000);
  await page.goto('/demo/screens');
  await expect(page.getByRole('heading', { name: 'Screens' })).toBeVisible();
  const hrefs = await page
    .locator('a[data-screen-link]')
    .evaluateAll(links => links.map(link => link.getAttribute('href')!));
  expect(hrefs.length).toBeGreaterThan(40);
  const failures: string[] = [];
  for (const href of hrefs) {
    const response = await page.goto(href);
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    const status = response?.status() ?? 0;
    const body = await page.locator('body').innerText();
    if (status >= 400) failures.push(`${href}: HTTP ${status}`);
    else if (/This page couldn’t load|This page could not be found|Application error/.test(body))
      failures.push(`${href}: error page`);
  }
  expect(failures).toEqual([]);
});
