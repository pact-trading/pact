import { expect, test as base, type Page } from '@playwright/test';

export type Role = 'merchant' | 'accountant' | 'customer' | 'investor' | 'compliance';

/** Every test starts from the seeded PRD story. */
export const test = base.extend({});
test.beforeEach(async ({ page }) => {
  // Shares the browser's cookies, so this resets (and issues) the test's own sandbox.
  const reset = await page.request.post('/api/demo/reset');
  expect(reset.ok()).toBeTruthy();
});

export { expect };

/** Switches the demo viewpoint, the same cookie /demo sets. */
export async function viewAs(page: Page, role: Role) {
  const url = test.info().project.use.baseURL!;
  await page.context().addCookies([{ name: 'pact_role', value: role, url }]);
}

/** Approves the mock passkey sheet that stands in for Privy. */
export async function confirmPasskey(page: Page) {
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Confirm with passkey' }).click();
  await expect(sheet).toBeHidden({ timeout: 5_000 });
}

/** Words a payer must never need to see on the main checkout surface. */
export const cryptoWords = [
  /whitechain/i,
  /sepolia/i,
  /\b0x[0-9a-f]{4,}/i,
  /\bgas\b/i,
  /\bWBT\b/,
  /seed phrase/i,
  /\bchain\b/i,
];
