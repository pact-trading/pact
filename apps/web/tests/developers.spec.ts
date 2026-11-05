import { expect, test, viewAs } from './helpers';

test('integration hub tabs show real package names and copy their code', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/dashboard/developers');
  await expect(page.getByRole('heading', { name: 'Integration', level: 1 })).toBeVisible();
  const main = page.locator('main');
  await expect(main.getByText('checkout.tsx · @pactagent/checkout-react')).toBeVisible();

  await main.getByRole('link', { name: 'SDK', exact: true }).click();
  await expect(page).toHaveURL(/tab=sdk/);
  const languages = main.getByRole('tablist', { name: 'Code language' });
  for (const [tab, text] of [
    ['React', '@pactagent/checkout-react'],
    ['Node server', 'createPactNodeClient'],
    ['React Native', '@pactagent/react-native'],
    ['curl', '$PACT_API_URL/v1/payments'],
  ] as const) {
    await languages.getByRole('tab', { name: tab, exact: true }).click();
    await expect(languages.getByRole('tab', { name: tab, exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(main.getByRole('tabpanel').first()).toContainText(text);
  }
  await languages.getByRole('tab', { name: 'Node server' }).click();
  await main.getByRole('tabpanel').first().getByRole('button', { name: 'Copy code' }).last().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('PACT_SECRET_KEY');
  // The branch's placeholder names are gone.
  await expect(main).not.toContainText('@settle/');
  await expect(main).not.toContainText('GOL_');

  await main.getByRole('link', { name: 'Payment link', exact: true }).click();
  await expect(main.getByRole('link', { name: 'Payment links' })).toHaveAttribute(
    'href',
    '/dashboard/payment-links',
  );
  await expect(main).toContainText('/buy/prod_audit');

  await main.getByRole('link', { name: 'API keys', exact: true }).click();
  await expect(main.getByRole('heading', { name: 'API keys' })).toBeVisible();

  const getCode = page.getByRole('button', { name: 'Get code' });
  await getCode.click();
  const dialog = page.getByRole('dialog', { name: 'Get code' });
  await dialog.getByRole('tab', { name: 'curl' }).click();
  await expect(dialog).toContainText('Authorization: Bearer $PACT_SECRET_KEY');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(getCode).toBeFocused();
});

test('webhook log simulates failure, retry and a duplicate, and never undoes a delivery', async ({
  page,
}) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/developers?tab=webhooks');
  await page.getByRole('button', { name: 'Queue test event' }).click();
  await expect(page.getByText('Test event queued')).toBeVisible();

  await page
    .getByRole('row')
    .filter({ hasText: 'webhook.test' })
    .first()
    .getByRole('button', { name: /^Details for evt_/ })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('webhook.test');
  await dialog.getByRole('button', { name: 'Fail (503)' }).click();
  await expect(dialog).toContainText('failed with 503');
  await dialog.getByRole('button', { name: 'Retry now' }).click();
  await expect(dialog).toContainText('Attempt 2 delivered');
  await expect(dialog.getByRole('button', { name: /Fail/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Send duplicate' }).click();
  await expect(dialog).toContainText('Sent again with the same event id');
  await expect(dialog.getByText('Attempt 3', { exact: true })).toBeVisible();
});

test('the accountant sees the webhook log without simulation controls', async ({ page }) => {
  await viewAs(page, 'accountant');
  await page.goto('/dashboard/developers?tab=webhooks');
  await expect(page.getByRole('heading', { name: 'Recent events' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Queue test event' })).toHaveCount(0);
  await page
    .getByRole('button', { name: /^Details for evt_/ })
    .first()
    .click();
  await expect(
    page.getByRole('dialog').getByRole('button', { name: /Send duplicate|Deliver|Retry/ }),
  ).toHaveCount(0);
});
