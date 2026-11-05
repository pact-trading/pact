/** `PACT_DATA=mock` serves every screen from the in-memory demo store; anything else uses the API. */
export const dataMode: 'mock' | 'api' = process.env.PACT_DATA === 'mock' ? 'mock' : 'api';
export const isMock = dataMode === 'mock';
