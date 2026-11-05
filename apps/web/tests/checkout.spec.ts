import { confirmPasskey, cryptoWords, expect, test, viewAs } from './helpers';

test('customer pays with one passkey confirmation and never sees crypto', async ({ page }) => {
  await viewAs(page, 'customer');
  await page.goto('/buy/prod_audit');
  // Continuing only opens the checkout; nothing is paid yet.
  await page.getByRole('button', { name: /Continue · \$490\.00/ }).click();
  await expect(page).toHaveURL(/\/checkout\/cs_/);

  const main = page.locator('main');
  const pay = main.getByRole('button', { name: 'Pay $490.00' });
  await expect(pay).toBeVisible();
  await expect(main.getByRole('radio', { name: /^Your Pact account/ })).toBeChecked();
  const before = await main.innerText();
  for (const word of cryptoWords) expect(before).not.toMatch(word);

  await pay.click();
  await confirmPasskey(page);
  await expect(main.getByRole('heading', { name: 'Payment complete' })).toBeVisible({ timeout: 15_000 });
  await expect(main.getByText('Pact account', { exact: true })).toBeVisible();
  const receipt = await main.innerText();
  for (const word of cryptoWords) expect(receipt).not.toMatch(word);

  // Network details exist, but only behind the disclosure.
  await main.getByText('Advanced details').click();
  await expect(main).toContainText('Whitechain Sepolia');
});

test('a short balance offers test funds instead of crypto instructions', async ({ page }) => {
  await viewAs(page, 'customer');
  await page.goto('/buy/prod_sprint');
  await page.getByRole('button', { name: /Continue · \$1,200\.00/ }).click();
  const main = page.locator('main');
  await expect(main.getByText('Add funds to continue')).toBeVisible();
  await expect(main.getByRole('button', { name: 'Pay $1,200.00' })).toBeDisabled();
  await main.getByRole('button', { name: 'Get $1,000 of test USDT' }).click();
  await expect(main.getByRole('button', { name: 'Pay $1,200.00' })).toBeEnabled();
});

test('the checkout footer links to the terms and privacy pages', async ({ page }) => {
  await viewAs(page, 'customer');
  await page.goto('/buy/prod_audit');
  const main = page.locator('main');
  await expect(main.getByText('Powered by Pact')).toBeVisible();
  const terms = main.getByRole('link', { name: 'Terms', exact: true });
  await expect(terms).toHaveAttribute('href', '/legal/terms');
  await expect(main.getByRole('link', { name: 'Privacy', exact: true })).toHaveAttribute(
    'href',
    '/legal/privacy',
  );

  const opened = page.waitForEvent('popup');
  await terms.click();
  const legal = await opened;
  await expect(legal.getByRole('heading', { level: 1 })).toHaveText('Terms of use');
  await expect(legal.locator('main')).toContainText('hackathon demo');
  await legal.getByRole('navigation', { name: 'Legal' }).getByRole('link', { name: 'Privacy' }).click();
  await expect(legal).toHaveURL(/\/legal\/privacy$/);
  await expect(legal.getByRole('heading', { level: 1 })).toHaveText('Privacy notice');
  await expect(legal.locator('main')).toContainText('only the card brand and last four digits');
});
