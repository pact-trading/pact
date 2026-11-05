import { expect, test } from './helpers';

test('feature switches change the shared checkout preview', async ({ page }) => {
  await page.goto('/playground');
  const preview = page.getByRole('region', { name: 'Checkout preview' });
  const total = preview.getByTestId('checkout-total');
  await expect(total).toHaveText('$125.00');
  await expect(preview.getByRole('radio', { name: /^Your Pact account/ })).toBeChecked();

  // Preview-only features are labelled as such in the controls.
  const promo = page.getByRole('switch', { name: /Promotion codes/ });
  await expect(page.getByText('Preview', { exact: true }).first()).toBeVisible();
  await promo.check();
  await expect(preview.getByText('SAVE10')).toBeVisible();
  await expect(total).toHaveText('$112.50');
  await expect(preview.getByRole('button', { name: 'Pay $112.50' })).toBeVisible();

  await page.getByRole('switch', { name: /Suggest product/ }).check();
  await preview.getByRole('button', { name: 'Add Priority support' }).click();
  // ($125 + $19) less 10%.
  await expect(total).toHaveText('$129.60');

  await page.getByRole('switch', { name: /Calculate tax/ }).check();
  await expect(preview.getByText('Calculated at payment')).toBeVisible();

  await page.getByLabel('Payment type').selectOption('recurring');
  await expect(preview.getByText('Subscription', { exact: true })).toBeVisible();
  await expect(preview.getByRole('button', { name: /Subscribe · \$129\.60 \/ month/ })).toBeVisible();

  await page.getByRole('switch', { name: /Bank transfer/ }).check();
  await page.getByRole('switch', { name: /^Card/ }).uncheck();
  await expect(preview.getByRole('radio', { name: /^Bank transfer/ })).toBeVisible();
  await expect(preview.getByRole('radio', { name: /^Card/ })).toHaveCount(0);

  await page.getByRole('switch', { name: /Low wallet balance/ }).check();
  await expect(preview.getByText('Add funds to continue')).toBeVisible();

  await page.getByRole('switch', { name: /Shipping address/ }).check();
  await page.getByRole('switch', { name: /^Phone/ }).check();
  await expect(preview.getByRole('heading', { name: 'Shipping information' })).toBeVisible();
  await expect(preview.getByLabel(/Phone number/)).toBeVisible();
  await expect(preview.getByRole('group', { name: 'Shipping address' })).toBeVisible();
});

test('the step select covers every checkout state', async ({ page }) => {
  await page.goto('/playground');
  const preview = page.getByRole('region', { name: 'Checkout preview' });
  const state = page.getByLabel('Checkout state');
  const expected: Array<[string, RegExp | string]> = [
    ['information', 'Contact information'],
    ['payment', 'Payment method'],
    ['processing', 'Confirming your payment'],
    ['success', 'Payment complete'],
    ['refund', 'Payment refunded'],
    ['expired', 'This checkout expired'],
    ['failed', 'The payment did not go through'],
  ];
  for (const [value, text] of expected) {
    await state.selectOption(value);
    await expect(preview.getByText(text).first()).toBeVisible();
  }
  await expect(preview.getByText('Sample receipt')).toHaveCount(0);
  await state.selectOption('success');
  await expect(preview.getByText('Sample receipt')).toBeVisible();
});

test('the continue button label changes the preview, and continuing never pays', async ({ page }) => {
  await page.goto('/playground');
  const preview = page.getByRole('region', { name: 'Checkout preview' });
  const label = page.getByLabel('Continue button label');
  await label.fill('Review my order');
  await expect(page.getByLabel('Checkout state')).toHaveValue('information');
  const button = preview.getByRole('button', { name: 'Review my order' });
  await expect(button).toBeVisible();
  await preview.getByLabel('Email').fill('maya@example.com');
  await button.click();
  await expect(page.getByLabel('Checkout state')).toHaveValue('payment');
  await expect(preview.getByText('Payment method')).toBeVisible();
  await expect(preview.getByLabel('Email')).toHaveValue('maya@example.com');
  await expect(preview.getByRole('heading', { name: 'Confirming your payment' })).toHaveCount(0);
});

test('a share link round-trips every setting and ignores bad values', async ({ page }) => {
  await page.goto('/playground');
  await page.getByLabel('Payment type').selectOption('invoice');
  await page.getByRole('switch', { name: /Promotion codes/ }).check();
  await page.getByRole('switch', { name: /Bank transfer/ }).check();
  await page.getByRole('switch', { name: /Billing address/ }).check();
  await page.getByLabel('Continue button label').fill('Next step');
  await page.getByLabel('Amount', { exact: true }).fill('80.50');
  await page.getByRole('tab', { name: 'Style' }).click();
  await page.getByRole('button', { name: 'Dark' }).click();
  await page.getByRole('button', { name: 'Blue' }).click();
  await page.getByLabel('Business name').fill('Lumen & Co');
  await page.getByLabel('Font').selectOption('serif');
  await page.getByRole('slider').fill('6');
  await page.getByLabel('Checkout state').selectOption('refund');
  await page.getByRole('button', { name: 'Phone view' }).click();
  await page.getByRole('combobox', { name: 'Checkout format' }).selectOption('modal');

  await expect(page).toHaveURL(/name=Lumen/);
  const url = page.url();
  expect(url).toContain('t=invoice');
  expect(url).toContain('l=popup');

  const fresh = await page.context().newPage();
  await fresh.goto(url);
  await expect(fresh.getByLabel('Payment type')).toHaveValue('invoice');
  await expect(fresh.getByRole('switch', { name: /Promotion codes/ })).toBeChecked();
  await expect(fresh.getByRole('switch', { name: /Bank transfer/ })).toBeChecked();
  await expect(fresh.getByRole('switch', { name: /Billing address/ })).toBeChecked();
  await expect(fresh.getByLabel('Continue button label')).toHaveValue('Next step');
  await expect(fresh.getByLabel('Amount', { exact: true })).toHaveValue('80.50');
  await expect(fresh.getByLabel('Checkout state')).toHaveValue('refund');
  await expect(fresh.getByRole('button', { name: 'Phone view' })).toHaveAttribute('aria-pressed', 'true');
  await expect(fresh.getByRole('combobox', { name: 'Checkout format' })).toHaveValue('modal');
  await fresh.getByRole('tab', { name: 'Style' }).click();
  await expect(fresh.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
  await expect(fresh.getByRole('button', { name: 'Blue' })).toHaveAttribute('aria-pressed', 'true');
  await expect(fresh.getByLabel('Business name')).toHaveValue('Lumen & Co');
  await expect(fresh.getByLabel('Font')).toHaveValue('serif');
  await expect(fresh.getByRole('slider')).toHaveValue('6');
  const preview = fresh.getByRole('region', { name: 'Checkout preview' });
  await expect(preview.getByText('Lumen & Co').first()).toBeVisible();
  await expect(preview.getByRole('heading', { name: 'Payment refunded' })).toBeVisible();

  // Unknown or malformed values fall back field by field.
  await fresh.goto(
    '/playground?t=constructor&amt=1e5&c=nothex&r=99&s=__proto__&f=promo,toString&name=Ok%20Co',
  );
  await expect(fresh.getByLabel('Payment type')).toHaveValue('one-time');
  await expect(fresh.getByLabel('Amount', { exact: true })).toHaveValue('125.00');
  await expect(fresh.getByLabel('Checkout state')).toHaveValue('payment');
  await expect(fresh.getByRole('switch', { name: /Promotion codes/ })).toBeChecked();
  await fresh.getByRole('tab', { name: 'Style' }).click();
  await expect(fresh.getByLabel('Business name')).toHaveValue('Ok Co');
  await expect(fresh.getByRole('slider')).toHaveValue('16');
});

test('Start building shows code for the configuration', async ({ page }) => {
  await page.goto('/playground?t=invoice&f=promo');
  const open = page.getByRole('button', { name: 'Start building' });
  await open.click();
  const dialog = page.getByRole('dialog', { name: 'Start building' });
  await expect(dialog).toContainText('pact.invoices.create');
  await expect(dialog).toContainText('Preview only, not in the SDK yet: promotion codes.');
  await dialog.getByRole('tab', { name: 'curl' }).click();
  await expect(dialog).toContainText('/v1/invoices');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
});
