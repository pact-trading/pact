import { describe, expect, it, vi } from 'vitest';
import { PactClient, type TransportRequest } from '../src/client.js';

describe('session authentication', () => {
  it('refreshes the credential for each request and exposes explicit registration without client ownership fields', async () => {
    const calls: TransportRequest[] = [];
    const getAccessToken = vi.fn().mockResolvedValueOnce('first-session').mockResolvedValueOnce('refreshed-session');
    const client = new PactClient({ getAccessToken, transport: async request => { calls.push(request); return { status: 200, body: {} }; } });
    await client.auth.session();
    await client.auth.registerMerchant();
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/v1/auth/session', headers: { authorization: 'Bearer first-session' } });
    expect(calls[1]).toMatchObject({ method: 'POST', path: '/v1/auth/merchant', body: '{}', headers: { authorization: 'Bearer refreshed-session' } });
    expect(getAccessToken).toHaveBeenCalledTimes(2);
  });
  it('does not send or fall back to an API key after logout or refresh failure', async () => {
    const transport = vi.fn();
    const getAccessToken = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('refresh failed'));
    const client = new PactClient({ apiKey: 'legacy-key', getAccessToken, transport });
    await expect(client.payments.list()).rejects.toMatchObject({ status: 401, code: 'authentication_required' });
    await expect(client.payments.list()).rejects.toThrow('refresh failed');
    expect(transport).not.toHaveBeenCalled();
  });
});
