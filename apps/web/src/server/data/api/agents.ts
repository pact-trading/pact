import 'server-only';
import type { AgentCall, AgentSession, FacilitatorStatus, PaidEndpoint } from '@pactagent/core/platform-types';
import type { CustomerData, MerchantData, SignRequest } from '../types';
import type { ApiKit } from './source';

type LiveAgent = AgentSession & { balanceMinor?: string };
const slow = (body: unknown) => ({
  method: 'POST',
  body: JSON.stringify(body),
  signal: AbortSignal.timeout(180_000),
});
const usd = (minor: string) => `$${(Number(minor) / 1e6).toFixed(2)}`;

/** Agents in live mode: customer-owned x402 accounts, and the merchant's paid API and facilitator. */
export function createApiAgents({ api, mApi, post, hold, take }: ApiKit) {
  const mine = (id: string) => `/v1/commerce/me/agents/${encodeURIComponent(id)}`;
  const customer: Pick<
    CustomerData,
    | 'agents'
    | 'agent'
    | 'prepareAgentLimits'
    | 'submitAgentLimits'
    | 'prepareRevokeAgent'
    | 'submitRevokeAgent'
    | 'runAgent'
  > &
    Required<
      Pick<CustomerData, 'agentMerchants' | 'prepareCreateAgent' | 'submitCreateAgent' | 'fundAgent'>
    > = {
    agents: async () => (await api<{ data: LiveAgent[] }>('/v1/commerce/me/agents')).data,
    agent: id => api<{ session: LiveAgent; calls: AgentCall[] }>(mine(id)),
    agentMerchants: async () =>
      (
        await api<{ data: Array<{ id: string; address: string; name: string }> }>(
          '/v1/commerce/me/agent-merchants',
        )
      ).data,
    async prepareCreateAgent(input): Promise<SignRequest> {
      const intent = await post<{
        pendingId: string;
        account: string;
        typedData: Array<Record<string, unknown>>;
      }>('/v1/commerce/me/agents/intent', input);
      return hold(
        'agent-create',
        { pendingId: intent.pendingId },
        {
          title: `Create ${input.name}`,
          lines: [
            { label: 'Per call', value: `Up to ${usd(input.perCallCapMinor)}` },
            { label: 'Per day', value: `Up to ${usd(input.dailyCapMinor)}` },
            { label: 'Revoke', value: 'Any time, in one click' },
          ],
          typedData: intent.typedData[0],
          also: intent.typedData.slice(1),
        },
      );
    },
    async submitCreateAgent(token, signatures) {
      const { pendingId } = (await take('agent-create', token)) as { pendingId: string };
      return api<LiveAgent>('/v1/commerce/me/agents', slow({ pendingId, signatures }));
    },
    async fundAgent(id) {
      const { session } = await customer.agent(id);
      await post('/v1/dev/faucet', { address: session.account, usdt: '1' });
      return (await customer.agent(id)).session;
    },
    async prepareAgentLimits(id, limits) {
      const intent = await post<{ pendingId: string; typedData: Record<string, unknown> }>(
        `${mine(id)}/limits-intent`,
        limits,
      );
      return hold(
        'agent-limits',
        { id, pendingId: intent.pendingId },
        {
          title: 'Change agent limits',
          lines: [
            { label: 'Per call', value: `Up to ${usd(limits.perCallCapMinor)}` },
            { label: 'Per day', value: `Up to ${usd(limits.dailyCapMinor)}` },
          ],
          typedData: intent.typedData,
        },
      );
    },
    async submitAgentLimits(token, signature) {
      const { id, pendingId } = (await take('agent-limits', token)) as { id: string; pendingId: string };
      return api<LiveAgent>(`${mine(id)}/limits`, slow({ pendingId, signature }));
    },
    async prepareRevokeAgent(id) {
      const intent = await post<{ pendingId: string; typedData: Record<string, unknown> }>(
        `${mine(id)}/revoke-intent`,
        {},
      );
      return hold(
        'agent-revoke',
        { id, pendingId: intent.pendingId },
        {
          title: 'Revoke agent',
          lines: [
            {
              label: 'Effect',
              value: 'Its key stops working in the next block, including payments it already reserved.',
            },
          ],
          typedData: intent.typedData,
        },
      );
    },
    async submitRevokeAgent(token, signature) {
      const { id, pendingId } = (await take('agent-revoke', token)) as { id: string; pendingId: string };
      return api<LiveAgent>(`${mine(id)}/revoke`, slow({ pendingId, signature }));
    },
    runAgent: (id, count) =>
      api<{ calls: AgentCall[]; session: LiveAgent }>(`${mine(id)}/run`, slow({ count })),
  };
  const merchant: Pick<MerchantData, 'paidEndpoints' | 'agentCalls' | 'facilitator'> = {
    paidEndpoints: async () => (await mApi<{ data: PaidEndpoint[] }>('/v1/agents/paid-endpoints')).data,
    agentCalls: async (limit = 50) =>
      (await mApi<{ data: AgentCall[] }>(`/v1/agents/calls?limit=${limit}`)).data,
    facilitator: () => mApi<FacilitatorStatus>('/v1/agents/facilitator'),
  };
  return { customer, merchant };
}
