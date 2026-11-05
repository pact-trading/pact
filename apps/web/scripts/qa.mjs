#!/usr/bin/env node
// Screenshots every screen as each viewpoint, desktop and mobile, light and dark,
// and fails if any page scrolls sideways. Run against a mock-data preview:
//   pnpm preview            (in another terminal)
//   pnpm --filter @pact/web qa
//   QA_BASE=http://127.0.0.1:3200 QA_THEMES=light,dark pnpm --filter @pact/web qa
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from '@playwright/test';

const base = process.env.QA_BASE ?? 'http://127.0.0.1:3200';
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/screens');
const themes = (process.env.QA_THEMES ?? 'light').split(',');

const screens = [
  ['merchant', '/dashboard', 'merchant-overview'],
  ['merchant', '/dashboard/onboarding', 'merchant-onboarding'],
  ['merchant', '/dashboard/products', 'merchant-products'],
  ['merchant', '/dashboard/orders', 'merchant-orders'],
  ['merchant', '/dashboard/customers/cus_acme', 'merchant-customer'],
  ['merchant', '/dashboard/invoices', 'merchant-invoices'],
  ['merchant', '/dashboard/invoices/inv_1042', 'merchant-invoice'],
  ['merchant', '/dashboard/invoices/new', 'merchant-invoice-new'],
  ['merchant', '/dashboard/subscriptions', 'merchant-subscriptions'],
  ['merchant', '/dashboard/paid-api', 'merchant-paid-api'],
  ['merchant', '/dashboard/gas-tank', 'merchant-gas-tank'],
  ['merchant', '/dashboard/security', 'merchant-security'],
  ['merchant', '/dashboard/developers', 'merchant-developers'],
  ['merchant', '/dashboard/developers?tab=webhooks', 'merchant-webhooks'],
  ['merchant', '/dashboard/settings', 'merchant-settings'],
  ['accountant', '/dashboard/exports', 'accountant-exports'],
  ['customer', '/buy/prod_audit', 'customer-buy'],
  ['customer', '/subscribe/plan_growth', 'customer-subscribe'],
  ['customer', '/invoice/inv_1042', 'customer-invoice'],
  ['customer', '/portal', 'customer-portal'],
  ['customer', '/portal/subscriptions', 'customer-subscriptions'],
  ['customer', '/portal/agents/agt_research', 'agent-console'],
  ['customer', '/portal/account', 'customer-account'],
  [null, '/demo', 'demo'],
  [null, '/', 'landing'],
];

const viewports = { desktop: devices['Desktop Chrome'], mobile: { ...devices['iPhone 13'], defaultBrowserType: 'chromium' } };
const browser = await chromium.launch();
const results = [];
for (const theme of themes) {
  for (const [label, device] of Object.entries(viewports)) {
    const context = await browser.newContext({ ...device, colorScheme: theme === 'dark' ? 'dark' : 'light' });
    await context.addInitScript(value => localStorage.setItem('pact-theme', value), theme);
    const page = await context.newPage();
    for (const [role, path, name] of screens) {
      await context.clearCookies();
      if (role) await context.addCookies([{ name: 'pact_role', value: role, url: base }]);
      const response = await page.goto(base + path, { waitUntil: 'networkidle' });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      const file = resolve(out, theme, label, `${name}.png`);
      await mkdir(dirname(file), { recursive: true });
      await page.screenshot({ path: file, fullPage: true });
      results.push({ theme, viewport: label, name, path, status: response?.status() ?? 0, overflowPx: overflow });
    }
    await context.close();
  }
}
await browser.close();
const failures = results.filter(r => r.status !== 200 || r.overflowPx > 1);
await writeFile(resolve(out, 'qa-results.json'), JSON.stringify({ base, generatedAt: new Date().toISOString(), results, failures }, null, 2) + '\n');
console.log(`${results.length} screenshots in ${out}; ${failures.length} problems.`);
for (const f of failures) console.log(`  ${f.theme}/${f.viewport} ${f.path}: status ${f.status}, overflow ${f.overflowPx}px`);
process.exitCode = failures.length ? 1 : 0;
