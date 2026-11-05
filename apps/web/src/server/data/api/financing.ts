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
 * action and checks the contract's rules first (recording refusals for compliance). The merchant's
 * wallet sends its own transactions (listing, cancelling, buying back). Investors and compliance
 * officers only sign: Pact's relayer submits their orders and pays the gas. Customer payments on a
 * financed invoice go through the Router as usual and reach the holders.
 */
type Prepared = {
  title: string;
  lines: Array<{ label: string; value: string }>;
  transactions: Array<{ to: string; data: string; label: string }>;
};
/** EIP-712 messages to sign (the order, then any USDT permit) and the order to send back. */
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
  transaction_not_found: 'The transaction has not confirmed yet. Refresh in a moment.',
  transaction_sender_mismatch: 'That transaction was sent from another wallet.',
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
  /** Holds a prepared action; the browser wallet sends its transactions and the submit gets their hashes. */
  const prepare = (
    kind: string,
    context: Record<string, unknown>,
    signer: SignRequest['signer'],
    prepared: Prepared,
  ) =>
    hold(kind, context, {
      title: prepared.title,
      lines: prepared.lines,
      typedData: {},
      signer,
      transactions: prepared.transactions,
    });
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
  const hashes = (signature: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(signature);
    } catch {
      parsed = null;
    }
    if (!Array.isArray(parsed) || !parsed.every(h => typeof h === 'string' && /^0x[0-9a-fA-F]{64}$/.test(h)))
      throw new DataError('invalid_transactions', 'The wallet did not return its transaction hashes.', 400);
    return parsed as string[];
  };

  return {
    overview: () => call<MerchantFinancingOverview>('merchant', '/v1/financing'),
    invoice: invoiceId => call<FinancedInvoice>('merchant', `/v1/financing/invoices/${id(invoiceId)}`),
    async prepareRequest(invoiceId) {
      return prepare(
        'financing-list',
        { invoiceId },
        'merchant',
        await post<Prepared>('merchant', `/v1/financing/invoices/${id(invoiceId)}/list`),
      );
    },
    async submitRequest(token, signature) {
      const { invoiceId } = (await take('financing-list', token)) as { invoiceId: string };
      return post<FinancedInvoice>('merchant', `/v1/financing/invoices/${id(invoiceId)}/transactions`, {
        hashes: hashes(signature),
      });
    },
    async prepareCancel(invoiceId) {
      return prepare(
        'financing-cancel',
        { invoiceId },
        'merchant',
        await post<Prepared>('merchant', `/v1/financing/invoices/${id(invoiceId)}/cancel`),
      );
    },
    async submitCancel(token, signature) {
      const { invoiceId } = (await take('financing-cancel', token)) as { invoiceId: string };
      return post<FinancedInvoice>('merchant', `/v1/financing/invoices/${id(invoiceId)}/transactions`, {
        hashes: hashes(signature),
      });
    },
    async prepareBuyBack(invoiceId) {
      return prepare(
        'financing-buy-back',
        { invoiceId },
        'merchant',
        await post<Prepared>('merchant', `/v1/financing/invoices/${id(invoiceId)}/buy-back`),
      );
    },
    async submitBuyBack(token, signature) {
      const { invoiceId } = (await take('financing-buy-back', token)) as { invoiceId: string };
      return post<FinancedInvoice>('merchant', `/v1/financing/invoices/${id(invoiceId)}/transactions`, {
        hashes: hashes(signature),
      });
    },

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
