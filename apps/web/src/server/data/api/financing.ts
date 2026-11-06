import 'server-only';
import { roleApi, SessionError, type SessionRole } from '../../api-client';
import { DataError, NotWiredError } from '../errors';
import type {
  AgentRequestTrace,
  ComplianceRegistry,
  FinancedInvoice,
  FinancingData,
  InvestorAccount,
  InvestorListing,
  InvestorPortfolio,
  MerchantAgentsOverview,
  MerchantFinancingOverview,
  RegistryInvestor,
} from '../parts/financing';
import type { SignRequest } from '../types';
import type { ApiKit } from './source';

/**
 * Invoice financing on the receivables contract and the investor registry. The API prepares each
 * action and checks the contract's rules first (recording refusals for compliance). Merchants,
 * investors and compliance officers only sign: Pact's relayer submits their orders and pays the gas
 * (a buy-back pays its own network fee in USDT). Customer payments on a financed invoice go through
 * the Router as usual and reach the holders.
 */
/** EIP-712 messages to sign (any USDT permits, then the order) and the order to send back. */
type PreparedSignature = {
  title: string;
  lines: Array<{ label: string; value: string }>;
  typedData: Array<Record<string, unknown>>;
  order: Record<string, string>;
};

const messages: Record<string, string> = {
  login_required: 'Sign in to continue.',
  invalid_identity_token: 'Your session ended. Sign in again.',
  financing_unavailable: 'Invoice financing is not deployed on this network.',
  transaction_reverted: 'The transaction was reverted on chain.',
  relay_limit: 'Pact relays a limited number of signed orders an hour for each wallet. Try again later.',
};

export function createApiFinancing({ mApi, hold, take }: ApiKit): FinancingData {
  const call = async <T>(role: SessionRole, path: string, init?: RequestInit): Promise<T> => {
    try {
      return await roleApi<T>(role, path, init);
    } catch (error) {
      // No receivables contracts on this network: the screens link to the demo instead.
      if (error instanceof SessionError && error.code === 'financing_unavailable')
        throw new NotWiredError(
          path.startsWith('/v1/compliance')
            ? 'Investor registry'
            : path.startsWith('/v1/investor')
              ? 'Investor marketplace'
              : 'Invoice financing',
        );
      if (error instanceof SessionError)
        throw new DataError(
          error.code,
          error.detail ?? messages[error.code] ?? error.code.replaceAll('_', ' '),
          error.status,
        );
      throw error;
    }
  };
  const post = <T>(role: SessionRole, path: string, body: unknown = {}) =>
    call<T>(role, path, { method: 'POST', body: JSON.stringify(body) });
  const id = encodeURIComponent;
  /** Holds a signed-order action: the wallet signs every message in one confirmation, Pact relays. */
  const sign = (
    kind: string,
    context: Record<string, unknown>,
    signer: SignRequest['signer'],
    prepared: PreparedSignature,
  ) =>
    hold(
      kind,
      { ...context, order: prepared.order, count: prepared.typedData.length },
      {
        title: prepared.title,
        lines: prepared.lines,
        typedData: prepared.typedData[0],
        ...(prepared.typedData.length > 1 ? { also: prepared.typedData.slice(1) } : {}),
        signer,
      },
    );
  /** The signatures, primary first: one string, or a JSON array when there were extra messages. */
  const signatures = (signature: string, count: number) => {
    if (count === 1) return [signature];
    let parsed: unknown;
    try {
      parsed = JSON.parse(signature);
    } catch {
      parsed = null;
    }
    if (!Array.isArray(parsed) || parsed.length !== count)
      throw new DataError('invalid_signature', 'The wallet did not sign every message.', 400);
    return parsed as string[];
  };
  const relay = async <T>(
    role: SessionRole,
    kind: string,
    token: string,
    signature: string,
    path: (held: Record<string, string>) => string,
  ) => {
    const held = (await take(kind, token)) as Record<string, string> & {
      order: Record<string, string>;
      count: number;
    };
    return post<T>(role, path(held), { order: held.order, signatures: signatures(signature, held.count) });
  };

  return {
    overview: () => call<MerchantFinancingOverview>('merchant', '/v1/financing'),
    invoice: invoiceId => call<FinancedInvoice>('merchant', `/v1/financing/invoices/${id(invoiceId)}`),
    // The merchant signs each order; Pact's relayer submits it, so the merchant needs no WBT.
    async prepareRequest(invoiceId) {
      return sign(
        'financing-list',
        { invoiceId },
        'merchant',
        await post<PreparedSignature>('merchant', `/v1/financing/invoices/${id(invoiceId)}/list`),
      );
    },
    submitRequest: (token, signature) =>
      relay<FinancedInvoice>(
        'merchant',
        'financing-list',
        token,
        signature,
        held => `/v1/financing/invoices/${id(held.invoiceId)}/list/relay`,
      ),
    async prepareCancel(invoiceId) {
      return sign(
        'financing-cancel',
        { invoiceId },
        'merchant',
        await post<PreparedSignature>('merchant', `/v1/financing/invoices/${id(invoiceId)}/cancel`),
      );
    },
    submitCancel: (token, signature) =>
      relay<FinancedInvoice>(
        'merchant',
        'financing-cancel',
        token,
        signature,
        held => `/v1/financing/invoices/${id(held.invoiceId)}/cancel/relay`,
      ),
    async prepareBuyBack(invoiceId) {
      return sign(
        'financing-buy-back',
        { invoiceId },
        'merchant',
        await post<PreparedSignature>('merchant', `/v1/financing/invoices/${id(invoiceId)}/buy-back`),
      );
    },
    submitBuyBack: (token, signature) =>
      relay<FinancedInvoice>(
        'merchant',
        'financing-buy-back',
        token,
        signature,
        held => `/v1/financing/invoices/${id(held.invoiceId)}/buy-back/relay`,
      ),

    marketplace: () =>
      call<{
        investor: InvestorAccount;
        listings: FinancedInvoice[];
        assumptions: FinancedInvoice['assumptions'];
      }>('investor', '/v1/investor/marketplace'),
    listing: invoiceId => call<InvestorListing>('investor', `/v1/investor/listings/${id(invoiceId)}`),
    async preparePurchase(invoiceId, faceMinor) {
      return sign(
        'financing-purchase',
        { invoiceId },
        'investor',
        await post<PreparedSignature>('investor', `/v1/investor/listings/${id(invoiceId)}/purchase`, {
          faceMinor,
        }),
      );
    },
    submitPurchase: (token, signature) =>
      relay<FinancedInvoice>(
        'investor',
        'financing-purchase',
        token,
        signature,
        held => `/v1/investor/listings/${id(held.invoiceId)}/purchase/relay`,
      ),
    async prepareTransfer(invoiceId, toInvestorId, faceMinor) {
      return sign(
        'financing-transfer',
        { invoiceId },
        'investor',
        await post<PreparedSignature>('investor', `/v1/investor/listings/${id(invoiceId)}/transfer`, {
          to: toInvestorId,
          faceMinor,
        }),
      );
    },
    submitTransfer: (token, signature) =>
      relay<FinancedInvoice>(
        'investor',
        'financing-transfer',
        token,
        signature,
        held => `/v1/investor/listings/${id(held.invoiceId)}/transfer/relay`,
      ),
    portfolio: () => call<InvestorPortfolio>('investor', '/v1/investor/portfolio'),
    apply: application => post<InvestorAccount>('investor', '/v1/investor/me/application', application),

    registry: () => call<ComplianceRegistry>('compliance', '/v1/compliance/registry'),
    async prepareApproval(investorId, decision) {
      return sign(
        'financing-approval',
        { investorId },
        'compliance',
        await post<PreparedSignature>('compliance', `/v1/compliance/investors/${id(investorId)}`, {
          decision,
        }),
      );
    },
    submitApproval: (token, signature) =>
      relay<RegistryInvestor>(
        'compliance',
        'financing-approval',
        token,
        signature,
        held => `/v1/compliance/investors/${id(held.investorId)}/relay`,
      ),
    async prepareCancelOrders(role) {
      const base = role === 'investor' ? '/v1/investor' : '/v1/compliance';
      return sign(
        'financing-cancel-orders',
        { role },
        role,
        await post<PreparedSignature>(role, `${base}/orders/cancel`),
      );
    },
    async submitCancelOrders(token, signature) {
      const held = (await take('financing-cancel-orders', token)) as {
        role: 'investor' | 'compliance';
        order: Record<string, string>;
        count: number;
      };
      const base = held.role === 'investor' ? '/v1/investor' : '/v1/compliance';
      await post(held.role, `${base}/orders/cancel/relay`, {
        order: held.order,
        signatures: signatures(signature, held.count),
      });
      return { cancelled: true as const };
    },

    // Demo control: in live mode the customer pays through the normal invoice link.
    simulateCustomerPayment: () => Promise.reject(new NotWiredError('Demo customer payment')),
    agents: () => mApi<MerchantAgentsOverview>('/v1/agents/overview'),
    agentRequest: requestId => mApi<AgentRequestTrace>(`/v1/agents/calls/${encodeURIComponent(requestId)}`),
    simulateAgentRequest: () => Promise.reject(new NotWiredError('Demo agent requests')),
  };
}
