import { confirmPasskey, expect, test, viewAs } from './helpers';

test('capped subscription: early pull refused, cancel in one click, pull after cancel refused', async ({ page }) => {
  await viewAs(page, 'customer');
  await page.goto('/subscribe/plan_growth');
  await page.getByRole('button', { name: /Subscribe · \$49\.00/ }).click();
  await confirmPasskey(page);
  await expect(page.getByText('You’re subscribed')).toBeVisible();
  await page.getByRole('link', { name: 'Manage subscription' }).click();
  await expect(page).toHaveURL(/\/portal\/subscriptions\/sub_/);
  const id = page.url().split('/').pop()!;

  await viewAs(page, 'merchant');
  await page.goto(`/dashboard/subscriptions/${id}`);
  await page.getByRole('button', { name: 'Run renewal now' }).click();
  await expect(page.getByText('Refused by the contract: Too early')).toBeVisible();

  await viewAs(page, 'customer');
  await page.goto(`/portal/subscriptions/${id}`);
  await expect(page.getByText(/refused on your behalf/)).toBeVisible();
  await page.getByRole('button', { name: 'Cancel subscription' }).click();
  await confirmPasskey(page);
  await expect(page.getByText(/cancelled\. No further charges/)).toBeVisible();

  await viewAs(page, 'merchant');
  await page.goto(`/dashboard/subscriptions/${id}`);
  await page.getByRole('button', { name: 'Run renewal now' }).click();
  await expect(page.getByText('Refused by the contract: Cancelled')).toBeVisible();
});

test('typing in a dialog field keeps focus in that field', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/subscriptions');
  await page.getByRole('button', { name: 'New plan' }).click();
  const name = page.getByRole('dialog').getByLabel('Name');
  await name.click();
  // One key at a time: each keystroke re-renders the parent with a fresh onClose.
  await name.pressSequentially('Growth');
  await expect(name).toHaveValue('Growth');
  await expect(name).toBeFocused();
});
