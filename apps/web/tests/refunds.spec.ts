import { confirmPasskey, expect, test, viewAs } from './helpers';

test('partial then full refund work, a third is refused onchain, and the customer sees both', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/customers/cus_acme');
  await page.getByRole('link', { name: 'Component toolkit' }).click();
  await expect(page).toHaveURL(/\/dashboard\/orders\/ord_/);
  const orderId = page.url().split('/').pop()!;

  await page.getByLabel('Amount').fill('9');
  await page.getByRole('button', { name: /^Refund \$9\.00/ }).click();
  await confirmPasskey(page);
  await expect(page.getByText('Refund of $9.00 confirmed')).toBeVisible();

  await page.getByLabel('Amount').fill('20');
  await page.getByRole('button', { name: /^Refund \$20\.00/ }).click();
  await confirmPasskey(page);
  await expect(page.getByText('Fully refunded')).toBeVisible();

  await page.getByRole('button', { name: 'Try another refund' }).click();
  await page.getByRole('button', { name: /^Refund \$1\.00/ }).click();
  await confirmPasskey(page);
  await expect(page.getByText('Refused by the payment contract')).toBeVisible();
  await expect(page.getByText('Refund refused: Refund limit')).toBeVisible();

  await viewAs(page, 'customer');
  await page.goto(`/portal/purchases/${orderId}`);
  await expect(page.getByText(/Refund of \$9\.00/)).toBeVisible();
  await expect(page.getByText(/Refund of \$20\.00/)).toBeVisible();
});
