# Privy setup for Pact commerce

Use the same Privy application for the web App ID and API credentials. Merge the
following fields into the existing local env files; do not replace chain addresses,
database paths, relayer credentials or cookie secrets with example values.

| File | Fields |
| --- | --- |
| `web/.env.local` | `NEXT_PUBLIC_PRIVY_APP_ID`, optional `NEXT_PUBLIC_PRIVY_CLIENT_ID` |
| API process environment | `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, optional `PRIVY_VERIFICATION_KEY` |
| Web behind a proxy | `PACT_PUBLIC_ORIGIN`, the exact public web origin |

The currently prepared API env is `api/.runtime/whitechain-v2/api.env`. It is
ignored and private. Editing it does not reload the already-running API process.
Next public variables require a rebuild/restart for a production build.

Enable email in Privy's Authentication settings and allow the actual web origin.
The GOL app currently permits `http://localhost:3000`; `127.0.0.1` is a different
origin. App clients are optional for React and can override allowed origins.
See [login methods](https://docs.privy.io/basics/get-started/dashboard/configure-login-methods)
and [app clients](https://docs.privy.io/basics/get-started/dashboard/app-clients).

Pact uses Privy's login modal with automatic Ethereum wallet creation for all
users. This is already in `auth-provider.tsx`; direct custom OTP flows would need
separate wallet creation. See [automatic wallet creation](https://docs.privy.io/basics/react/advanced/automatic-wallet-creation).

Local GOL configuration was reused at the user's request. Its app credentials
were verified with a read-only provider request. Email is enabled; passkey is
disabled. Do not change this shared app's settings without considering its other
consumers. No authorization private key or server signing delegation is needed
for Pact's user-owned signing flow.

After the controlled API rollout, open `/login`, authenticate and explicitly
register a merchant. A new Privy merchant wallet is a new merchant identity; it
does not inherit the bootstrap merchant's funds, approvals or orders by email.
Fund and configure the correct testnet merchant/payer before the live acceptance
journey. Provider configuration alone does not prove EIP-7702 support on chain 1874.

To repeat the migration rehearsal from the API directory, choose a new private
output directory each time:

```sh
pnpm exec tsx scripts/rehearse-commerce-migration.ts \
  .runtime/whitechain-v2/settle.sqlite \
  .runtime/commerce-rehearsal-next
```

This command never starts an API, keeper or signer. Its `before.sqlite` is the
untouched snapshot; `candidate.sqlite` is disposable and must not replace a live
database that has received newer writes. At rollout, take a fresh backup after
quiescing the old writer and preserve single-process relayer ownership.
