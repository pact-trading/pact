// Invoice financing through the UI, on the local fork: the merchant lists an acknowledged invoice from
// its wallet, an investor applies, a compliance officer approves it, the investor buys the invoice, and
// the customer's usual payment is routed to the investor by the receivables contract.
import {
  api,
  base,
  customerEmail,
  fundCustomer,
  open,
  readyMerchant,
  testCustomer,
  testnet,
} from './lib.mjs';
const t = await open(process.argv[2]);
const { page, context, step, shot, call, errors, toastWait } = t;
const wait = ms => new Promise(r => setTimeout(r, ms));
const network = await fetch(`${api}/v1/network`).then(r => r.json());
if (!network.contracts?.receivables) {
  console.log('Invoice financing is not deployed on this network: skipped.');
  await t.browser.close();
  process.exit(0);
}
if (testnet) {
  // The testnet run reuses one funded wallet per side; investors and officers are not provisioned there.
  console.log('Financing checks run on the local fork only: skipped.');
  await t.browser.close();
  process.exit(0);
}
const walletCall = async (cookieName, path, body) => {
  const token = (await context.cookies()).find(c => c.name === cookieName)?.value;
  const r = await fetch(`${api}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
};
/** Merchants and investors only sign; Pact's relayer pays their gas, so their wallets hold no WBT. */
const holdsNoGas = async address => {
  const rpc = process.env.PACT_LIVE_RPC ?? 'http://127.0.0.1:8545';
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] }),
  });
  const { result } = await response.json();
  if (BigInt(result) !== 0n) throw new Error(`the wallet ${address} holds ${BigInt(result)} wei`);
};
const section = name => page.locator('section').filter({ has: page.getByRole('heading', { name }) });
// Unique per run: the fork keeps earlier runs' applicants in the registry.
const organization = `Lotus Capital ${Date.now().toString(36).slice(-4)}`;
try {
  await readyMerchant(t);
  const invoice = await step('merchant: create a 20 USDT invoice due in 20 days', () =>
    call('merchant', '/v1/invoices?expand=detail', {
      customerEmail: customerEmail('client@acme.test'),
      customerName: 'Acme Ltd',
      dueAt: new Date(Date.now() + 20 * 86_400_000).toISOString(),
      lines: [{ description: 'Platform audit', quantity: 1, unitAmount: '20' }],
    }),
  );
  await testCustomer(t, 'client@acme.test');
  await fundCustomer(t, '25');
  await step('customer: acknowledge the invoice', async () => {
    await page.goto(`${base}/invoice/${invoice.id}`);
    await page.getByRole('button', { name: 'Acknowledge invoice' }).click();
    for (
      let i = 0;
      i < 20 && !(await call('customer', `/v1/commerce/me/invoices/${invoice.id}`)).acknowledgement;
      i++
    )
      await wait(500);
  });
  await step('merchant: request financing (signed, relayed, no gas)', async () => {
    await page.getByRole('button', { name: /^Business 0x/ }).click();
    await page.waitForURL(`${base}/dashboard`);
    await page.goto(`${base}/dashboard/financing/${invoice.id}`);
    await page.getByRole('button', { name: 'Request financing' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Request financing' }).click();
    await toastWait('listed for investors');
    await shot('70-financing-listed');
    // The merchant only signed the listing: Pact's relayer sent it.
    if (!testnet) await holdsNoGas((await call('merchant', '/v1/config')).merchant);
  });
  const investor = await step('investor: connect a test wallet and apply', async () => {
    await page.goto(`${base}/login`);
    await section('Invest in invoices').getByRole('button', { name: 'Test wallet' }).click();
    await page.waitForURL(`${base}/investor`, { timeout: 30000 });
    await page.getByLabel('Your name').fill('Ana Silva');
    await page.getByLabel('Organization').fill(organization);
    await page.getByLabel('Email').fill('ana@lotus.test');
    await page.getByLabel('Country').fill('GB');
    await page.getByRole('button', { name: 'Send application' }).click();
    await toastWait('Application sent to compliance');
    await page.getByRole('button', { name: 'Get 100 test USDT' }).click();
    await toastWait('Added 100 test USDT');
    await page.getByText(invoice.number).first().waitFor();
    await shot('71-marketplace');
    return walletCall('pact_investor', '/v1/investor/me');
  });
  await step('compliance: appoint a test officer and approve the investor', async () => {
    await page.goto(`${base}/login`);
    await section('Review investors').getByRole('button', { name: 'Test wallet' }).click();
    await page.waitForURL(`${base}/compliance`, { timeout: 30000 });
    await page.getByRole('button', { name: 'Appoint it on this local fork' }).click();
    await page.getByRole('button', { name: `Approve ${organization}` }).click({ timeout: 30000 });
    await toastWait(`${organization} approved`);
    await shot('72-registry');
  });
  await step('investor: buy the whole invoice', async () => {
    await page.getByRole('button', { name: /^Investor 0x/ }).click();
    await page.waitForURL(`${base}/investor`);
    await page.goto(`${base}/investor/invoices/${invoice.id}`);
    await page.getByRole('button', { name: /^Buy for / }).click();
    await toastWait('You bought');
    await shot('73-bought');
  });
  await step('investor: needed no gas (Pact relayed the signed purchase)', () =>
    holdsNoGas(investor.address),
  );
  await step('merchant: the invoice is funded and the advance arrived', async () => {
    const view = await call('merchant', `/v1/financing/invoices/${invoice.id}`);
    if (view.status !== 'funded') throw new Error(`status ${view.status}`);
    if (view.holders[0]?.id !== investor.address) throw new Error('the investor does not hold the claim');
  });
  await step('customer: pay the invoice as usual', async () => {
    await page.getByRole('button', { name: /^Customer / }).click();
    await page.waitForURL(/\/portal/);
    await page.goto(`${base}/invoice/${invoice.id}`);
    await page
      .getByRole('button', { name: /^Pay \$20\.00/ })
      .first()
      .click();
    await page.waitForURL(/\/checkout\/hp_/, { timeout: 30000 });
    await page.getByRole('button', { name: /^Pay / }).click();
    await page
      .getByText(/Payment complete/)
      .first()
      .waitFor({ timeout: 120000 });
  });
  await step('merchant and investor: repaid, the investor received the face value', async () => {
    let view;
    for (let i = 0; i < 40; i++) {
      view = await call('merchant', `/v1/financing/invoices/${invoice.id}`);
      if (view.status === 'repaid') break;
      await wait(1000);
    }
    if (view.status !== 'repaid') throw new Error(`status ${view.status}`);
    if (view.holders[0].receivedMinor !== '20000000')
      throw new Error(`received ${view.holders[0].receivedMinor}`);
    await page.getByRole('button', { name: /^Business 0x/ }).click();
    await page.waitForURL(`${base}/dashboard`);
    await page.goto(`${base}/dashboard/financing/${invoice.id}`);
    await page.getByText('Repaid in full').first().waitFor();
    await shot('74-merchant-repaid');
    await page.getByRole('button', { name: /^Investor 0x/ }).click();
    await page.waitForURL(`${base}/investor`);
    await page.goto(`${base}/investor/portfolio`);
    await page.getByText(invoice.number).first().waitFor();
    await shot('75-portfolio');
  });
  await step('investor: cancel unsent signed orders (signed, relayed, no gas)', async () => {
    const before = await walletCall('pact_investor', '/v1/investor/orders/cancel', {});
    await page.getByRole('button', { name: 'Cancel unsent orders' }).click();
    await toastWait('Unsent signed orders cancelled');
    const after = await walletCall('pact_investor', '/v1/investor/orders/cancel', {});
    if (BigInt(after.typedData[0].message.nonce) !== BigInt(before.typedData[0].message.nonce) + 1n)
      throw new Error('the order nonce did not move');
    await holdsNoGas(investor.address);
  });
} finally {
  console.log(errors.length ? `browser errors:\n${errors.join('\n')}` : 'no browser errors');
  await t.browser.close();
}
