/**
 * Invoice financing (merchant, investor and compliance sides) and merchant-side agent budgets.
 * Implemented by `mock/financing.ts` and `api/financing.ts`.
 *
 * The rules mirror the receivables contracts the live product will need: a restricted token per
 * financed invoice (approved holders only, a record date, frozen on default), delivery versus
 * payment on purchase, a reserve held back from the advance, and the customer's payment routed
 * straight to the holders.
 */
import type { InvoiceStatus } from '@pactagent/core/api-types';
import type { AgentCall, AgentSession, PaidEndpoint } from '@pactagent/core/platform-types';
import type { SignRequest } from '../types';

// ---------------------------------------------------------------- financing

/**
 * Where an invoice stands in financing. `eligible` invoices have no listing yet;
 * `null` (on `FinancedInvoice.status`) means the invoice cannot be financed now.
 *
 * - `requested`: listed; investors can buy all or part of it.
 * - `funded`: the listing closed with at least part sold; waiting for the customer.
 * - `overdue`: past maturity and unpaid, inside the grace period. The late fee applies.
 * - `defaulted`: the grace period ended unpaid. The token is frozen, the reserve went to the
 *   holders and the merchant owes the rest as a buy-back.
 * - `repaid`: the holders were paid in full by the customer's payment (and the reserve).
 * - `bought_back`: the merchant paid the holders the buy-back; the claim is the merchant's again.
 */
export type FinancingStatus =
  'eligible' | 'requested' | 'funded' | 'overdue' | 'defaulted' | 'repaid' | 'bought_back';

/** The demo's fixed rules. They are assumptions, not underwriting. */
export interface FinancingAssumptions {
  /** Discount per whole day from listing to maturity. */
  dayRateBps: number;
  /** Extra discount when the customer has an overdue or late-paid invoice with this merchant. */
  latePremiumBps: number;
  /** Pact's fee on face value sold, taken from the advance. */
  feeBps: number;
  /** Share of face value sold that the contract holds back until the customer pays. */
  reserveBps: number;
  /** Paid to the holders from the reserve when the customer pays after maturity. */
  lateFeeBps: number;
  graceDays: number;
  /** Transfers stop this many hours before maturity, so the list of who gets paid is fixed. */
  recordDateHours: number;
  /** The smallest share an investor can buy or transfer, unless it is all that is left. */
  minimumShareMinor: string;
}

/**
 * The offer for the whole invoice, priced when it was listed (or as it would be priced now,
 * while it is still eligible). Every amount is for the full face value.
 */
export interface FinancingTerms {
  faceMinor: string;
  /** How the discount is made up. */
  pricing: { dayRateBps: number; days: number; latePremiumBps: number };
  /** The investor's discount to face value. */
  discountBps: number;
  feeBps: number;
  reserveBps: number;
  lateFeeBps: number;
  graceDays: number;
  /** What investors pay: face value less the discount. */
  priceMinor: string;
  discountMinor: string;
  feeMinor: string;
  reserveMinor: string;
  /** Price less Pact's fee: what the merchant ends up with if the customer pays on time. */
  netAdvanceMinor: string;
  /** What the merchant receives the moment investors buy: the net advance less the reserve. */
  upfrontMinor: string;
  lateFeeMinor: string;
  maturityAt: string;
  graceEndsAt: string;
  /** Transfers stop here. */
  recordDateAt: string;
  /** Whole days from now (or from funding, once funded) to maturity. */
  days: number;
  /** The investor's return if the customer pays in full by maturity, in basis points of the price. */
  returnBps: number;
  /** The same return as a simple yearly rate, in basis points. */
  annualBps: number;
}

/** How much of the invoice investors bought, and what that sold part brought the merchant. */
export interface FinancingFunding {
  /** Face value held by investors. */
  soldMinor: string;
  /** While listed: face value still for sale. After the listing closes: the part the merchant kept. */
  unsoldMinor: string;
  /** True while investors can still buy. */
  open: boolean;
  priceMinor: string;
  feeMinor: string;
  reserveMinor: string;
  upfrontMinor: string;
}

/** The reserve the contract held back from the advance. */
export interface FinancingReserve {
  heldMinor: string;
  /** Returned to the merchant once the holders were paid in full. */
  releasedMinor: string;
  /** Paid to the holders: the late fee, or everything on default. */
  toInvestorsMinor: string;
}

/** One holder of the invoice's receivable token. */
export interface FinancingHolder {
  id: string;
  name: string;
  organization: string;
  /** Face value of the claim held. */
  faceMinor: string;
  /** What this holder paid for it (or the share of the original price that came with a transfer). */
  paidMinor: string;
  receivedMinor: string;
  /** Face value plus any late fee, less what was received. */
  owedMinor: string;
  /** In the compliance registry and not expired. */
  approved: boolean;
  /** The signed-in investor. */
  you: boolean;
}

/** Whether the receivable token can change hands now, and why not. */
export interface TransferRules {
  open: boolean;
  reason: string | null;
  recordDateAt: string;
}

export interface FinancingEvent {
  id: string;
  at: string;
  kind:
    | 'requested'
    | 'cancelled'
    | 'withdrawn'
    | 'closed'
    | 'funded'
    | 'advance'
    | 'payment'
    | 'repaid'
    | 'overdue'
    | 'defaulted'
    | 'reserve'
    | 'bought_back'
    | 'transfer'
    | 'refused';
  title: string;
  detail: string;
  amountMinor: string | null;
  txHash: string | null;
}

/** One ledger row for this invoice in the merchant's books. */
export interface FinancingLedgerRow {
  at: string;
  type: string;
  grossMinor: string;
  feeMinor: string;
  netMinor: string;
  txHash: string | null;
}

export interface FinancedInvoice {
  invoiceId: string;
  number: string;
  merchantName: string;
  invoiceStatus: InvoiceStatus;
  createdAt: string;
  dueAt: string | null;
  lines: Array<{ description: string; quantity: number; amountMinor: string }>;
  debtor: {
    name: string;
    company: string | null;
    /** Hidden from investors. */
    email: string | null;
  };
  acknowledged: boolean;
  /** This merchant's records for the debtor, for pricing and the investor's risk notes. */
  debtorHistory: { invoicesPaid: number; invoicesOverdue: number; invoicesPaidLate: number };
  status: FinancingStatus | null;
  /** Why the invoice cannot be financed, when `status` is null. */
  ineligibleReason: string | null;
  terms: FinancingTerms;
  /** The rules the terms were set by. */
  assumptions: FinancingAssumptions;
  funding: FinancingFunding;
  /** Merchant: every holder. Investor: only their own holding. */
  holders: FinancingHolder[];
  /** Investor view: how many other holders there are. */
  otherHolders: number;
  reserve: FinancingReserve;
  /** Paid, or unpaid, after maturity: the late fee applies. */
  late: boolean;
  /** Defaulted: the token is frozen. */
  frozen: boolean;
  transfers: TransferRules;
  /** What the merchant owes the holders after a default. Zero otherwise. */
  buyBackMinor: string;
  requestedAt: string | null;
  fundedAt: string | null;
  repaidAt: string | null;
  overdueAt: string | null;
  defaultedAt: string | null;
  boughtBackAt: string | null;
  /** What the customer still owes on the invoice itself. */
  customerOwesMinor: string;
  /** Everything the holders have received so far. */
  receivedMinor: string;
  /** Everything still owed to the holders. */
  outstandingMinor: string;
  advanceTxHash: string | null;
  timeline: FinancingEvent[];
  /** Merchant view only; empty for investors. */
  ledger: FinancingLedgerRow[];
}

export interface FinancingTotals {
  count: number;
  faceMinor: string;
}

export interface MerchantFinancingOverview {
  invoices: FinancedInvoice[];
  totals: Record<FinancingStatus, FinancingTotals>;
  /** Money received from investors at funding, after Pact's fee and the reserve, all time. */
  advancedMinor: string;
  /** Reserve the contract is holding now. */
  reserveHeldMinor: string;
  /** Customer payments routed to holders, all time. */
  forwardedMinor: string;
  /** Buy-backs owed now on defaulted invoices. */
  buyBackOwedMinor: string;
  /** Open invoices that cannot be financed (drafts, unacknowledged, part-paid or past due). */
  ineligibleCount: number;
  assumptions: FinancingAssumptions;
}

/** An investor's standing in the compliance registry. A testnet stand-in for KYC. */
export interface InvestorApproval {
  status: 'approved' | 'pending' | 'revoked' | 'expired';
  /** ISO 3166 country code. */
  region: string;
  expiresAt: string | null;
}

export interface InvestorAccount {
  name: string;
  organization: string;
  /** USDT the investor can still spend on listings. */
  availableMinor: string;
  approval: InvestorApproval;
  /** Live mode: whether this wallet has sent its application (name, organization, region). */
  applied?: boolean;
  /** Live mode: the investor's wallet address. */
  address?: string;
}

/** What an investor sends compliance before it can be approved. */
export interface InvestorApplication {
  name: string;
  organization: string;
  email: string;
  /** ISO 3166 two-letter country code. */
  region: string;
}

/** Someone the investor can transfer a claim to. */
export interface Counterparty {
  id: string;
  organization: string;
  approved: boolean;
}

export interface InvestorListing {
  investor: InvestorAccount;
  invoice: FinancedInvoice;
  /** True when the signed-in investor holds part of this invoice. */
  owned: boolean;
  counterparties: Counterparty[];
  assumptions: FinancingAssumptions;
}

export interface InvestorPortfolio {
  investor: InvestorAccount;
  positions: FinancedInvoice[];
  totals: {
    investedMinor: string;
    /** Still expected from open positions. */
    expectedMinor: string;
    receivedMinor: string;
    /** Still owed on overdue and defaulted positions. */
    overdueMinor: string;
    open: number;
    overdue: number;
    defaulted: number;
    /** Repaid or bought back. */
    closed: number;
  };
}

export interface RegistryInvestor {
  id: string;
  name: string;
  organization: string;
  email: string;
  address: string;
  approval: InvestorApproval;
  appliedAt: string;
  /** Face value this investor holds across open positions. */
  heldMinor: string;
  positions: number;
}

/** A purchase or transfer the receivables contract refused. */
export interface RegistryRefusal {
  id: string;
  at: string;
  invoiceId: string;
  invoiceNumber: string;
  title: string;
  detail: string;
}

export interface ComplianceRegistry {
  investors: RegistryInvestor[];
  refusals: RegistryRefusal[];
  assumptions: FinancingAssumptions;
}

// ----------------------------------------------------------- agent budgets

/** An AI agent session that may call this merchant's paid API. The owner's caps are read-only here. */
export interface MerchantAgent {
  session: AgentSession;
  owner: { id: string; name: string; company: string | null };
  /** The agent account's USDT balance, public onchain. Null when unknown. */
  balanceMinor: string | null;
  /** Settled with this merchant today. */
  paidToYouTodayMinor: string;
  settledToday: number;
  refusedToday: number;
  recent: AgentCall[];
}

/** A demo preset for "Simulate a request". */
export interface AgentScenario {
  id: string;
  label: string;
  description: string;
  agentId: string;
  endpointId: string;
}

export interface MerchantAgentsOverview {
  agents: MerchantAgent[];
  endpoints: Array<Pick<PaidEndpoint, 'id' | 'method' | 'path' | 'description' | 'priceMinor' | 'scheme'>>;
  recent: AgentCall[];
  /** Empty outside mock mode. */
  scenarios: AgentScenario[];
  merchant: { name: string; address: string };
}

/** Where a refused request stopped: the agent account refuses to sign, or the facilitator refuses to settle. */
export type AgentRefusalStage = 'authorise' | 'settle';

export interface AgentRequestTrace {
  call: AgentCall;
  agent: MerchantAgent;
  endpoint: MerchantAgentsOverview['endpoints'][number] | null;
  merchant: { name: string; address: string };
  network: string;
  /** Pact's fee per settlement. */
  feeMinor: string;
  refusal: { reason: string; detail: string; stage: AgentRefusalStage } | null;
}

export interface FinancingData {
  /** Merchant: every invoice that can be or was financed, with totals. */
  overview(): Promise<MerchantFinancingOverview>;
  /** Merchant: the offer, holders, reserve and timeline for one invoice. */
  invoice(invoiceId: string): Promise<FinancedInvoice>;
  /** Merchant: list an eligible invoice for investors. The merchant's wallet confirms the listing. */
  prepareRequest(invoiceId: string): Promise<SignRequest>;
  submitRequest(token: string, signature: string): Promise<FinancedInvoice>;
  /** Merchant: take the listing down. If part is sold, the merchant keeps the rest. */
  prepareCancel(invoiceId: string): Promise<SignRequest>;
  submitCancel(token: string, signature: string): Promise<FinancedInvoice>;
  /** Merchant: pay the holders what a defaulted invoice still owes them. */
  prepareBuyBack(invoiceId: string): Promise<SignRequest>;
  submitBuyBack(token: string, signature: string): Promise<FinancedInvoice>;

  /** Investor: listed invoices. */
  marketplace(): Promise<{
    investor: InvestorAccount;
    listings: FinancedInvoice[];
    assumptions: FinancingAssumptions;
  }>;
  /** Investor: one listed invoice or one the investor holds part of. */
  listing(invoiceId: string): Promise<InvestorListing>;
  /** Investor: buy `faceMinor` of face value (all or part of what is left). */
  preparePurchase(invoiceId: string, faceMinor: string): Promise<SignRequest>;
  submitPurchase(token: string, signature: string): Promise<FinancedInvoice>;
  /** Investor: move `faceMinor` of a holding to another investor. */
  prepareTransfer(invoiceId: string, toInvestorId: string, faceMinor: string): Promise<SignRequest>;
  submitTransfer(token: string, signature: string): Promise<FinancedInvoice>;
  portfolio(): Promise<InvestorPortfolio>;
  /** Investor: send (or update) the application compliance reviews before approval. */
  apply(application: InvestorApplication): Promise<InvestorAccount>;

  /** Compliance: the investor registry and the refusals it caused. */
  registry(): Promise<ComplianceRegistry>;
  prepareApproval(investorId: string, decision: 'approve' | 'revoke'): Promise<SignRequest>;
  submitApproval(token: string, signature: string): Promise<RegistryInvestor>;

  /**
   * Investor or compliance officer: cancel the orders this wallet signed that did not go through
   * (purchases and transfers, or registry decisions), so none can run later. One signature; Pact
   * submits it.
   */
  prepareCancelOrders(role: 'investor' | 'compliance'): Promise<SignRequest>;
  submitCancelOrders(token: string, signature: string): Promise<{ cancelled: true }>;

  /** Demo control (mock only): the invoice's customer pays the remaining balance. */
  simulateCustomerPayment(invoiceId: string): Promise<FinancedInvoice>;

  /** Merchant: agents paying this merchant, with their owners' caps and recent requests. */
  agents(): Promise<MerchantAgentsOverview>;
  /** Merchant: one paid request, step by step. */
  agentRequest(id: string): Promise<AgentRequestTrace>;
  /** Demo control (mock only): one request through the x402 engine. */
  simulateAgentRequest(scenarioId: string): Promise<AgentRequestTrace>;
}
