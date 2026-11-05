# Privy identity integration

Backend identity and SDK session credentials are implemented. Real application credentials, browser login integration and a real email/passkey acceptance run are still required. Adding these environment variables does not automatically replace the dashboard's existing server-side API-key flow.

## Application configuration

Create/select the Privy application and enable email and passkey authentication. Configure the allowed development and production origins for the frontend. Use the same application ID on the API and frontend. App clients, if used, need their corresponding public client ID on the frontend.

Set these values in the API process environment (see `example.env`):

```dotenv
PRIVY_APP_ID=<application ID>
PRIVY_APP_SECRET=<server-only application secret>
# Optional PEM public verification key; empty uses app-scoped JWKS.
PRIVY_VERIFICATION_KEY=
```

The API does not implicitly load dotenv files. Supply values through the process manager or explicitly load an ignored environment file when starting the process. Do not commit credentials, print them in logs, or expose `PRIVY_APP_SECRET` under a `NEXT_PUBLIC_` name. Restart/activation of the live relayer is a separate rollout step; keep its database and single-process ownership intact.

Frontend integration uses a public `NEXT_PUBLIC_PRIVY_APP_ID`, and optionally `NEXT_PUBLIC_PRIVY_CLIENT_ID`. These are planned frontend configuration names, not an already-wired login screen. Use a client-side `PrivyProvider`. For the Privy login modal, configure `embeddedWallets.ethereum.createOnLogin: 'all-users'` so even an account with a linked external wallet obtains an embedded Ethereum wallet. Custom/headless email or passkey flows must explicitly create the embedded wallet after authentication; automatic modal creation does not apply to those flows. Wait for wallet creation before calling the API session endpoint.

The payment network is Whitechain, chain ID `1874`, native currency WBT (18 decimals), RPC `https://rpc.testnet.whitechain.io`. This is the checkout chain configuration; login itself does not send a blockchain transaction.

References: [React provider setup](https://docs.privy.io/basics/react/setup), [automatic wallet creation and headless limitations](https://docs.privy.io/basics/react/advanced/automatic-wallet-creation), [passkey authentication](https://docs.privy.io/authentication/user-authentication/login-methods/passkey), [access tokens](https://docs.privy.io/authentication/user-authentication/access-tokens).

## API and SDK flow

Obtain a fresh access token through Privy's `getAccessToken()` before each API call. Send `Authorization: Bearer <token>`; do not substitute an identity token or an email supplied by the browser.

1. `GET /v1/auth/session` verifies the JWT and reads the user from Privy. It returns the verified user ID, session ID, expiry, primary embedded wallet and verified email (or null). It creates no merchant and sends no transaction.
2. `POST /v1/auth/merchant` with body `{}` explicitly registers a merchant. Repeated or concurrent requests return the same merchant ID. The address is derived on the server, never accepted from the client. No long-lived API secret is issued during registration.
3. Use the same refreshed Bearer token on merchant API routes. Records remain scoped to the bound merchant. Existing secret/publishable API keys still serve server integrations with their existing permissions.

```ts
const client = new PactClient({
  transport: fetchTransport(apiUrl),
  getAccessToken, // from Privy; called on every SDK request
});
const session = await client.auth.session();
const merchant = await client.auth.registerMerchant();
const payments = await client.payments.list();
```

If the token provider returns null or fails, the SDK sends no request and never falls back to an API key. Token refresh does not cause automatic payment retries.

Backend checks ES256 signature, issuer, application audience, expiry, issue time, DID and session claims using `@privy-io/node@0.37.0`. It retrieves the authoritative user and requires exactly one primary (`wallet_index = 0`) user-signable Privy embedded Ethereum wallet. A linked external wallet cannot claim a merchant. Bindings are durable and app-scoped. Existing treasury rows are not automatically claimed by matching email or address; migration needs separate explicit ownership proof. A changed bound wallet is rejected instead of silently moving a merchant.

| Response | Meaning |
| --- | --- |
| 401 `invalid_identity_token` | Missing, invalid, expired or wrong-app token; deleted/mismatched user |
| 403 `merchant_not_registered` | Valid identity, registration required |
| 409 `embedded_wallet_required` | Primary user-signable embedded wallet missing or ambiguous |
| 409 `merchant_address_already_registered` | Existing treasury cannot be auto-claimed |
| 409 `merchant_wallet_changed` | Bound merchant wallet no longer matches |
| 503 `identity_unavailable` | Identity not configured or user lookup unavailable |

The provider SDK maps JWT verification failures, including some JWKS failures, to invalid-token errors. Do not retry writes automatically on these responses. JWT verification is not an instantaneous session-revocation lookup: access tokens may remain valid until expiry after client logout. The SDK stops using them when Privy's token provider returns null; server verification also rechecks current user/wallet ownership for every request.

## Remaining acceptance

- Complete browser email/passkey login, wallet creation, account switching and logout against the configured application.
- Replace the dashboard's legacy shared-token authorization with merchant-scoped sessions before using it as a multi-merchant dashboard.
- Integrate payer EIP-712 and EIP-7702 signatures into the existing sponsored approval flow; verify actual Privy signing against chain 1874.
- Treat background merchant signing as a separate explicit wallet authorization with bounded signer policies. An application secret or successful login does not authorize arbitrary wallet signing or relayer spending.

Local tests use real ES256 signatures and the official verification SDK with synthetic credentials and a stubbed user lookup. They do not prove an actual Privy application is configured or live login works.

The separately configured sign-only merchant transport is implemented in `src/privy-merchant-signer.ts`; see [Privy signing](PRIVY_SIGNING.md). It validates actual provider delegation/policy and uses an external authorization callback. Owner enrollment and production activation are not supplied by identity configuration.
