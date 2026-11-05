import type { Page } from '@playwright/test';
import { confirmPasskey, expect, test, viewAs } from './helpers';

const dollars = (text: string) => Number(text.replace(/[^0-9.]/g, ''));

/** Pays the open checkout from the Pact account with the passkey sheet. */
async function payFromAccount(page: Page, amount: string) {
  await expect(page).toHaveURL(/\/checkout\/cs_/);
  const main = page.locator('main');
  await expect(main.getByRole('radio', { name: /^Your Pact account/ })).toBeChecked();
  await main.getByRole('button', { name: `Pay ${amount}` }).click();
  await confirmPasskey(page);
  await expect(main.getByRole('heading', { name: 'Payment complete' })).toBeVisible({ timeout: 15_000 });
}

test('a new payment link is paid by a customer and shows on the link and in orders', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/payment-links');
  await page.locator('main').getByRole('link', { name: 'New payment link' }).first().click();
  await expect(page).toHaveURL(/\/dashboard\/payment-links\/new$/);

  // Inline validation before anything is saved.
  await page.getByRole('button', { name: 'Create link' }).click();
  await expect(page.getByText('Give the link a name your customer will recognise.')).toBeVisible();
  await expect(page.getByText('Enter an amount above $0.')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Logo review');
  await page.getByLabel('Price', { exact: true }).fill('75');
  await page.getByRole('button', { name: 'Create link' }).click();

  await expect(page).toHaveURL(/\/dashboard\/payment-links\/link_\d+\?created=1$/);
  await expect(page.getByText('Your link is ready')).toBeVisible();
  await expect(page.getByRole('img', { name: /QR code for/ })).toBeVisible();
  const path = new URL((await page.getByTestId('link-url').textContent())!).pathname;
  expect(path).toMatch(/^\/l\/link_\d+$/);
  const linkId = path.split('/').pop()!;

  await viewAs(page, 'customer');
  await page.goto(path);
  await page.getByRole('button', { name: 'Continue · $75.00' }).click();
  await payFromAccount(page, '$75.00');

  await viewAs(page, 'merchant');
  await page.goto(`/dashboard/payment-links/${linkId}`);
  const payment = page.getByRole('row').filter({ hasText: 'Jordan Lee' });
  await expect(payment).toHaveCount(1);
  await expect(payment).toContainText('$75.00');
  await expect(payment).toContainText('Paid');
  await payment.getByRole('link', { name: /^ord_/ }).click();
  await expect(page).toHaveURL(/\/dashboard\/orders\/ord_/);

  await page.goto('/dashboard/orders?q=Logo%20review');
  const order = page.getByRole('row').filter({ hasText: 'Logo review' });
  await expect(order).toHaveCount(1);
  await expect(order).toContainText('Payment link');
  await expect(order).toContainText('Paid');
});

test('a tip link takes the amount the payer chooses', async ({ page }) => {
  await viewAs(page, 'customer');
  await page.goto('/l/link_tip_jar');
  const main = page.locator('main');
  await expect(main.getByTestId('checkout-total')).toHaveText('You choose');

  await main.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(main.getByText('Enter the amount you want to pay.')).toBeVisible();
  const amount = main.getByLabel('Amount', { exact: true });
  await amount.fill('20000');
  await expect(main.getByText('The most you can pay here is $10,000.00.')).toBeVisible();
  // A quick pick fills the plain number, never a formatted one.
  await main.getByRole('button', { name: '$10.00', exact: true }).click();
  await expect(amount).toHaveValue('10.00');
  await amount.fill('12.50');
  await main.getByRole('button', { name: 'Continue · $12.50' }).click();

  await expect(main.getByTestId('checkout-total')).toHaveText('$12.50');
  await payFromAccount(page, '$12.50');
});

test('an inactive link says so, and turning it back on reopens it', async ({ page }) => {
  await viewAs(page, 'customer');
  await page.goto('/l/link_spring_promo');
  const main = page.locator('main');
  await expect(main.getByText('This link is no longer taking payments')).toBeVisible();
  await expect(main.getByRole('button', { name: /^Continue/ })).toHaveCount(0);

  await viewAs(page, 'merchant');
  await page.goto('/dashboard/payment-links?status=inactive');
  await expect(page.getByRole('row').filter({ hasText: 'Spring workshop promo' })).toContainText('Off');
  await page.goto('/dashboard/payment-links/link_spring_promo');
  await page.getByRole('button', { name: /^Turn on/ }).click();
  await expect(page.getByText('Spring workshop promo is taking payments again.')).toBeVisible();

  await viewAs(page, 'customer');
  await page.goto('/l/link_spring_promo');
  await expect(main.getByRole('button', { name: 'Continue · $390.00' })).toBeVisible();
});

test('a manual order gets a pay link, the customer pays it, and it shows as paid', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/orders');
  await page.locator('main').getByRole('link', { name: 'Create order' }).click();
  await expect(page).toHaveURL(/\/dashboard\/orders\/new$/);

  await page.getByRole('button', { name: 'Create order' }).click();
  await expect(page.getByText('Choose a customer.')).toBeVisible();
  await page.getByLabel('Customer', { exact: true }).selectOption('cus_acme');
  await page.getByLabel('Item 1 description').fill('Logo refresh');
  await page.getByLabel('Item 1 unit price').fill('120');
  await page.getByRole('button', { name: 'Add item' }).click();
  await page.getByLabel('Item 2', { exact: true }).selectOption('prod_support');
  await page.getByLabel('Item 2 quantity').fill('2');
  // The total is the server's quote: 120 + 2 × 150.
  await expect(page.getByTestId('order-total')).toHaveText('$420.00');
  await page.getByLabel('Note to the customer').fill('As agreed on our call.');
  await page.getByRole('button', { name: 'Create order' }).click();

  await expect(page.getByRole('heading', { name: 'Order created' })).toBeVisible();
  const path = new URL((await page.getByTestId('pay-url').textContent())!).pathname;
  expect(path).toMatch(/^\/pay\/ord_\d+$/);
  const orderId = path.split('/').pop()!;

  await viewAs(page, 'customer');
  await page.goto(path);
  const main = page.locator('main');
  await expect(main.getByText('As agreed on our call.')).toBeVisible();
  await expect(main.getByText('Logo refresh')).toBeVisible();
  await main.getByRole('button', { name: 'Continue · $420.00' }).click();
  await payFromAccount(page, '$420.00');
  await page.goto(path);
  await expect(main.getByText(/You paid \$420\.00/)).toBeVisible();

  await viewAs(page, 'merchant');
  await page.goto('/dashboard/orders?status=paid');
  const row = page.getByRole('row').filter({ hasText: orderId });
  await expect(row).toContainText('Manual order');
  await expect(row).toContainText('Paid');
});

test('a partial refund shows in the refunds list with its order and public record', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/customers/cus_acme');
  await page.getByRole('link', { name: 'Component toolkit' }).click();
  await expect(page).toHaveURL(/\/dashboard\/orders\/ord_/);
  const orderId = page.url().split('/').pop()!;
  await page.getByLabel('Amount').fill('9');
  await page.getByRole('button', { name: /^Refund \$9\.00/ }).click();
  await confirmPasskey(page);
  await expect(page.getByText('Refund of $9.00 confirmed')).toBeVisible();

  await page.goto('/dashboard/refunds');
  const row = page.getByRole('row').filter({ hasText: orderId });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('$9.00');
  await expect(row).toContainText('Jordan Lee');
  await expect(row).toContainText('Succeeded');
  await expect(row.getByRole('link', { name: /on the explorer/ })).toHaveAttribute(
    'href',
    /\/tx\/0x[0-9a-f]+$/,
  );
  await row.getByRole('link', { name: 'Component toolkit' }).click();
  await expect(page).toHaveURL(new RegExp(`/dashboard/orders/${orderId}$`));
});

test('archiving a plan moves it to Archived and restoring brings it back', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/plans');
  const row = page.getByRole('row').filter({ hasText: 'Design care' });
  await row.getByRole('button', { name: 'Archive Design care' }).click();
  await expect(page.getByText('Design care archived. Current subscribers keep their plan.')).toBeVisible();
  await expect(row).toContainText('Archived');
  await expect(row.getByRole('button', { name: /Copy subscribe link/ })).toHaveCount(0);

  await page
    .getByRole('navigation', { name: 'Plan status' })
    .getByRole('link', { name: /^Archived/ })
    .click();
  await expect(page.getByRole('row').filter({ hasText: 'Design care' })).toHaveCount(1);
  await expect(page.getByRole('row').filter({ hasText: 'API Growth' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Restore Design care' }).click();
  await expect(page.getByText('Design care is taking new signups again.')).toBeVisible();

  // Accountants see the list read-only.
  await viewAs(page, 'accountant');
  await page.goto('/dashboard/plans');
  await expect(page.getByRole('row').filter({ hasText: 'Design care' })).toContainText('Active');
  await expect(page.getByRole('button', { name: /^Archive/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'New plan' })).toHaveCount(0);
});

test('order columns sort on the server and keep the status tab', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/orders?status=paid');
  const main = page.locator('main');
  const amounts = async () => (await main.getByTestId('order-amount').allTextContents()).map(dollars);

  await main.getByRole('link', { name: 'Amount', exact: true }).click();
  await expect(page).toHaveURL(/\/dashboard\/orders\?status=paid&sort=amount&dir=desc$/);
  await expect(main.getByRole('columnheader', { name: 'Amount', exact: true })).toHaveAttribute(
    'aria-sort',
    'descending',
  );
  const down = await amounts();
  expect(down.length).toBeGreaterThan(2);
  expect(down).toEqual([...down].sort((a, b) => b - a));

  await main.getByRole('link', { name: 'Amount', exact: true }).click();
  await expect(main.getByRole('columnheader', { name: 'Amount', exact: true })).toHaveAttribute(
    'aria-sort',
    'ascending',
  );
  const up = await amounts();
  expect(up).toEqual([...up].sort((a, b) => a - b));

  // The tab and the sort survive each other.
  await expect(
    main.getByRole('navigation', { name: 'Order status' }).getByRole('link', { name: /^Paid/ }),
  ).toHaveAttribute('aria-current', 'page');
  await main.getByRole('navigation', { name: 'Order status' }).getByRole('link', { name: /^All/ }).click();
  await expect(page).toHaveURL(/\/dashboard\/orders\?sort=amount&dir=asc$/);
});
