import { chromium } from '@playwright/test';
// Default target: the local fork from `pnpm live`. For the deployed testnet app:
//   PACT_LIVE_URL=https://pay.pactagent.app PACT_LIVE_API=https://api.pactagent.app pnpm live:check
export const base = process.env.PACT_LIVE_URL ?? 'http://localhost:3000';
export const api = process.env.PACT_LIVE_API ?? 'http://127.0.0.1:3001';
export const testnet = !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(base);
const tn = testnet ? await import('./testnet.mjs') : null;
export async function open(shots) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  if (tn) await tn.installWallet(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() === 'error' && !/privy|Failed to load resource/i.test(m.text()))
      errors.push(`console: ${m.text().slice(0, 300)}`);
  });
  const shot = name => page.screenshot({ path: `${shots}/${name}.png` });
  const step = async (label, fn) => {
    process.stdout.write(`- ${label} … `);
    try {
      const r = await fn();
      console.log('ok');
      return r;
    } catch (e) {
      console.log('FAILED');
      console.log(String(e).split('\n').slice(0, 6).join('\n'));
      await shot(`fail-${label.replace(/\W+/g, '-')}`).catch(() => {});
      throw e;
    }
  };
  const cookie = async name => (await context.cookies()).find(c => c.name === name)?.value;
  const call = async (as, path, body, method) => {
    const token = await cookie(as === 'merchant' ? 'pact_merchant' : 'pact_session');
    const r = await fetch(`${api}${path}`, {
      method: method ?? (body ? 'POST' : 'GET'),
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await r.json();
    if (!r.ok) throw new Error(`${path} ${r.status} ${JSON.stringify(json)}`);
    return json;
  };
  const toastWait = text => page.getByText(text).first().waitFor({ timeout: 90000 });
  return { browser, context, page, errors, shot, step, cookie, call, toastWait };
}
/**
 * Merchant wallet with Pact's fee terms and both refund permits signed, and a little USDT for refunds.
 * Every step is a signature Pact's relayer submits: the wallet never holds WBT.
 */
export async function readyMerchant(t) {
  const { page, step } = t;
  if (tn) return readyTestnetMerchant(t);
  await step('merchant: connect local wallet', async () => {
    await page.goto(`${base}/login`);
    await page.getByRole('button', { name: 'Use a local test wallet' }).click();
    await page.waitForURL(`${base}/dashboard`, { timeout: 30000 });
  });
  await signFees(t);
  await step('merchant: hold 5 USDT for refunds', async () => {
    const { merchant } = await t.call('merchant', '/v1/config');
    await t.call('merchant', '/v1/dev/faucet', { address: merchant, usdt: '5' });
  });
}
/** Signs the fee terms and the refund permits on the Fees page; steps already done show no button. */
async function signFees(t) {
  const { page, step, toastWait } = t;
  await step('merchant: sign fee terms and refund permits', async () => {
    await page.goto(`${base}/dashboard/fees`);
    await page.getByRole('heading', { name: 'Your fee terms' }).waitFor();
    const terms = page.getByRole('button', { name: 'Sign fee terms' });
    if (await terms.count()) {
      await terms.first().click();
      await toastWait('Fee terms signed');
    }
    const permits = page.getByRole('button', { name: /^Sign the (two )?refund permits?$/ });
    if (await permits.count()) {
      await permits.first().click();
      await toastWait('Refund permits signed');
    }
    await page.getByRole('heading', { name: 'Ready' }).waitFor({ timeout: 90000 });
  });
}
/** Testnet: one reused merchant wallet (injected), set up once; steps already done show no button. */
async function readyTestnetMerchant(t) {
  const { page, step } = t;
  await step(`merchant: connect wallet ${tn.merchant.address}`, async () => {
    await page.goto(`${base}/login`);
    const again = page.getByRole('button', { name: /^Open my business workspace/ });
    if (await again.count()) await again.first().click();
    else await page.getByRole('button', { name: 'Connect wallet' }).click();
    await page.waitForURL(`${base}/dashboard`, { timeout: 60000 });
  });
  await signFees(t);
  await step('merchant: hold 5 USDT for refunds', () => tn.topUpUsdt(tn.merchant.address, '5'));
}
/**
 * A customer holding at least `usdt`: the fork's faucet, or on the testnet a swap paid by the deployer.
 * Flows charge at most 5 USDT a period, so the testnet top-up stops at 15 to spend little real test WBT.
 */
export async function fundCustomer(t, usdt) {
  const amount = tn ? String(Math.min(Number(usdt), 15)) : usdt;
  return t.step(`customer: hold ${amount} USDT`, async () => {
    const me = await t.call('customer', '/v1/commerce/me/account');
    if (tn) return tn.topUpUsdt(me.address, amount);
    return t.call('customer', '/v1/dev/faucet', { address: me.address, usdt: amount });
  });
}
/** The email a flow addresses its customer by: on the testnet, the one Privy test account signs in. */
export const customerEmail = email => (tn ? tn.customerEmail : email);
export async function testCustomer(t, email = 'buyer@example.test') {
  const { page, step } = t;
  if (tn)
    return step(`customer: sign in ${tn.customerEmail} (Privy)`, async () => {
      await tn.privySignIn(page, base);
      await page.waitForURL(/\/portal/, { timeout: 90000 });
    });
  await step('customer: sign in test customer', async () => {
    await page.goto(`${base}/login`);
    await page.getByLabel('Test customer email').fill(email);
    await page.getByRole('button', { name: 'Use a test customer' }).click();
    await page.waitForURL(/\/portal/, { timeout: 30000 });
  });
}
