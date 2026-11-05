import type { Address } from 'viem';
import type { IdentitySession, MerchantRegistration, MerchantSettings, MerchantSettingsUpdate, FeePreview, RenewalStatus, FinancedInvoice, FinancingOverview, PreparedFinancingTransactions } from './api-types.js';
import type { SubscriptionReplacementRequest, SubscriptionReplacement, SubscriptionV2Request, CancellationV2Request, ApiKeyCreated, DashboardSummary, PaymentLink, PaymentLinkRequest, WebhookDelivery, WebhookEvent, ApiConfig, ApprovalReadiness, ApprovalRequest, CancellationRequest, ExportReport, ExportRequest, GasTank, IntentRequest, IntentSubmission, Invoice, InvoicePayment, InvoiceRequest, ListResponse, MandateNonce, PaymentCreated, PaymentDetails, PaymentListItem, PaymentRequest, RefusalAttempt, RefundDetails, RefundRequest, RefundSubmission, RenewalRequest, Subscription, SubscriptionCreated, SubscriptionMutation, SubscriptionPlan, SubscriptionPlanRequest, SubscriptionRequest } from './api-types.js';
export type * from './api-types.js';
import { parseUsdt } from './amount.js';

export interface TransportRequest {
  method: 'GET' | 'POST';
  path: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}
export interface TransportResponse {
  status: number;
  body: unknown;
}
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export class PactApiError extends Error {
  get code(): string | undefined {
    const error = (this.details as { error?: { code?: unknown } } | null)?.error;
    return typeof error?.code === 'string' ? error.code : undefined;
  }
  constructor(public readonly status: number, public readonly details: unknown) {
    super(`Pact API returned ${status}`);
    this.name = 'PactApiError';
  }
}

export function fetchTransport(baseUrl: string, fetcher: typeof fetch = fetch): Transport {
  const base = baseUrl.replace(/\/$/, '');
  return async ({ method, path, headers, body, signal }) => {
    const response = await fetcher(`${base}${path}`, { method, headers, body, signal });
    const text = await response.text();
    let data: unknown = text;
    if (text) { try { data = JSON.parse(text); } catch { /* CSV and plain-text exports are valid. */ } }
    return { status: response.status, body: data };
  };
}

export interface PactClientOptions {
  transport: Transport;
  apiKey?: string;
  /** For browser sessions, e.g. Privy's getAccessToken. Called for every request;
   * a missing session never falls back to an API key. */
  getAccessToken?: () => Promise<string | null>;
}

export interface RequestOptions { signal?: AbortSignal; idempotencyKey?: string }
/** Existing AbortSignal arguments remain supported. No method automatically retries. */
export type RequestControl = RequestOptions | AbortSignal;
function controls(value?: RequestControl): RequestOptions {
  return value && 'aborted' in value ? { signal: value } : value ?? {};
}
function signed(input: IntentRequest) {
  if (!input?.intent || !input.signature || !input.data) throw new TypeError('Signed intent, data and signature are required');
}
function positiveAmount(value: string) { if (parseUsdt(value) <= 0n) throw new RangeError('USDT amount must be positive'); }

/** Injectable transport keeps every API method usable with fetch or a local mock. */
export class PactClient {
  constructor(private readonly options: PactClientOptions) {
    // Preserve the original arrow-method binding for destructured export calls.
    this.export = this.export.bind(this);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, control?: RequestControl): Promise<T> {
    const { signal, idempotencyKey } = controls(control);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey !== undefined && method === 'POST') {
      if (!idempotencyKey.length || idempotencyKey.length > 255) throw new RangeError('Idempotency key must contain 1–255 characters');
      headers['idempotency-key'] = idempotencyKey;
    }
    const credential = this.options.getAccessToken ? await this.options.getAccessToken() : this.options.apiKey;
    if (this.options.getAccessToken && !credential) throw new PactApiError(401, { error: { code: 'authentication_required' } });
    if (credential) headers.authorization = `Bearer ${credential}`;
    const result = await this.options.transport({
      method, path, headers,
      body: body === undefined ? undefined : JSON.stringify(body, (_, value: unknown) => typeof value === 'bigint' ? value.toString() : value),
      signal,
    });
    if (result.status < 200 || result.status >= 300) throw new PactApiError(result.status, result.body);
    return result.body as T;
  }

  auth = {
    session: (control?: RequestControl) => this.request<IdentitySession>('GET', '/v1/auth/session', undefined, control),
    registerMerchant: (control?: RequestControl) => this.request<MerchantRegistration>('POST', '/v1/auth/merchant', {}, control),
  };

  settings = {
    get: (control?: RequestControl) => this.request<MerchantSettings>('GET', '/v1/settings', undefined, control),
    update: (input: MerchantSettingsUpdate, control?: RequestControl) => this.request<MerchantSettings>('POST', '/v1/settings', input, control),
  };
  fees = {
    preview: (maxGas = 300000, control?: RequestControl) => {
      if (!Number.isSafeInteger(maxGas) || maxGas <= 0 || maxGas > 1000000) throw new RangeError('Target gas must be between 1 and 1000000');
      return this.request<FeePreview>('GET', `/v1/fees/preview?${new URLSearchParams({ maxGas: String(maxGas) })}`, undefined, control);
    },
  };

  payments = {
    create: (input: PaymentRequest, signal?: RequestControl) => {
      positiveAmount(input.amount);
      return this.request<PaymentCreated>('POST', '/v1/payments', input, signal);
    },
    get: (id: string, signal?: RequestControl) => this.request<PaymentDetails>('GET', `/v1/payments/${encodeURIComponent(id)}`, undefined, signal),
    list: (signal?: RequestControl) => this.request<ListResponse<PaymentListItem>>('GET', '/v1/payments', undefined, signal),
    getApproval: (id: string, payer: Address, signal?: RequestControl) => this.request<ApprovalReadiness>('GET', `/v1/payments/${encodeURIComponent(id)}/approval?${new URLSearchParams({ payer })}`, undefined, signal),
    approve: (id: string, input: ApprovalRequest, signal?: RequestControl) => {
      const auth = input.authorization;
      if (auth && (!Number.isSafeInteger(auth.nonce) || auth.nonce < 0 || auth.chainId !== 1874 || (auth.yParity !== 0 && auth.yParity !== 1))) throw new RangeError('Authorization requires chain 1874, a safe nonce and yParity 0 or 1');
      const body = { payer: input.payer, approvalNonce: input.approvalNonce, deadline: input.deadline, signature: input.signature,
        ...(auth ? { authorization: { address: auth.address, chainId: auth.chainId, nonce: auth.nonce, r: auth.r, s: auth.s, yParity: auth.yParity } } : {}) };
      return this.request<ApprovalReadiness>('POST', `/v1/payments/${encodeURIComponent(id)}/approval`, body, signal);
    },
    refund: (id: string, input: RefundRequest, signal?: RequestControl) => {
      signed(input);
      if (input.amount !== undefined) positiveAmount(input.amount);
      return this.request<RefundSubmission>('POST', `/v1/payments/${encodeURIComponent(id)}/refund`, input, signal);
    },
  };
  invoices = {
    create: (input: InvoiceRequest, signal?: RequestControl) => {
      if (input.amount !== undefined) positiveAmount(input.amount);
      if (input.amount === undefined && !input.lines?.length) throw new RangeError('Invoice amount or lines required');
      for (const line of input.lines ?? []) {
        positiveAmount(line.unitAmount);
        if (line.quantity !== undefined && (!Number.isSafeInteger(line.quantity) || line.quantity <= 0)) throw new RangeError('Quantity must be a positive safe integer');
      }
      return this.request<Invoice>('POST', '/v1/invoices', input, signal);
    },
    get: (id: string, signal?: RequestControl) => this.request<Invoice>('GET', `/v1/invoices/${encodeURIComponent(id)}`, undefined, signal),
    list: (signal?: RequestControl) => this.request<{ data: Invoice[] }>('GET', '/v1/invoices', undefined, signal),
    send: (id: string, signal?: RequestControl) => this.request<Invoice>('POST', `/v1/invoices/${encodeURIComponent(id)}/send`, {}, signal),
    createPayment: (id: string, input: { amount?: string } = {}, signal?: RequestControl) => {
      if (input.amount !== undefined) positiveAmount(input.amount);
      return this.request<InvoicePayment>('POST', `/v1/invoices/${encodeURIComponent(id)}/payments`, input, signal);
    },
  };
  subscriptions = {
    /** Plans and nonce/list/renew are shared; registration and cancellation have explicit V2 methods. */
    createPlan: (input: SubscriptionPlanRequest, signal?: RequestControl) => {
      positiveAmount(input.amount);
      return this.request<SubscriptionPlan>('POST', '/v1/subscriptions/plans', input, signal);
    },
    getPlan: (id: string, signal?: RequestControl) => this.request<SubscriptionPlan>('GET', `/v1/subscriptions/plans/${encodeURIComponent(id)}`, undefined, signal),
    listPlans: (signal?: RequestControl) => this.request<ListResponse<SubscriptionPlan>>('GET', '/v1/subscriptions/plans', undefined, signal),
    nonce: (payer: Address, signal?: RequestControl) => this.request<MandateNonce>('GET', `/v1/subscriptions/nonce/${encodeURIComponent(payer)}`, undefined, signal),
    create: (input: SubscriptionRequest, signal?: RequestControl) => this.request<SubscriptionCreated>('POST', '/v1/subscriptions', input, signal),
    /** Explicit V2 registration. The payer and merchant sign independently. */
    createV2: (input: SubscriptionV2Request, signal?: RequestControl) => {
      if (!input?.merchantConsent || typeof input.merchantConsent.deadline !== 'bigint' || !input.merchantConsent.signature) throw new TypeError('Merchant consent deadline and signature are required for V2');
      return this.request<SubscriptionCreated>('POST', '/v1/subscriptions', input, signal);
    },
    /** Deadline validity is enforced by the API clock; no automatic renewal/re-signing. */
    cancelV2: (id: string, input: CancellationV2Request, signal?: RequestControl) => {
      if (typeof input?.deadline !== 'bigint' || !input.signature) throw new TypeError('Cancellation deadline and payer signature are required for V2');
      return this.request<SubscriptionMutation>('POST', `/v1/subscriptions/${encodeURIComponent(id)}/cancel`, { deadline: input.deadline, signature: input.signature }, signal);
    },
    /** Payer-signed Router replace call, including the new signed mandate and V2 merchant consent. */
    replace: (id: string, input: SubscriptionReplacementRequest, signal?: RequestControl) => this.request<SubscriptionReplacement>('POST', `/v1/subscriptions/${encodeURIComponent(id)}/replace`, input, signal),
    list: (signal?: RequestControl) => this.request<ListResponse<Subscription>>('GET', '/v1/subscriptions', undefined, signal),
    renewalStatus: (id: string, signal?: RequestControl) => this.request<RenewalStatus>('GET', `/v1/subscriptions/${encodeURIComponent(id)}/renewal`, undefined, signal),
    /** Requires a verified funded-renewal service; authentication alone grants no signing authority. */
    renew: (id: string, input: RenewalRequest = {}, signal?: RequestControl) => {
      if (input.amount !== undefined) positiveAmount(input.amount);
      return this.request<SubscriptionMutation>('POST', `/v1/subscriptions/${encodeURIComponent(id)}/renew`, input, signal);
    },
    cancel: (id: string, input: CancellationRequest, signal?: RequestControl) => {
      signed(input);
      return this.request<SubscriptionMutation>('POST', `/v1/subscriptions/${encodeURIComponent(id)}/cancel`, input, signal);
    },
  };
  paymentLinks = {
    create: (input: PaymentLinkRequest, signal?: RequestControl) => {
      if (input.kind !== 'tip') positiveAmount(input.amount);
      return this.request<PaymentLink>('POST', '/v1/payment-links', input, signal);
    },
    /** Resolving a link increments its visit count in the API. */
    get: (id: string, signal?: RequestControl) => this.request<PaymentLink>('GET', `/v1/payment-links/${encodeURIComponent(id)}`, undefined, signal),
    list: (signal?: RequestControl) => this.request<ListResponse<PaymentLink>>('GET', '/v1/payment-links', undefined, signal),
    deactivate: (id: string, signal?: RequestControl) => this.request<{ id: string; status: 'inactive' }>('POST', `/v1/payment-links/${encodeURIComponent(id)}/deactivate`, {}, signal),
  };
  dashboard = { get: (signal?: RequestControl) => this.request<DashboardSummary>('GET', '/v1/dashboard', undefined, signal) };
  /**
   * Invoice financing, where the receivables contract is deployed. Listing, cancelling and buying back
   * are transactions the merchant's wallet sends: prepare them here, send them, then submit their hashes.
   */
  financing = {
    overview: (signal?: RequestControl) => this.request<FinancingOverview>('GET', '/v1/financing', undefined, signal),
    invoice: (id: string, signal?: RequestControl) => this.request<FinancedInvoice>('GET', `/v1/financing/invoices/${encodeURIComponent(id)}`, undefined, signal),
    prepareListing: (id: string, signal?: RequestControl) => this.request<PreparedFinancingTransactions>('POST', `/v1/financing/invoices/${encodeURIComponent(id)}/list`, {}, signal),
    prepareCancel: (id: string, signal?: RequestControl) => this.request<PreparedFinancingTransactions>('POST', `/v1/financing/invoices/${encodeURIComponent(id)}/cancel`, {}, signal),
    prepareBuyBack: (id: string, signal?: RequestControl) => this.request<PreparedFinancingTransactions>('POST', `/v1/financing/invoices/${encodeURIComponent(id)}/buy-back`, {}, signal),
    submitTransactions: (id: string, hashes: string[], signal?: RequestControl) => {
      if (!hashes.length || hashes.some(h => !/^0x[0-9a-fA-F]{64}$/.test(h))) throw new RangeError('Transaction hashes required');
      return this.request<FinancedInvoice>('POST', `/v1/financing/invoices/${encodeURIComponent(id)}/transactions`, { hashes }, signal);
    },
  };
  /** Server-only administration. configure rotates the webhook signing secret. */
  webhooks = {
    configure: (input: { url: string }, signal?: RequestControl) => this.request<{ url: string; signingSecret: string }>('POST', '/v1/webhooks/config', input, signal),
    test: (signal?: RequestControl) => this.request<{ eventId: string }>('POST', '/v1/webhooks/test', {}, signal),
    events: (signal?: RequestControl) => this.request<ListResponse<WebhookEvent>>('GET', '/v1/webhooks/events', undefined, signal),
    deliveries: (signal?: RequestControl) => this.request<ListResponse<WebhookDelivery>>('GET', '/v1/webhooks/deliveries', undefined, signal),
    replay: (id: string, signal?: RequestControl) => this.request<{ queued: true }>('POST', `/v1/webhooks/events/${encodeURIComponent(id)}/replay`, {}, signal),
  };
  apiKeys = {
    create: (input: { kind: 'publishable' | 'secret' }, signal?: RequestControl) => this.request<ApiKeyCreated>('POST', '/v1/api-keys', input, signal),
    revoke: (id: string, signal?: RequestControl) => this.request<{ revoked: true }>('POST', `/v1/api-keys/${encodeURIComponent(id)}/revoke`, {}, signal),
  };
  config = { get: (signal?: RequestControl) => this.request<ApiConfig>('GET', '/v1/config', undefined, signal) };
  refunds = { list: (signal?: RequestControl) => this.request<ListResponse<RefundDetails>>('GET', '/v1/refunds', undefined, signal) };
  refusals = { list: (signal?: RequestControl) => this.request<ListResponse<RefusalAttempt>>('GET', '/v1/refusals', undefined, signal) };
  intents = {
    create: (input: IntentRequest, signal?: RequestControl) => { signed(input); return this.request<IntentSubmission>('POST', '/v1/intents', input, signal); },
  };
  gasTank = {
    get: (signal?: RequestControl) => this.request<GasTank>('GET', '/v1/gas-tank', undefined, signal),
  };
  export(options: ExportRequest & { format: 'csv' }, signal?: RequestControl): Promise<string>;
  export(options?: ExportRequest & { format?: 'json' }, signal?: RequestControl): Promise<ExportReport>;
  export(options: ExportRequest, signal?: RequestControl): Promise<ExportReport | string>;
  export(options: ExportRequest = {}, signal?: RequestControl): Promise<ExportReport | string> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) if (value) query.set(key, value);
    return this.request<ExportReport | string>('GET', `/v1/export${query.size ? `?${query}` : ''}`, undefined, signal);
  }
}
