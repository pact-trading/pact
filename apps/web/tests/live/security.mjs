import { base, open, readyMerchant } from './lib.mjs';
const t = await open(process.argv[2]);
const { page, step, shot, call, errors } = t;
try {
  await readyMerchant(t);
  const previousRun = (await call('merchant', '/v1/security/drain-runs')).data[0]?.id;
  await step('merchant: run the drain attack', async () => {
    await page.goto(`${base}/dashboard/security`);
    await shot('50-security');
    await page.getByRole('button', { name: /drain/i }).first().click();
    await page.waitForTimeout(8000);
    await shot('51-drain-run');
  });
  await step('every attempt refused, merchant USDT unchanged, layers counted', async () => {
    // The run is stored when every attempt has been tried: seconds on a fork, a minute or two on the testnet.
    let run;
    for (let i = 0; i < 120 && !run; i++) {
      const [latest] = (await call('merchant', '/v1/security/drain-runs')).data;
      if (latest && latest.id !== previousRun) run = latest;
      else await page.waitForTimeout(2000);
    }
    if (!run) throw new Error('no drain run stored');
    const sent = run.attempts.filter(a => a.result !== 'refused');
    if (sent.length) throw new Error(`attempts not refused: ${JSON.stringify(sent)}`);
    if (run.merchantBalanceBeforeMinor === null || run.merchantBalanceAfterMinor === null)
      throw new Error('merchant balance unreadable');
    if (run.merchantBalanceAfterMinor !== run.merchantBalanceBeforeMinor) throw new Error('merchant USDT moved');
    const layers = (await call('merchant', '/v1/security/layers')).data;
    console.log(
      `  ${run.attempts.length} attempts refused; blocked per layer: ${layers.map(l => `${l.id}:${l.blocked}`).join(' ')}`,
    );
  });
  await step('refusal feed shows the attempts', async () => {
    await page.reload();
    await page.waitForTimeout(1500);
    await shot('52-security-after');
  });
} finally {
  console.log(errors.length ? `browser errors:\n${errors.join('\n')}` : 'no browser errors');
  await t.browser.close();
}
