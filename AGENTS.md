# Repository rules

## Layout

One pnpm workspace, installed once from the root with `pnpm install`.

| Path | What |
| --- | --- |
| `apps/web` | Next.js web app (`@pact/web`): merchant dashboard, checkout, customer portal |
| `apps/api` | Hono + SQLite API, relayer, indexer, keeper, x402 facilitator (`@pact/api`) |
| `packages/*` | SDK packages: `@pactagent/core`, `@pactagent/node`, `@pactagent/checkout-react`, `@pactagent/react-native` |
| `examples/*` | Standalone merchant store and Expo store that integrate the SDK |
| `contracts/` | Foundry contracts (not a pnpm package) |
| `scripts/` | Preview, dev stack and live-flow scripts |
| `deploy/` | API host setup and release scripts (AWS VM behind `api.pactagent.app`) |
| `docs/` | Living docs |

Packages never import from `apps/`. Apps consume `@pactagent/core` from source through
tsconfig `paths`, so no package build is needed for web or API work.

## Checks

```sh
pnpm typecheck        # builds packages, then typechecks every workspace
pnpm test             # every workspace's tests
pnpm test:contracts   # forge test
```

## Build before starting the website

- Always finish a successful production build before starting the web server or
  opening the website for browsing, previews, demos, or browser checks.
- Run the build and server sequentially. Do not browse while a build is running.
- Use the production server (`next start`), rather than the development server,
  for browsing so compilation does not make the system laggy.
- After changing web code, stop the server, rebuild successfully, then restart
  before checking the change in a browser.
- Use `next dev` only when the user explicitly requests a development server.

Normal web startup, from the repository root:

```sh
pnpm --filter @pact/web build
pnpm --filter @pact/web start --hostname localhost --port 3000
```

For mock data, run `pnpm preview`. It completes an isolated production build in
`.next-preview` before starting the preview server.

For live data on a local fork of Whitechain Sepolia, run `pnpm live`. It starts the chain, deploys
contracts, starts the API, then completes a production build in `.next-live` before `next start`.
`pnpm live:check` runs the live browser checks against it (see `docs/live-mode.md`).
