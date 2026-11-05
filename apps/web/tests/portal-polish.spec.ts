import { confirmPasskey, expect, test, viewAs } from './helpers';

test('portal: cancel shows the effective date, and nothing is charged after it', async ({ page }) => {
  await viewAs(page, 'customer');
  await page.goto('/portal/subscriptions');
  await page.getByRole('link', { name: /Design care/ }).click();
  await expect(page).toHaveURL(/\/portal\/subscriptions\/sub_/);
  const id = page.url().split('/').pop()!;

  const copy = page.getByText(/^Effective .+, the end of the period you already paid for\./);
  await expect(copy).toBeVisible();
  const ends = (await copy.textContent())!.match(/^Effective (.+?), the end/)![1];

  await page.getByRole('button', { name: 'Cancel subscription' }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText(`${ends}, end of the period you paid for`);
  await expect(sheet).toContainText('None after today');
  await confirmPasskey(page);
  await expect(page.getByText(`Design care cancelled. No further charges. It ends ${ends}.`)).toBeVisible();
  await expect(page.locator('h1')).toContainText(`Ends ${ends}`);
  await expect(page.locator('main')).toContainText(`It runs until ${ends}`);
  await expect(page.getByRole('button', { name: 'Cancel subscription' })).toHaveCount(0);

  await page.goto('/portal/subscriptions');
  await expect(page.getByRole('link', { name: /Design care/ })).toContainText(`Ends ${ends}`);

  await viewAs(page, 'merchant');
  await page.goto(`/dashboard/subscriptions/${id}`);
  await expect(page.locator('h1')).toContainText(`Ends ${ends}`);
  await page.getByRole('button', { name: 'Run renewal now' }).click();
  await expect(page.getByText('Refused by the contract: Cancelled')).toBeVisible();
});

test('portal: a refund gets its own receipt, and receipts print', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/customers/cus_acme');
  await page.getByRole('link', { name: 'Component toolkit' }).click();
  await expect(page).toHaveURL(/\/dashboard\/orders\/ord_/);
  const orderId = page.url().split('/').pop()!;
  await page.getByRole('button', { name: 'Refund', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Refund payment' });
  await dialog.getByRole('radio', { name: /Partial/ }).check();
  await dialog.getByLabel('Refund amount').fill('9');
  await dialog.getByRole('button', { name: 'Refund $9.00' }).click();
  await confirmPasskey(page);
  await expect(page.getByText('Refund of $9.00 confirmed')).toBeVisible();

  await viewAs(page, 'customer');
  await page.goto('/portal/purchases');
  await expect(page.getByText('$9.00 refunded · refund receipt')).toBeVisible();
  await page.getByRole('link', { name: /Component toolkit/ }).click();
  await expect(page).toHaveURL(new RegExp(`/portal/purchases/${orderId}$`));

  const receipt = page.locator('section', { has: page.getByRole('heading', { name: 'Refund receipt' }) });
  await expect(receipt).toContainText('$9.00');
  await expect(receipt).toContainText('Requested by customer');
  await expect(receipt).toContainText('$20.00 of $29.00');
  await expect(page.getByRole('heading', { name: 'Payment complete' })).toBeVisible();

  await page.evaluate(() => {
    const w = window as unknown as { printed: number };
    w.printed = 0;
    window.print = () => {
      w.printed += 1;
    };
  });
  await page.getByRole('button', { name: 'Print receipts' }).click();
  expect(await page.evaluate(() => (window as unknown as { printed: number }).printed)).toBe(1);
});

test('portal: amount due up top, invoices split into to-pay and paid', async ({ page }) => {
  await viewAs(page, 'customer');
  await page.goto('/portal');
  const band = page.getByRole('status').filter({ hasText: 'Amount due:' });
  await expect(band).toContainText('$1,000.00');
  await expect(band).toContainText('across 1 invoice');
  await expect(band.getByRole('link', { name: 'Pay now' })).toHaveAttribute('href', '/invoice/inv_1042');

  await page.getByRole('navigation', { name: 'Account' }).getByRole('link', { name: 'Invoices' }).click();
  await expect(page.getByRole('heading', { name: 'To pay' })).toBeVisible();
  await expect(page.getByText('$1,000.00 due across 1')).toBeVisible();
  await expect(page.getByRole('link', { name: /INV-1042/ })).toHaveAttribute('href', '/invoice/inv_1042');
});
