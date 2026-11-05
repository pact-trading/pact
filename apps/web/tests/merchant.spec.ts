import { expect, test, viewAs } from './helpers';

test('merchant finishes setup, creates a product and shares its hosted link', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/onboarding');
  await expect(page.getByRole('heading', { name: 'Fund your gas tank' })).toBeVisible();

  await page.goto('/dashboard/products');
  await page.getByRole('button', { name: 'New product' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Launch review');
  await dialog.getByLabel('Price').fill('250');
  await dialog.getByRole('button', { name: 'Create product' }).click();

  await expect(page).toHaveURL(/\/dashboard\/products\/prod_/);
  await expect(page.getByRole('heading', { name: 'Launch review' })).toBeVisible();
  await page.getByRole('button', { name: 'Share' }).click();
  await expect(page.getByRole('img', { name: /QR code for/ })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('/buy/prod_');
});

test('gas tank shows runway and refuses a second faucet claim the same day', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/gas-tank');
  await expect(page.getByText('days of runway', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Top up 0.5 WBT from the faucet' }).click();
  await expect(page.getByText('0.5 WBT added to your gas tank')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Top up 0.5 WBT from the faucet' })).toBeDisabled();
});
