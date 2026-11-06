import { confirmPasskey, expect, test, viewAs } from './helpers';

test('merchant finishes setup, creates a product and shares its hosted link', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/onboarding');
  await expect(page.getByRole('heading', { name: 'Sign the fee terms and refund permits' })).toBeVisible();

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

test('fees show the signed rates, and an unsigned merchant signs the terms, then both permits', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/fees');
  await expect(page.getByText('0.80% of each payment, at least $0.15', { exact: true })).toBeVisible();
  await expect(page.getByText('0.50% of each payment, at least $0.15, at most $10.00', { exact: true })).toBeVisible();
  await expect(page.getByText('On a $100.00 checkout payment, Pact takes $0.80 and you receive $99.20.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ready' })).toBeVisible();

  await page.getByLabel('Review scenario').selectOption('terms-unsigned');
  await expect(page.getByRole('button', { name: 'Sign fee terms' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign fee terms' }).click();
  await confirmPasskey(page);
  await expect(page.getByText('Fee terms signed')).toBeVisible();
  await page.getByRole('button', { name: 'Sign the two refund permits' }).click();
  await confirmPasskey(page);
  await confirmPasskey(page);
  await expect(page.getByText('Refund permits signed')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ready' })).toBeVisible();
});
