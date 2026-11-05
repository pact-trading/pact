import { confirmPasskey, expect, test, viewAs } from './helpers';

const dollars = (text: string) => Number(text.replace(/[$,]/g, ''));
const money = (value: number) =>
  `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

test('invoice: customer preview, share link with QR, scheduled and immediate reminders', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/invoices/inv_1042');
  await expect(page.locator('h1')).toContainText('Awaiting payment');

  const previewButton = page.getByRole('button', { name: 'Preview', exact: true });
  await previewButton.click();
  const preview = page.getByRole('dialog', { name: 'Customer view' });
  await expect(preview).toContainText('Platform integration, milestone 2');
  await expect(preview).toContainText('Pay $1,000.00');
  await page.keyboard.press('Escape');
  await expect(preview).toBeHidden();
  await expect(previewButton).toBeFocused();

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const share = page.getByRole('dialog', { name: 'Share INV-1042' });
  await expect(share.getByRole('img', { name: /QR code for .*\/invoice\/inv_1042/ })).toBeVisible();
  await expect(share.getByRole('button', { name: 'Copy link' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(share).toBeHidden();

  await page.getByRole('button', { name: 'Send reminder' }).click();
  const reminder = page.getByRole('dialog', { name: 'Send reminder' });
  await expect(reminder.getByLabel('Message')).toHaveValue(/INV-1042/);
  await reminder.getByRole('radio', { name: /Schedule/ }).check();
  const pastReminder = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await reminder.getByLabel('Date (UTC)').fill(pastReminder);
  await reminder.getByRole('button', { name: 'Schedule reminder' }).click();
  await expect(reminder.getByText('Choose a time after now, or send it now.')).toBeVisible();
  // Tomorrow at 09:00 UTC, the dialog's default.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Send reminder' }).click();
  await reminder.getByRole('radio', { name: /Schedule/ }).check();
  await reminder.getByLabel('Message').fill('Hi Jordan, INV-1042 is due soon. Thank you!');
  await reminder.getByRole('button', { name: 'Schedule reminder' }).click();
  await expect(page.getByText(/^Reminder scheduled for /)).toBeVisible();
  await expect(page.getByText(/^Scheduled for /)).toBeVisible();

  await page.getByRole('button', { name: 'Send reminder' }).click();
  await reminder.getByRole('button', { name: 'Send reminder' }).click();
  await expect(page.getByText('Reminder sent to jordan@acme-robotics.example').first()).toBeVisible();
  await expect(page.getByText(/^Sent /).first()).toBeVisible();

  await page.getByRole('button', { name: 'Call off' }).click();
  await expect(page.getByText('Called off', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Finance this invoice' })).toHaveAttribute(
    'href',
    '/dashboard/financing/inv_1042',
  );
});

test('refund dialog: a partial and then a full refund on an order over $1,000', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/orders?q=Design%20sprint');
  await page
    .getByRole('row')
    .filter({ hasText: /Paid|Partly refunded/ })
    .first()
    .getByRole('link', { name: 'Design sprint' })
    .click();
  await expect(page).toHaveURL(/\/dashboard\/orders\/ord_/);

  const open = page.getByRole('button', { name: 'Refund', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Refund payment' });
  await open.click();
  const summary = dialog.getByText(/can still be refunded/);
  const [left, total] = (await summary.textContent())!.match(/\$[\d,]+\.\d{2}/g)!.map(dollars);
  expect(total).toBeGreaterThan(1000);
  expect(left).toBeGreaterThan(250);

  await dialog.getByRole('radio', { name: /Partial/ }).check();
  const amount = dialog.getByLabel('Refund amount');
  await expect(amount).toHaveValue('');
  // The placeholder is the plain number, never a formatted "1,000.00".
  await expect(amount).not.toHaveAttribute('placeholder', /,/);
  // With no amount yet the button reads just "Refund"; submitting shows the validation message.
  await dialog.getByRole('button', { name: 'Refund', exact: true }).click();
  await expect(dialog.getByText('Enter an amount like 120 or 120.50.')).toBeVisible();
  await amount.fill(String(left + 1));
  await dialog.getByRole('button', { name: /^Refund \$/ }).click();
  await expect(dialog.getByText(`At most ${money(left)} can be refunded.`)).toBeVisible();
  await amount.fill('250');
  await dialog.getByRole('button', { name: 'Refund $250.00' }).click();
  await confirmPasskey(page);
  await expect(page.getByText('Refund of $250.00 confirmed')).toBeVisible();

  await open.click();
  await expect(
    dialog.getByText(`${money(left - 250)} of ${money(total)} can still be refunded`),
  ).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Full/ })).toBeChecked();
  await dialog.getByRole('button', { name: `Refund ${money(left - 250)}` }).click();
  await confirmPasskey(page);
  await expect(page.getByText(`Refund of ${money(left - 250)} confirmed`)).toBeVisible();
  await expect(page.locator('h1')).toContainText('Refunded');
  await expect(page.getByRole('heading', { name: 'Refund receipt' })).toBeVisible();
  await expect(open).toBeDisabled();
});

test('CSV export dialog: the period really filters the file', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/exports');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export CSV' });
  const rows = dialog.getByTestId('export-rows');
  const download = dialog.getByRole('link', { name: 'Download CSV' });

  await dialog.getByRole('radio', { name: 'Last 30 days' }).check();
  await expect(rows).toHaveText(/^\d+$/);
  const month = Number(await rows.textContent());
  await dialog.getByRole('radio', { name: 'Last 7 days' }).check();
  await expect(download).toHaveAttribute('href', /from=/);
  const week = Number(await rows.textContent());
  expect(week).toBeGreaterThan(0);
  expect(week).toBeLessThanOrEqual(month);

  const href = (await download.getAttribute('href'))!;
  const from = new URL(href, page.url()).searchParams.get('from')!;
  const csv = await (await page.request.get(href)).text();
  const lines = csv.trim().split('\r\n');
  expect(lines[0]).toContain('"Date (UTC)","Type"');
  expect(lines.at(-1)).toContain('"TOTAL"');
  const body = lines.slice(1, -1);
  expect(body).toHaveLength(week);
  for (const line of body) expect(line.slice(1, 11) >= from).toBeTruthy();

  await dialog.getByRole('radio', { name: 'Custom range' }).check();
  await dialog.getByLabel('From (UTC)').fill('2030-01-01');
  await dialog.getByLabel('To (UTC)').fill('2030-01-31');
  await expect(rows).toHaveText('0');
  await dialog.getByLabel('From (UTC)').fill('2030-02-10');
  await expect(dialog.getByText('The start date must be on or before the end date.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Download CSV' })).toBeDisabled();
});

test('settings persist after a reload, and customer-pays fee mode adds a fee line', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/settings');
  await page.getByLabel('Business name').fill('Kite Labs Studio');
  await expect(page.getByTestId('preview-brand')).toHaveText('Kite Labs Studio');
  await page.getByLabel('Brand colour', { exact: true }).fill('#2563eb');
  await page.getByLabel('Refund window, in days').fill('14');
  await page.getByRole('radio', { name: /Customer pays the fee/ }).check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();

  await page.reload();
  await expect(page.getByLabel('Business name')).toHaveValue('Kite Labs Studio');
  await expect(page.getByLabel('Brand colour', { exact: true })).toHaveValue('#2563eb');
  await expect(page.getByLabel('Refund window, in days')).toHaveValue('14');
  await expect(page.getByRole('radio', { name: /Customer pays the fee/ })).toBeChecked();

  await page.getByLabel('Business name').fill('');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Enter your business name.')).toBeVisible();

  await page.goto('/dashboard/invoices/new');
  await page.getByLabel('Payer email').fill('ap@client.example');
  await page.getByLabel('Item 1 description').fill('Design review');
  await page.getByLabel('Item 1 unit price').fill('500');
  await page.getByRole('button', { name: 'Send invoice' }).click();
  await expect(page).toHaveURL(/\/dashboard\/invoices\/inv_/);
  await expect(page.locator('main')).toContainText('Payment processing fee');
  await expect(page.locator('main')).toContainText('Kite Labs Studio');
});

test('gas deposit adds WBT to the tank, and the dialog validates the amount', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/gas-tank');
  await expect(page.getByText('Gas per payment')).toBeVisible();
  const open = page.getByRole('button', { name: 'Deposit gas' });
  const dialog = page.getByRole('dialog', { name: /Deposit gas/ });
  const balanceNow = dialog.locator('dt', { hasText: 'Balance now' }).locator('xpath=following-sibling::dd');

  await open.click();
  const before = Number((await balanceNow.textContent())!.replace(' WBT', ''));
  await dialog.getByLabel('Amount (WBT)').fill('20');
  await dialog.getByRole('button', { name: /^Deposit/ }).click();
  await expect(dialog.getByText('The demo accepts at most 10 WBT per deposit.')).toBeVisible();
  await dialog.getByLabel('Amount (WBT)').fill('0.25');
  await dialog.getByRole('button', { name: 'Deposit 0.2500 WBT' }).click();
  await expect(page.getByText('0.2500 WBT deposited into your gas tank')).toBeVisible();
  await expect(dialog).toBeHidden();

  await open.click();
  await expect(balanceNow).toHaveText(`${(before + 0.25).toFixed(4)} WBT`);
});

test('merchant simulates a failed renewal, then cancels with an effective date', async ({ page }) => {
  await viewAs(page, 'merchant');
  await page.goto('/dashboard/subscriptions/sub_6001');
  await page.getByRole('button', { name: 'Simulate renewal failure' }).click();
  await expect(page.getByText('Renewal failed: Insufficient funds')).toBeVisible();
  await expect(page.locator('h1')).toContainText('Past due');

  await page.getByRole('button', { name: 'Cancel subscription' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cancel subscription' });
  // A past-due subscription has no paid period left, so it can only end today.
  await expect(dialog.getByRole('radio', { name: /Immediately/ })).toBeChecked();
  await expect(dialog.getByText(/^Effective /)).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel subscription' }).click();
  await confirmPasskey(page);
  await expect(page.getByText(/^Cancelled\. Ends .*; no further charges\./)).toBeVisible();
  await expect(page.locator('main')).toContainText('Pact stops all further charges after cancellation.');

  await page.getByRole('button', { name: 'Run renewal now' }).click();
  await expect(page.getByText('Refused by the contract: Cancelled')).toBeVisible();
});
