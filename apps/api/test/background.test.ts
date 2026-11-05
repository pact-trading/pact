import { afterEach, describe, expect, it, vi } from 'vitest';
import { startBackgroundJobs } from '../src/background.js';
import { openDb, seedMerchant } from '../src/db.js';
import { deliverWebhooks, enqueueWebhook, signWebhook } from '../src/webhooks.js';

afterEach(() => vi.useRealTimers());
describe('background delivery latency', () => {
  it('continues deliveries while an RPC job is pending, without overlapping that job', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const rpc = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const deliver = vi.fn(async () => {}), error = vi.fn();
    const stop = startBackgroundJobs([{ name: 'indexer', intervalMs: 1000, run: rpc }, { name: 'webhooks', intervalMs: 1000, run: deliver }], error);
    await vi.advanceTimersByTimeAsync(4000);
    expect(rpc).toHaveBeenCalledTimes(1); expect(deliver).toHaveBeenCalledTimes(4);
    release(); await vi.advanceTimersByTimeAsync(1000);
    expect(rpc).toHaveBeenCalledTimes(2);
    stop(); release(); expect(error).not.toHaveBeenCalled();
  });
  it('runs a job again after failure and stops future ticks on shutdown', async () => {
    vi.useFakeTimers();
    const job = vi.fn().mockRejectedValueOnce(new Error('RPC unavailable')).mockResolvedValue(undefined);
    const error = vi.fn(), stop = startBackgroundJobs([{ name: 'indexer', intervalMs: 1000, run: job }], error);
    await vi.advanceTimersByTimeAsync(2000);
    expect(job).toHaveBeenCalledTimes(2); expect(error).toHaveBeenCalledTimes(1);
    stop(); await vi.advanceTimersByTimeAsync(5000); expect(job).toHaveBeenCalledTimes(2);
  });
  it('delivers a healthy merchant event while another destination remains pending', async () => {
    const db = openDb();
    const slow = seedMerchant(db, '0x0000000000000000000000000000000000000001', { webhookUrl: 'https://slow.test', webhookSecret: 'slow' });
    const healthy = seedMerchant(db, '0x0000000000000000000000000000000000000002', { webhookUrl: 'https://healthy.test', webhookSecret: 'healthy' });
    enqueueWebhook(db, slow.merchantId, 'payment.captured', 'slow_payment');
    const event = enqueueWebhook(db, healthy.merchantId, 'payment.captured', 'healthy_payment');
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('slow.test')) return new Promise<Response>(resolve => { finish = resolve; });
      expect((init!.headers as Record<string, string>)['x-settle-signature']).toBe(signWebhook(String(init!.body), 'healthy'));
      return new Response(null, { status: 204 });
    });
    const delivery = deliverWebhooks(db, fetcher as typeof fetch);
    await vi.waitFor(() => expect(db.prepare('SELECT status FROM webhook_deliveries WHERE event_id=?').get(event)).toEqual({ status: 'delivered' }));
    finish(new Response(null, { status: 503 }));
    expect(await delivery).toBe(2);
    expect(db.prepare('SELECT status,attempt FROM webhook_deliveries WHERE merchant_id=?').get(slow.merchantId)).toEqual({ status: 'pending', attempt: 1 });
    db.close();
  });
});
