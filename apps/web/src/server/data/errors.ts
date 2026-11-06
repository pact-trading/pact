/** A refused or invalid action, carrying the same reason codes the API uses. */
export class DataError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}

/** The screen exists but its API endpoint does not yet; see docs/wiring-backlog.md. */
export class NotWiredError extends DataError {
  constructor(readonly feature: string) {
    super('not_wired', `${feature} is not connected to the API yet.`, 501);
  }
}

export const notFound = (what: string) => new DataError('not_found', `${what} was not found.`, 404);

/**
 * Why an approval (a USDT permit Pact relays) cannot be offered now, for the reasons a person can act
 * on; anything else keeps `fallback`.
 */
export function approvalUnavailable(reason: string | undefined, fallback: string) {
  if (reason === 'approval_budget') return 'Pact is relaying many approvals right now. Try again in a minute.';
  if (reason === 'approval_gas_price') return 'Network gas is unusually expensive right now. Try again shortly.';
  if (reason === 'rpc_unavailable') return 'The network is not reachable right now. Try again in a moment.';
  return fallback;
}
