import type { Locator, Page } from '@playwright/test';
import { confirmPasskey, cryptoWords, expect, test, viewAs } from './helpers';

/** Opens a checkout session for a product as the demo customer. */
async function openCheckout(page: Page, productId: string, amount: string): Promise<Locator> {
  await viewAs(page, 'customer');
  await page.goto(`/buy/${productId}`);
  await page.getByRole('button', { name: `Continue · ${amount}` }).click();
  await expect(page).toHaveURL(/\/checkout\/cs_/);
  const main = page.locator('main');
  await expect(main.getByRole('button', { name: `Pay ${amount}` })).toBeVisible();
  return main;
}

async function fillCard(main: Locator, number: string) {
  await main.getByLabel('Name on card').fill('Jordan Lee');
  await main.getByLabel('Card number').fill(number);
  await main.getByLabel('Expiry').fill('12 / 30');
  await main.getByLabel('Security code').fill('123');
}

test('a demo card pays, after inline validation, and the receipt names the card', async ({ page }) => {
  const main = await openCheckout(page, 'prod_audit', '$490.00');
  await main.getByRole('radio', { name: /^Card/ }).check();
  await expect(main.getByText('Demo card payment')).toBeVisible();
  await expect(main.getByText(/4000 0000 0000 0002 is always declined/)).toBeVisible();
  // Nothing is prefilled, and an empty form does not submit.
  await expect(main.getByLabel('Card number')).toHaveValue('');
  await main.getByRole('button', { name: 'Pay $490.00' }).click();
  await expect(main.getByText('Enter the name on the card.')).toBeVisible();
  await expect(main.getByText('Enter the card number.')).toBeVisible();

  await main.getByLabel('Card number').fill('4242 4242 4242 4241');
  await main.getByLabel('Name on card').click();
  await expect(main.getByText('This card number is not valid. Check the digits.')).toBeVisible();

  await fillCard(main, '4242424242424242');
  await expect(main.getByLabel('Card number')).toHaveValue('4242 4242 4242 4242');
  await main.getByRole('button', { name: 'Pay $490.00' }).click();
  await expect(main.getByRole('heading', { name: 'Payment complete' })).toBeVisible({ timeout: 15_000 });
  await expect(main.getByText('Visa ending 4242')).toBeVisible();
  const receipt = await main.innerText();
  for (const word of cryptoWords) expect(receipt).not.toMatch(word);
});

test('a declined card leaves the checkout open and the payer can switch methods', async ({ page }) => {
  const main = await openCheckout(page, 'prod_support', '$150.00');
  await main.getByRole('radio', { name: /^Card/ }).check();
  await fillCard(main, '4000 0000 0000 0002');
  await main.getByRole('button', { name: 'Pay $150.00' }).click();
  await expect(main.getByRole('alert')).toContainText('Your card was declined and nothing was charged');
  await expect(page).toHaveURL(/\/checkout\/cs_/);
  await expect(main.getByRole('heading', { name: 'Payment complete' })).toHaveCount(0);

  await main.getByRole('radio', { name: /^Your Pact account/ }).check();
  await expect(main.getByRole('alert')).toHaveCount(0);
  await main.getByRole('button', { name: 'Pay $150.00' }).click();
  await confirmPasskey(page);
  await expect(main.getByRole('heading', { name: 'Payment complete' })).toBeVisible({ timeout: 15_000 });
  await expect(main.getByText('Pact account', { exact: true })).toBeVisible();
});

test('a demo bank transfer shows a reference and settles once confirmed', async ({ page }) => {
  const main = await openCheckout(page, 'prod_toolkit', '$29.00');
  await main.getByRole('radio', { name: /^Bank transfer/ }).check();
  await expect(main.getByText(/^PACT-[A-Z0-9]{8}$/)).toBeVisible();
  await expect(main.getByText('Pact Demo Bank')).toBeVisible();
  await main.getByRole('button', { name: /sent the transfer/ }).click();
  await expect(main.getByRole('heading', { name: 'Waiting for your bank transfer' })).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Payment complete' })).toBeVisible({ timeout: 15_000 });
  await expect(main.getByText('Bank transfer', { exact: true })).toBeVisible();
});

test('paying from your own wallet uses an address derived for this checkout', async ({ page }) => {
  const main = await openCheckout(page, 'prod_audit', '$490.00');
  // Wallet and network words stay inside the disclosure until the payer opens it.
  const closed = await main.innerText();
  for (const word of cryptoWords) expect(closed).not.toMatch(word);

  await main.getByText('Pay from your own wallet').click();
  const address = main.getByText(/^0x[0-9a-fA-F]{40}$/);
  await expect(address).toBeVisible();
  const first = await address.innerText();
  await expect(main.getByText('Send exactly', { exact: true })).toBeVisible();
  await expect(main.getByText('490.00 USDT')).toBeVisible();
  await expect(main.getByRole('img', { name: 'QR code of the deposit address' })).toBeVisible();
  await main.getByRole('button', { name: /sent the payment/ }).click();
  await expect(main.getByRole('heading', { name: 'Payment complete' })).toBeVisible({ timeout: 15_000 });
  await expect(main.getByText('Your own wallet', { exact: true })).toBeVisible();

  // Another checkout gets its own address.
  await page.goto('/buy/prod_audit');
  await page.getByRole('button', { name: 'Continue · $490.00' }).click();
  await expect(page).toHaveURL(/\/checkout\/cs_/);
  await main.getByText('Pay from your own wallet').click();
  await expect(address).toBeVisible();
  expect(await address.innerText()).not.toBe(first);
});
