import 'server-only';
import type { PlanSummary, RefusalEvent, SubscriptionDetail } from '@pactagent/core/platform-types';
import { reasonDetail } from '@/lib/reasons';
import { DataError } from '../errors';
import type {
  ApprovalSignature,
  AvailablePlan,
  CheckoutData,
  CustomerData,
  ListFilter,
  MerchantData,
  PlanOffer,
  SignRequest,
} from '../types';
import type { ApiKit } from './source';

type Approval = {
  status: 'needs_funding' | 'needs_approval' | 'ready' | 'pending' | 'unavailable';
  reason?: string;
  message: string | null;
  approvalNonce: string | null;
  authorizationNonce: string | null;
  deadline: string | null;
  authorizationRequired: boolean;
  delegate: string;
  amount: string;
};
type SubscriptionIntent = {
  approvalKey: string;
  approval: Approval;
  mandate: Record<string, unknown>;
  typedData: Record<string, unknown>;
};
const usdt = (minor: string | bigint) => `${(Number(minor) / 1e6).toFixed(2)} USDT`;
const every = (seconds: number) =>
  seconds % 86_400 === 0
    ? `${seconds / 86_400} day${seconds === 86_400 ? '' : 's'}`
    : seconds % 60 === 0
      ? `${seconds / 60} minutes`
      : `${seconds} seconds`;

/**
 * Subscriptions in live mode: merchant plans and renewals, the customer's own subscriptions and
 * cancellation, and the hosted subscribe page (approval first when needed, then the mandate).
 */
export function createApiSubscriptions({ api, mApi, mPost, post, hold, take, settled }: ApiKit) {
  const plan = (id: string) => `/v1/commerce/plans/${encodeURIComponent(id)}`;

  async function waitForApproval(planId: string, key: string, seconds = 45, changeId?: string) {
    for (let i = 0; i < seconds; i++) {
      const readiness = await api<Approval>(changeId ? `${change(changeId)}/change-approval/${key}?planId=${encodeURIComponent(planId)}` : `${plan(planId)}/approval/${key}`);
      if (readiness.status === 'ready') return;
      if (readiness.status !== 'pending' && readiness.status !== 'needs_approval')
        throw new DataError(readiness.reason ?? readiness.status, 'The approval did not go through.', 409);
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new DataError('approval_pending', 'The approval is still confirming. Try again in a moment.', 409);
  }
  const mandateRequest = (planId: string, intent: SubscriptionIntent, name: string): Promise<SignRequest> =>
    hold(
      'subscribe',
      { planId, mandate: intent.mandate },
      {
        title: `Subscribe to ${name}`,
        lines: [
          {
            label: 'Up to',
            value: `${usdt(String(intent.mandate.amountCap))} every ${every(Number(intent.mandate.periodSeconds))}`,
          },
          { label: 'Periods', value: String(intent.mandate.maxPeriods) },
          { label: 'Cancel', value: 'Any time, at no cost' },
        ],
        typedData: intent.typedData,
      },
    );
  async function prepareSubscribe(planId: string, approvalKey?: string): Promise<SignRequest> {
    const intent = await post<SubscriptionIntent>(
      `${plan(planId)}/subscription-intent`,
      approvalKey ? { approvalKey } : {},
    );
    const offer = await api<{ plan: { name: string } }>(plan(planId));
    const { approval } = intent;
    if (approval.status === 'ready') return mandateRequest(planId, intent, offer.plan.name);
    if (approval.status === 'pending') {
      await waitForApproval(planId, intent.approvalKey);
      return prepareSubscribe(planId, intent.approvalKey);
    }
    if (approval.status === 'needs_funding')
      throw new DataError('needs_funds', 'Your balance is too low for the first period.', 409);
    if (
      approval.status !== 'needs_approval' ||
      !approval.message ||
      !approval.approvalNonce ||
      !approval.deadline
    )
      throw new DataError(
        approval.reason ?? 'approval_unavailable',
        'Subscribing is not available right now.',
        409,
      );
    return hold(
      'subscribe-approval',
      {
        planId,
        approvalKey: intent.approvalKey,
        approvalNonce: approval.approvalNonce,
        deadline: approval.deadline,
      },
      {
        title: `Subscribe to ${offer.plan.name}`,
        lines: [{ label: 'Allows renewals up to', value: usdt(approval.amount) }],
        typedData: {},
        approval: {
          message: approval.message,
          delegate: approval.authorizationRequired ? approval.delegate : null,
          nonce:
            approval.authorizationRequired && approval.authorizationNonce !== null
              ? Number(approval.authorizationNonce)
              : null,
        },
      },
    );
  }

  const merchant: Pick<
    MerchantData,
    'plans' | 'createPlan' | 'subscriptions' | 'subscription' | 'runRenewal'
  > = {
    plans: async () => (await mApi<{ data: PlanSummary[] }>('/v1/subscriptions/plans')).data,
    createPlan: input =>
      mPost<PlanSummary>('/v1/subscriptions/plans', {
        name: input.name,
        amount: input.amount,
        periodSeconds: input.periodSeconds,
        ...(input.maxPeriods !== undefined && { maxPeriods: input.maxPeriods }),
        ...(input.trialDays !== undefined && { trialDays: input.trialDays }),
        ...(input.description !== undefined && { description: input.description }),
      }),
    async subscriptions(filter?: ListFilter) {
      const { data } = await mApi<{ data: SubscriptionDetail[] }>('/v1/subscriptions?expand=detail');
      const query = filter?.query?.trim().toLowerCase();
      return data.filter(
        s =>
          (!filter?.status || filter.status === 'all' || s.status === filter.status) &&
          (!filter?.customerId || s.customerId === filter.customerId) &&
          (!query ||
            `${s.id} ${s.plan} ${s.customerEmail ?? ''} ${s.customerName ?? ''}`
              .toLowerCase()
              .includes(query)),
      );
    },
    subscription: id => mApi<SubscriptionDetail>(`/v1/subscriptions/${encodeURIComponent(id)}`),
    async runRenewal(id) {
      // The keeper sends it to the contract even when early or cancelled; the contract decides.
      // It waits for the transaction's charge or refusal, so allow longer than the default.
      const result = await mApi<{
        status: string;
        txHash: string;
        refusal: string | null;
        subscription: SubscriptionDetail;
      }>(`/v1/subscriptions/${encodeURIComponent(id)}/renew`, {
        method: 'POST',
        body: '{}',
        signal: AbortSignal.timeout(60_000),
      });
      const refusal: RefusalEvent | null = result.refusal
        ? {
            id: `${id}:${result.txHash}`,
            objectId: id,
            reason: result.refusal,
            txHash: result.txHash as `0x${string}`,
            createdAt: new Date().toISOString(),
            source: 'subscription',
            layer: null,
            detail: reasonDetail(result.refusal),
            actor: null,
          }
        : null;
      return { subscription: result.subscription, refusal };
    },
  };

  const change = (id: string) => `/v1/commerce/me/subscriptions/${encodeURIComponent(id)}`;
  async function prepareChange(id: string, planId: string, approvalKey?: string): Promise<SignRequest> {
    const intent = await post<SubscriptionIntent>(`${change(id)}/change-intent`, {
      planId,
      ...(approvalKey ? { approvalKey } : {}),
    });
    const offer = await api<{ plan: { name: string } }>(plan(planId));
    const { approval } = intent;
    if (approval.status === 'pending') {
      await waitForApproval(planId, intent.approvalKey, 45, id);
      return prepareChange(id, planId, intent.approvalKey);
    }
    if (approval.status === 'needs_funding')
      throw new DataError('needs_funds', 'Your balance is too low for the new plan.', 409);
    if (approval.status === 'needs_approval') {
      if (!approval.message || !approval.approvalNonce || !approval.deadline)
        throw new DataError('approval_unavailable', 'Changing plans is not available right now.', 409);
      return hold(
        'change-approval',
        {
          id,
          planId,
          approvalKey: intent.approvalKey,
          approvalNonce: approval.approvalNonce,
          deadline: approval.deadline,
        },
        {
          title: `Switch to ${offer.plan.name}`,
          lines: [{ label: 'Allows renewals up to', value: usdt(approval.amount) }],
          typedData: {},
          approval: {
            message: approval.message,
            delegate: approval.authorizationRequired ? approval.delegate : null,
            nonce:
              approval.authorizationRequired && approval.authorizationNonce !== null
                ? Number(approval.authorizationNonce)
                : null,
          },
        },
      );
    }
    if (approval.status !== 'ready')
      throw new DataError(
        approval.reason ?? 'approval_unavailable',
        'Changing plans is not available right now.',
        409,
      );
    return hold(
      'change-mandate',
      { id, planId, mandate: intent.mandate },
      {
        title: `Switch to ${offer.plan.name}`,
        lines: [
          {
            label: 'Up to',
            value: `${usdt(String(intent.mandate.amountCap))} every ${every(Number(intent.mandate.periodSeconds))}`,
          },
          { label: 'Your current plan', value: 'Ends in the same transaction' },
        ],
        typedData: intent.typedData,
        continues: true,
      },
    );
  }

  const customer: Pick<
    CustomerData,
    | 'subscriptions'
    | 'subscription'
    | 'availablePlans'
    | 'prepareCancel'
    | 'submitCancel'
    | 'prepareChangePlan'
    | 'submitChangePlan'
  > = {
    prepareChangePlan: (id, planId) => prepareChange(id, planId),
    async submitChangePlan(token, signature) {
      const held = (await take('change', token)) as {
        id: string;
        planId: string;
        intent: unknown;
        data: string;
      };
      await post(`${change(held.id)}/change`, {
        planId: held.planId,
        intent: held.intent,
        data: held.data,
        signature,
      });
      const done = await settled(
        () => customer.subscription(held.id),
        s => s.status === 'cancelled',
      );
      const replacement = (await customer.subscriptions()).find(
        s => s.planId === held.planId && s.status !== 'cancelled',
      );
      return replacement ?? done;
    },
    subscriptions: async () =>
      (await api<{ data: SubscriptionDetail[] }>('/v1/commerce/me/subscriptions')).data,
    subscription: id => api<SubscriptionDetail>(`/v1/commerce/me/subscriptions/${encodeURIComponent(id)}`),
    availablePlans: async () =>
      (await api<{ data: AvailablePlan[] }>('/v1/commerce/me/available-plans')).data,
    async prepareCancel(id) {
      const [current, request] = await Promise.all([
        customer.subscription(id),
        post<{ data: string; intent: Record<string, unknown>; typedData: Record<string, unknown> }>(
          `/v1/commerce/me/subscriptions/${encodeURIComponent(id)}/cancel-intent`,
          {},
        ),
      ]);
      return hold(
        'cancel',
        { id, data: request.data, intent: request.intent },
        {
          title: 'Cancel subscription',
          lines: [
            { label: 'Plan', value: current.plan },
            { label: 'Takes effect', value: 'In the next block. No further renewals.' },
          ],
          typedData: request.typedData,
        },
      );
    },
    async submitCancel(token, signature) {
      const held = (await take('cancel', token)) as { id: string; data: string; intent: unknown };
      await post(`/v1/commerce/me/subscriptions/${encodeURIComponent(held.id)}/cancel`, {
        intent: held.intent,
        data: held.data,
        signature,
      });
      return settled(
        () => customer.subscription(held.id),
        s => s.status === 'cancelled',
      );
    },
  };

  const checkout: Pick<CheckoutData, 'planOffer' | 'prepareSubscribe' | 'submitSubscribe'> = {
    async planOffer(planId): Promise<PlanOffer> {
      const offer = await api<{
        plan: Omit<PlanSummary, 'activeSubscribers' | 'monthlyRecurringMinor'> & { status: string };
        brand: { brandName: string; logoUrl: string | null };
      }>(plan(planId)).catch(error => {
        throw error instanceof DataError && error.status === 404
          ? new DataError('not_found', 'This plan is not available.', 404)
          : error;
      });
      // When a customer is signed in, show their existing subscription to this plan.
      const mine = await customer.subscriptions().catch(() => [] as SubscriptionDetail[]);
      // The API knows the account subject as well as the wallet. A wallet-only
      // history check can promise a trial the server will correctly refuse.
      const trialDays = offer.plan.trialDays
        ? await api<{ trialDays: number }>(`${plan(planId)}/trial-eligibility`).then(v => v.trialDays).catch(() => 0)
        : 0;
      const existing = mine.find(
        s => s.planId === planId && ['trialing', 'active', 'past_due', 'pending'].includes(s.status),
      );
      return {
        plan: { ...offer.plan, trialDays, activeSubscribers: 0, monthlyRecurringMinor: '0' },
        brand: { brandName: offer.brand.brandName || 'This business', logoUrl: offer.brand.logoUrl },
        subscriptionId: existing?.id ?? null,
        available: offer.plan.status !== 'archived',
      };
    },
    prepareSubscribe: planId => prepareSubscribe(planId),
    async submitSubscribe(token, signature) {
      const held = (await take('subscribe', token)) as { planId: string; mandate: Record<string, unknown> };
      const created = await post<{ id: string }>(`${plan(held.planId)}/subscribe`, {
        mandate: held.mandate,
        signature,
      });
      await settled(
        () => customer.subscription(created.id),
        s => s.status !== 'pending',
      );
      return { subscriptionId: created.id };
    },
  };

  return {
    merchant,
    customer,
    checkout,
    /** Second step of a plan change: the signed mandate becomes the Router intent that swaps plans. */
    async continueChange(token: string, signature: string): Promise<SignRequest> {
      const held = (await take('change-mandate', token)) as {
        id: string;
        planId: string;
        mandate: Record<string, unknown>;
      };
      const route = await post<{
        data: string;
        intent: Record<string, unknown>;
        typedData: Record<string, unknown>;
      }>(`${change(held.id)}/change-route`, { planId: held.planId, mandate: held.mandate, signature });
      return hold(
        'change',
        { id: held.id, planId: held.planId, intent: route.intent, data: route.data },
        { title: 'Confirm plan change', lines: [], typedData: route.typedData },
      );
    },
    /** The approval step of a plan change, then the mandate to sign. */
    async submitChangeApproval(token: string, approval: ApprovalSignature): Promise<SignRequest> {
      const held = (await take('change-approval', token)) as {
        id: string;
        planId: string;
        approvalKey: string;
        approvalNonce: string;
        deadline: string;
      };
      await post(`${change(held.id)}/change-approval`, {
        planId: held.planId,
        approvalKey: held.approvalKey,
        approvalNonce: held.approvalNonce,
        deadline: held.deadline,
        signature: approval.signature,
        ...(approval.authorization && { authorization: approval.authorization }),
      });
      await waitForApproval(held.planId, held.approvalKey, 45, held.id);
      return prepareChange(held.id, held.planId, held.approvalKey);
    },
    /** The approval step of subscribing: relayed, confirmed, then the mandate to sign. */
    async submitSubscribeApproval(token: string, approval: ApprovalSignature): Promise<SignRequest> {
      const held = (await take('subscribe-approval', token)) as {
        planId: string;
        approvalKey: string;
        approvalNonce: string;
        deadline: string;
      };
      await post(`${plan(held.planId)}/approval`, {
        approvalKey: held.approvalKey,
        approvalNonce: held.approvalNonce,
        deadline: held.deadline,
        signature: approval.signature,
        ...(approval.authorization && { authorization: approval.authorization }),
      });
      await waitForApproval(held.planId, held.approvalKey);
      return prepareSubscribe(held.planId, held.approvalKey);
    },
  };
}
