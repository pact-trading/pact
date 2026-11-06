import type { Address } from 'viem';
import type { IdentitySession, MerchantRegistration, MerchantSettings, MerchantSettingsUpdate, FeePreview, RenewalStatus, RenewalResult, FinancedInvoice, FinancingOverview, PreparedFinancingSignature, SignedFinancingOrder } from './api-types.js';
import type { AcceptTermsRequest, AcceptedTerms, FeeLedgerEntry, FeeTermsOffer, FeesDetail, MerchantCancellation, MerchantSpender, PermitSignature } from './api-types.js';
import type { SubscriptionReplacementRequest, SubscriptionReplacement, ApiKeyCreated, DashboardSummary, PaymentLink, PaymentLinkRequest, WebhookDelivery, WebhookEvent, ApiConfig, ApprovalReadiness, ApprovalRequest, CancellationRequest, ExportReport, ExportRequest, IntentRequest, IntentSubmission, Invoice, InvoicePayment, InvoiceRequest, ListResponse, MandateNonce, PaymentCreated, PaymentDetails, PaymentListItem, PaymentRequest, RefusalAttempt, RefundDetails, RefundRequest, RefundSubmission, Subscription, SubscriptionCreated, SubscriptionMutation, SubscriptionPlan, SubscriptionPlanRequest, SubscriptionRequest } from './api-types.js';
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
const SIGNATURE = /^0x[0-9a-fA-F]{130}$/;
/** A signed EIP-2612 permit: a deadline and a 65-byte signature, plus the optional nonce. */
function permit(input: PermitSignature) {
  if (input?.deadline === undefined || input.deadline === null || !/^\d+$/.test(String(input.deadline))) throw new TypeError('Permit deadline is required');
  if (typeof input.signature !== 'string' || !SIGNATURE.test(input.signature)) throw new TypeError('Permit signature is required');
  if (input.nonce !== undefined && !/^\d+$/.test(String(input.nonce))) throw new RangeError('Permit nonce must be a non-negative integer');
  return { deadline: input.deadline, signature: input.signature, ...(input.nonce !== undefined ? { nonce: input.nonce } : {}) };
}
function signedOrder(input: SignedFinancingOrder) {
  if (!input?.order || typeof input.order !== 'object' || !Array.isArray(input.signatures) || !input.signatures.length || input.signatures.some(s => typeof s !== 'string' || !SIGNATURE.test(s))) throw new TypeError('The prepared order and its signatures are required');
  return { order: input.order, signatures: input.signatures };
}
const SPENDERS: MerchantSpender[] = ['escrow', 'router'];

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
  /**
   * Pact's fee comes out of each payment, at the rates in the terms the merchant signed. The merchant
   * signs those terms once and two standing USDT permits (refunds and their network fee); Pact's
   * relayer submits every signature, so the merchant never holds WBT.
   */
  fees = {
    /** The merchant's signed terms, permits, 30-day totals and recent fees. */
    get: (control?: RequestControl) => this.request<FeesDetail>('GET', '/v1/fees', undefined, control),
    ledger: (limit = 50, control?: RequestControl) => {
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 500) throw new RangeError('Limit must be between 1 and 500');
      return this.request<ListResponse<FeeLedgerEntry>>('GET', `/v1/fees/ledger?${new URLSearchParams({ limit: String(limit) })}`, undefined, control);
    },
    /** The latest terms and the `AcceptTerms` typed data to sign for them. */
    terms: (control?: RequestControl) => this.request<FeeTermsOffer>('GET', '/v1/fees/terms', undefined, control),
    acceptTerms: (input: AcceptTermsRequest, control?: RequestControl) => {
      if (!Number.isSafeInteger(input?.version) || input.version <= 0) throw new RangeError('Terms version must be a positive integer');
      const { deadline, signature } = permit({ deadline: input.deadline, signature: input.signature });
      return this.request<AcceptedTerms>('POST', '/v1/fees/terms/accept', { version: input.version, deadline, signature }, control);
    },
    /** One standing permit's state, with the typed data to sign when it is missing. */
    permit: (spender: MerchantSpender, control?: RequestControl) => {
      if (!SPENDERS.includes(spender)) throw new RangeError(`Spender must be one of ${SPENDERS.join(', ')}`);
      return this.request<ApprovalReadiness>('GET', `/v1/fees/permits/${spender}`, undefined, control);
    },
    submitPermit: (spender: MerchantSpender, input: PermitSignature, control?: RequestControl) => {
      if (!SPENDERS.includes(spender)) throw new RangeError(`Spender must be one of ${SPENDERS.join(', ')}`);
      return this.request<ApprovalReadiness>('POST', `/v1/fees/permits/${spender}`, permit(input), control);
    },
    /** The most a merchant-paid call (a refund, a buy-back) of `maxGas` can cost in network fees. */
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
    /** Sends the payer's signed USDT permit (`getApproval(...).typedData`); Pact's relayer submits it. */
    approve: (id: string, input: ApprovalRequest, signal?: RequestControl) => {
      if (!input?.payer) throw new TypeError('Payer is required');
      return this.request<ApprovalReadiness>('POST', `/v1/payments/${encodeURIComponent(id)}/approval`, { payer: input.payer, ...permit(input) }, signal);
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
    createPlan: (input: SubscriptionPlanRequest, signal?: RequestControl) => {
      positiveAmount(input.amount);
      return this.request<SubscriptionPlan>('POST', '/v1/subscriptions/plans', input, signal);
    },
    getPlan: (id: string, signal?: RequestControl) => this.request<SubscriptionPlan>('GET', `/v1/subscriptions/plans/${encodeURIComponent(id)}`, undefined, signal),
    listPlans: (signal?: RequestControl) => this.request<ListResponse<SubscriptionPlan>>('GET', '/v1/subscriptions/plans', undefined, signal),
    nonce: (payer: Address, signal?: RequestControl) => this.request<MandateNonce>('GET', `/v1/subscriptions/nonce/${encodeURIComponent(payer)}`, undefined, signal),
    /** Registers the payer's signed mandate (`mandateTypedData`). Only the payer signs; Pact's relayer pays the gas. */
    create: (input: SubscriptionRequest, signal?: RequestControl) => {
      if (!input?.planId || !input.mandate || typeof input.signature !== 'string') throw new TypeError('Plan, mandate and payer signature are required');
      return this.request<SubscriptionCreated>('POST', '/v1/subscriptions', input, signal);
    },
    /** Payer-signed Router replace call, carrying the new signed mandate. */
    replace: (id: string, input: SubscriptionReplacementRequest, signal?: RequestControl) => this.request<SubscriptionReplacement>('POST', `/v1/subscriptions/${encodeURIComponent(id)}/replace`, input, signal),
    list: (signal?: RequestControl) => this.request<ListResponse<Subscription>>('GET', '/v1/subscriptions', undefined, signal),
    renewalStatus: (id: string, signal?: RequestControl) => this.request<RenewalStatus>('GET', `/v1/subscriptions/${encodeURIComponent(id)}/renewal`, undefined, signal),
    /** Runs the next renewal now. The contract decides; a refused charge reports its reason. */
    renew: (id: string, signal?: RequestControl) => this.request<RenewalResult>('POST', `/v1/subscriptions/${encodeURIComponent(id)}/renew`, {}, signal),
    /**
     * The payer's signed cancellation (`cancellationTypedData` over the on-chain ID, deadline at most
     * five minutes ahead), submitted by Pact's relayer.
     */
    cancel: (id: string, input: CancellationRequest, signal?: RequestControl) => {
      if (typeof input?.deadline !== 'bigint' || typeof input.signature !== 'string' || !SIGNATURE.test(input.signature)) throw new TypeError('Cancellation deadline (bigint) and payer signature are required');
      return this.request<SubscriptionMutation>('POST', `/v1/subscriptions/${encodeURIComponent(id)}/cancel`, { deadline: input.deadline, signature: input.signature }, signal);
    },
    /** The merchant ends a subscription off chain, at once. Requires a secret key. */
    cancelAsMerchant: (id: string, signal?: RequestControl) => this.request<MerchantCancellation>('POST', `/v1/subscriptions/${encodeURIComponent(id)}/cancel`, { by: 'merchant' }, signal),
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
   * are orders the merchant signs: prepare one, sign each of its `typedData` in order, then relay the
   * order with the signatures. Pact's relayer submits it; a buy-back pays its own network fee in USDT.
   */
  financing = {
    overview: (signal?: RequestControl) => this.request<FinancingOverview>('GET', '/v1/financing', undefined, signal),
    invoice: (id: string, signal?: RequestControl) => this.request<FinancedInvoice>('GET', `/v1/financing/invoices/${encodeURIComponent(id)}`, undefined, signal),
    prepareListing: (id: string, signal?: RequestControl) => this.request<PreparedFinancingSignature>('POST', `/v1/financing/invoices/${encodeURIComponent(id)}/list`, {}, signal),
    relayListing: (id: string, input: SignedFinancingOrder, signal?: RequestControl) => this.request<FinancedInvoice>('POST', `/v1/financing/invoices/${encodeURIComponent(id)}/list/relay`, signedOrder(input), signal),
    prepareCancel: (id: string, signal?: RequestControl) => this.request<PreparedFinancingSignature>('POST', `/v1/financing/invoices/${encodeURIComponent(id)}/cancel`, {}, signal),
    relayCancel: (id: string, input: SignedFinancingOrder, signal?: RequestControl) => this.request<FinancedInvoice>('POST', `/v1/financing/invoices/${encodeURIComponent(id)}/cancel/relay`, signedOrder(input), signal),
    prepareBuyBack: (id: string, signal?: RequestControl) => this.request<PreparedFinancingSignature>('POST', `/v1/financing/invoices/${encodeURIComponent(id)}/buy-back`, {}, signal),
    relayBuyBack: (id: string, input: SignedFinancingOrder, signal?: RequestControl) => this.request<FinancedInvoice>('POST', `/v1/financing/invoices/${encodeURIComponent(id)}/buy-back/relay`, signedOrder(input), signal),
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
  export(options: ExportRequest & { format: 'csv' }, signal?: RequestControl): Promise<string>;
  export(options?: ExportRequest & { format?: 'json' }, signal?: RequestControl): Promise<ExportReport>;
  export(options: ExportRequest, signal?: RequestControl): Promise<ExportReport | string>;
  export(options: ExportRequest = {}, signal?: RequestControl): Promise<ExportReport | string> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(options)) if (value) query.set(key, value);
    return this.request<ExportReport | string>('GET', `/v1/export${query.size ? `?${query}` : ''}`, undefined, signal);
  }
}
