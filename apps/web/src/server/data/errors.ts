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

/** The screen exists but its API endpoint does not yet. */
export class NotWiredError extends DataError {
  constructor(readonly feature: string) {
    super('not_wired', `${feature} is not connected to the API yet.`, 501);
  }
}

export const notFound = (what: string) => new DataError('not_found', `${what} was not found.`, 404);
