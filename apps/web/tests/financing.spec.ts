import type { Page } from '@playwright/test';
import { confirmPasskey, expect, test, viewAs } from './helpers';

/** Moves the demo clock forward from the demo bar. */
async function advanceClock(page: Page, label: '+1 day' | '+7 days' | '+30 days') {
  await page
    .locator('button[aria-expanded]')
    .filter({ has: page.locator('svg.tabler-icon-clock-play') })
    .click();
  await page.getByRole('button', { name: label }).click();
}

test('merchant finances INV-1060, an investor buys it, and the customer’s payment goes straight to the investor', async ({
  page,
}) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/financing/inv_1060');
  await expect(page.locator('h1')).toContainText('INV-1060');
  await expect(page.locator('h1')).toContainText('Eligible');
  // 30 days at 0.1% a day: $144 off $4,800, Pact's $24 fee, and a $480 reserve held until Northwind pays.
  await expect(page.getByText('Net advance to you')).toBeVisible();
  await expect(page.getByText('$4,632.00').first()).toBeVisible();
  await expect(page.getByText('$4,152.00').first()).toBeVisible();

  await page.getByRole('button', { name: 'Request financing' }).click();
  const request = page.getByRole('dialog', { name: /Request financing for/ });
  await expect(request).toContainText('you receive $4,152.00 right away');
  await request.getByRole('button', { name: 'Request financing' }).click();
  // Listing sells the invoice's payment, so the business confirms it like any signed action.
  const sheet = page.getByRole('dialog', { name: /List INV-1060 for investors/ });
  await expect(sheet).toContainText('The contract, which pays the investors');
  await sheet.getByRole('button', { name: 'Confirm with passkey' }).click();
  await expect(request).toBeHidden();
  await expect(page.locator('h1')).toContainText('Requested');

  await viewAs(page, 'investor');
  await page.goto('/investor');
  await page.getByRole('link', { name: 'INV-1060' }).click();
  await expect(page).toHaveURL(/\/investor\/invoices\/inv_1060/);
  await expect(page.locator('h1')).toContainText('Listed');
  await page.getByRole('button', { name: 'Buy for $4,656.00' }).click();
  await expect(page.getByRole('dialog')).toContainText('7-day grace with a 1% late fee');
  await confirmPasskey(page);
  await expect(page.locator('h1')).toContainText('Funded');

  await viewAs(page, 'merchant');
  await page.goto('/dashboard/financing/inv_1060');
  await expect(page.getByText('Funded by Lotus Capital')).toBeVisible();
  await expect(page.getByRole('row', { name: /Financing advance/ })).toContainText('+$4,632.00');
  await expect(page.getByRole('row', { name: /Financing reserve/ })).toContainText('-$480.00');

  await page.getByRole('button', { name: 'Simulate Northwind Traders paying $4,800.00' }).click();
  await expect(page.locator('h1')).toContainText('Repaid');
  await expect(page.getByRole('row', { name: /Financing repayment/ })).toContainText('-$4,800.00');
  await expect(
    page.getByRole('row', { name: /Financing reserve/ }).filter({ hasText: '+$480.00' }),
  ).toBeVisible();
  // The advance less the reserve, the payment in and straight out to the investor, then the reserve back:
  // the price less Pact's fee, counted once.
  await expect(page.getByRole('row', { name: /Net from this invoice/ })).toContainText('+$4,632.00');

  await viewAs(page, 'investor');
  await page.goto('/investor/portfolio');
  const position = page.getByRole('row', { name: /INV-1060/ });
  await expect(position).toContainText('Repaid');
  await expect(position).toContainText('$4,800.00');
});

test('an invoice in its grace period defaults after 7 days and the merchant buys it back', async ({
  page,
}) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/financing/inv_1051');
  await expect(page.locator('h1')).toContainText('Overdue');
  await expect(page.getByText(/^Overdue: grace period until/)).toBeVisible();

  await advanceClock(page, '+7 days');
  await expect(page.locator('h1')).toContainText('Defaulted');
  // $2,400 face plus the 1% late fee, less the $240 reserve the holders already received.
  await expect(page.getByText('Defaulted: $2,184.00 buy-back owed')).toBeVisible();

  await page.getByRole('button', { name: 'Buy back for $2,184.00' }).click();
  await confirmPasskey(page);
  await expect(page.locator('h1')).toContainText('Bought back');
  await expect(page.getByRole('row', { name: /Financing buy-back/ })).toHaveCount(2);

  await viewAs(page, 'investor');
  await page.goto('/investor/portfolio');
  const position = page.getByRole('row', { name: /INV-1051/ });
  await expect(position).toContainText('Bought back');
  // Lotus held $1,000: its $100 share of the reserve, then $910 of the buy-back.
  await expect(position).toContainText('$1,010.00');
});

test('a funded invoice past its grace period defaults and the investor receives the reserve', async ({
  page,
}) => {
  await viewAs(page, 'investor');
  await page.goto('/investor/portfolio');
  const position = page.getByRole('row', { name: /INV-1055/ });
  await expect(position).toContainText('Funded');

  await advanceClock(page, '+30 days');
  await expect(position).toContainText('Defaulted');
  await expect(position.getByRole('cell', { name: '$200.00' })).toBeVisible();

  await page.getByRole('link', { name: 'INV-1055' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Defaulted: the token is frozen' })).toBeVisible();
  // Bluebird's balance is too low, so nothing is paid.
  await page.getByRole('button', { name: /Simulate Bluebird Health paying/ }).click();
  await expect(page.getByText(/does not have \$3,200\.00/)).toBeVisible();
  await expect(page.locator('h1')).toContainText('Defaulted');

  await viewAs(page, 'merchant');
  await page.goto('/dashboard/financing?status=defaulted');
  await expect(page.getByRole('row', { name: /INV-1055/ })).toContainText('Defaulted');
});

test('the token refuses a transfer to an investor who is not approved, until compliance approves them', async ({
  page,
}) => {
  await viewAs(page, 'investor');
  await page.goto('/investor/invoices/inv_1055');
  await expect(page.getByText('You and 1 other investor hold this invoice')).toBeVisible();

  await page.getByLabel('Send to').selectOption({ label: 'Northgate Fund (not approved)' });
  await page.getByRole('button', { name: 'Transfer' }).click();
  await expect(page.getByText(/Northgate Fund is not an approved investor/).first()).toBeVisible();

  await viewAs(page, 'compliance');
  await page.goto('/compliance');
  await expect(page.getByRole('row', { name: /Northgate Fund/ })).toContainText('Pending');
  await expect(
    page.getByText('INV-1055: Transfer from Lotus Capital to Northgate Fund refused'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Approve Northgate Fund' }).click();
  await confirmPasskey(page);
  await expect(page.getByRole('row', { name: /Northgate Fund/ })).toContainText('Approved');

  await viewAs(page, 'investor');
  await page.goto('/investor/invoices/inv_1055');
  await page.getByLabel('Send to').selectOption({ label: 'Northgate Fund' });
  await page.getByLabel('Face value', { exact: true }).fill('500');
  await page.getByRole('button', { name: 'Transfer' }).click();
  await confirmPasskey(page);
  await expect(page.getByText('Lotus Capital transferred $500.00 to Northgate Fund')).toBeVisible();
  await expect(page.getByText('You and 2 other investors hold this invoice')).toBeVisible();
});

test('a revoked investor cannot buy, and a listing is priced higher for a customer who paid late', async ({
  page,
}) => {
  await viewAs(page, 'investor');
  await page.goto('/investor/invoices/inv_1057');
  // Harbor Street bought $1,000 of $2,250; Tideworks paid INV-1033 late, so 26 days × 0.1% + 1%.
  await expect(page.getByText('$1,000.00 of $2,250.00 funded · $1,250.00 still for sale')).toBeVisible();
  await expect(page.getByText('26 days × 0.1% + 1% late history')).toBeVisible();

  await viewAs(page, 'compliance');
  await page.goto('/compliance');
  await page.getByRole('button', { name: 'Revoke Lotus Capital' }).click();
  await confirmPasskey(page);
  await expect(page.getByRole('row', { name: /Lotus Capital/ })).toContainText('Revoked');

  await viewAs(page, 'investor');
  await page.goto('/investor/invoices/inv_1057');
  await expect(page.getByText('You are not an approved investor')).toBeVisible();
  await page.getByRole('button', { name: /^Buy for/ }).click();
  await expect(
    page.getByText(/Lotus Capital is not an approved investor: its approval was revoked/).first(),
  ).toBeVisible();
});

test('an invoice the customer has not acknowledged cannot be financed', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/financing/inv_1042');
  await expect(page.locator('h1')).toContainText('Not eligible');
  await expect(page.getByText(/Waiting for Acme Robotics to acknowledge it/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Request financing' })).toHaveCount(0);
});

test('the accountant sees financing read-only', async ({ page }) => {
  await viewAs(page, 'accountant');
  await page.goto('/dashboard/financing/inv_1060');
  await expect(page.locator('h1')).toContainText('INV-1060');
  await expect(page.getByRole('button', { name: 'Request financing' })).toHaveCount(0);
  await expect(
    page.getByText('Read-only. Only the business owner can request, cancel or buy back financing.'),
  ).toBeVisible();
});

test('an investor and a compliance officer can cancel signed orders that did not go through', async ({
  page,
}) => {
  await viewAs(page, 'investor');
  await page.goto('/investor/portfolio');
  await page.getByRole('button', { name: 'Cancel unsent orders' }).click();
  await confirmPasskey(page);
  await expect(page.getByText('Unsent signed orders cancelled')).toBeVisible();

  await viewAs(page, 'compliance');
  await page.goto('/compliance');
  await expect(page.getByText('Signed a decision that did not go through?', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel unsent orders' }).click();
  await confirmPasskey(page);
  await expect(page.getByText('Unsent signed orders cancelled')).toBeVisible();
});
