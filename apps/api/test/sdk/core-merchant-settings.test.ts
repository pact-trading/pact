import { describe, expect, it } from 'vitest';
import { PactClient, fetchTransport } from '@pactagent/core';
import { apiFixture } from './api-fixture.js';

describe('merchant settings through actual API', () => {
  it('keeps policy snapshots stable and exposes public branding without webhook secrets', async () => {
    const f = apiFixture();
    try {
      const client = new PactClient({ transport: fetchTransport('http://sdk.test', f.fetcher), apiKey: f.keys.secretKey });
      const browser = new PactClient({ transport: fetchTransport('http://sdk.test', f.fetcher), apiKey: f.keys.publishableKey });
      expect((await client.settings.get()).refundWindowSeconds).toBe(2592000);
      await client.settings.update({ brandName: 'Example', logoUrl: 'https://example.test/logo.png', refundWindowSeconds: 86400 }, { idempotencyKey: 'settings-1' });
      const payment = await client.payments.create({ amount: '2' });
      await client.settings.update({ refundWindowSeconds: 604800 });
      expect((await browser.payments.get(payment.id)).refundWindowSeconds).toBe(86400);
      expect((await browser.config.get()).checkout).toMatchObject({ brandName: 'Example', refundWindowSeconds: 604800 });
      // 300,000 target gas plus the Router's 60,000, at 1 gwei and 79 USDT per WBT: at most 0.02844 USDT.
      expect(await browser.fees.preview(300000)).toMatchObject({ targetGas: 300000, maximumGasFeeMinor: '28440', usdtPerWbtMinor: '79000000', minimumAmountMinor: '1000000' });
      const summary = await client.dashboard.get();
      expect(summary.balance).toMatchObject({ available: true, amountUsdt: '0.000000' });
      expect(summary.today?.capturedUsdt).toBe('0.000000');
      await expect(browser.settings.update({ brandName: 'Forbidden' })).rejects.toMatchObject({ status: 403 });
    } finally { f.close(); }
  });
});
