import { confirmPasskey, expect, test, viewAs } from './helpers';

test('payer acknowledges the invoice, pays part of it, then the rest', async ({ page }) => {
  await viewAs(page, 'customer');
  await page.goto('/invoice/inv_1042');
  await page.getByRole('button', { name: 'Acknowledge invoice' }).click();
  await confirmPasskey(page);
  await expect(page.getByText(/You confirmed you owe this invoice/)).toBeVisible();

  await page.getByLabel('Amount to pay').fill('400');
  await page.getByRole('button', { name: 'Pay $400.00' }).click();
  await expect(page).toHaveURL(/\/checkout\/cs_/);
  await page.getByRole('button', { name: 'Pay $400.00' }).click();
  await confirmPasskey(page);
  await expect(page.getByRole('heading', { name: 'Payment complete' })).toBeVisible({ timeout: 15_000 });

  await page.getByRole('link', { name: 'Back to the invoice' }).click();
  await expect(page).toHaveURL(/\/invoice\/inv_1042/);
  await page.getByRole('button', { name: 'Pay $600.00' }).click();
  await expect(page).toHaveURL(/\/checkout\/cs_/);
  await page.getByRole('button', { name: 'Pay $600.00' }).click();
  await confirmPasskey(page);
  await expect(page.getByRole('heading', { name: 'Payment complete' })).toBeVisible({ timeout: 15_000 });

  await viewAs(page, 'merchant');
  await page.goto('/dashboard/invoices/inv_1042');
  await expect(page.locator('main')).toContainText('Acknowledged');
  await expect(page.locator('h1')).toContainText('Paid');
});
