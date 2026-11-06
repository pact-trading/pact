# Deployment

Pact Pay runs on Whitechain (chain 1874). The mock demo stays available separately.

| What | Where |
| --- | --- |
| Live app | `https://pay.pactagent.app`: Vercel project `pact-pay`, API mode, functions in `sin1` |
| API | `https://api.pactagent.app`: AWS EC2 `pact-pay` (`ap-southeast-1`), relayer, keeper, indexer, webhooks, x402 facilitator |
| Mock demo | `https://demo.pactagent.app`: Vercel project `pact-pay-demo`, mock mode, functions in `iad1` next to its Redis |

## Contracts

The deployed suite — GasTank, Router, PaymentEscrow, SubscriptionManager (V1), X402AccountFactory, the
canonical x402 upto proxy, the reused SponsoredApprover (EIP-7702 delegate) and USDT (six decimals) —
matches the suite and settings of the local fork (`pnpm live`). `deploy.ts` writes the addresses to
`contracts/deployment-testnet.json` and checks owners, bindings, the ten allowlist entries, Router limits
(40 calls per payer a day) and runtime bytecode against the compiled sources.

Keys live in `.env.testnet` at the repository root (gitignored, mode 600, read only by the scripts
below). The deployer key never leaves the workstation; the relayer key is only on the API host.

To deploy a new suite, rehearse on a local fork first; the testnet run executes only the rehearsed plan
under a fee cap and writes a public record before each send (it never overwrites one):

```sh
cd apps/api
anvil --fork-url https://rpc.testnet.whitechain.io --port 8546 --hardfork prague --chain-id 1874 &
pnpm exec tsx scripts/testnet/deploy.ts --rpc http://127.0.0.1:8546 --keys ../../.env.testnet --out /tmp/rehearsal.json
pnpm exec tsx scripts/testnet/deploy.ts --rpc https://rpc.testnet.whitechain.io --keys ../../.env.testnet \
  --rehearsal /tmp/rehearsal.json --max-fee-wbt 0.1 --out ../../contracts/deployment-testnet-<date>.json --execute
```

A new suite needs a fresh API database: payments, mandates and approvals name the old contracts.

## Invoice financing

Not deployed on the testnet yet. It is added beside the suite above without redeploying anything:
three transactions from the deployer (the Router's owner): create `InvestorRegistry` (owner and first
officer: the deployer), create `InvoiceReceivables` (the existing Router and USDT, the Router's fee vault,
the rules in `apps/api/src/financing/terms.ts`), and `Router.setAllowed(receivables, pay)`. The API keeps
its database; financing adds its own tables.

```sh
cd apps/api
# 1. Rehearse on a local fork of the testnet (sends nothing to the testnet):
anvil --fork-url https://rpc.testnet.whitechain.io --port 8546 --hardfork prague --chain-id 1874 &
pnpm exec tsx scripts/testnet/deploy-financing.ts --rpc http://127.0.0.1:8546 --keys ../../.env.testnet \
  --suite ../../contracts/deployment-testnet.json --out /tmp/financing-rehearsal.json
# 2. Execute the rehearsed plan on the testnet, under a fee cap:
pnpm exec tsx scripts/testnet/deploy-financing.ts --rpc https://rpc.testnet.whitechain.io --keys ../../.env.testnet \
  --suite ../../contracts/deployment-testnet.json --rehearsal /tmp/financing-rehearsal.json \
  --max-fee-wbt 0.05 --out ../../contracts/deployment-financing-testnet-<date>.json --execute
# 3. Ship the code (it carries the new artifacts), then turn financing on in the API environment:
cd ../.. && deploy/api/release.sh
deploy/api/configure.sh contracts/deployment-financing-testnet-<date>.json   # see below
```

This first deployment has no predecessors. A later redeploy of the receivables contract should name every
predecessor with `--predecessor <address>` (repeatable), so it refuses invoices and acknowledgements they
already pledged; the script checks each has code and records them.

`configure.sh` takes the suite record first and the financing record second:
`deploy/api/configure.sh contracts/deployment-testnet.json contracts/deployment-financing-testnet-<date>.json`.
It adds `RECEIVABLES_ADDRESS`, `INVESTOR_REGISTRY_ADDRESS` and `FINANCING_DEPLOYMENT_BLOCK`. The script
verifies on chain: owners, officer, every rule, the Router allowlist entry and the runtime bytecode.

Officers: the registry owner (the deployer) appoints them with `setOfficer(address, true)`. Officers and
investors only sign; the relayer submits their orders and pays the gas (about 0.001–0.002 WBT each, up to
20 orders per wallet an hour), so keep the relayer topped up (see [Funds](#funds)). Merchants send their
own listing, cancellation and buy-back transactions.

## API host

EC2 `t4g.small` (2 vCPU arm64, 2 GB), Ubuntu 24.04, 20 GB encrypted gp3, standard CPU credits,
Elastic IP `13.213.181.29` (`api.pactagent.app`). Security group `pact-pay`: SSH from the admin IP only,
80 and 443 open; `ufw` mirrors it. SSH: `ssh -i ~/.ssh/pact-pay -o UserKnownHostsFile=~/.ssh/pact-pay-known_hosts ubuntu@13.213.181.29`.

| Path | What |
| --- | --- |
| `/opt/pact-pay` | Code (owned by `ubuntu`, read-only to the service): the API, workspace manifests, contract artifacts |
| `/etc/pact-api/api.env` | Environment, `root:pact` 640: addresses, relayer key, Privy secret |
| `/var/lib/pact-api/api.sqlite` | Database; daily online backups in `backups/`, 14 kept (`pact-api-backup.timer`) |
| `pact-api.service` | `node --import tsx src/server.ts` as user `pact`, sandboxed, restarts on failure |
| Caddy | TLS for `api.pactagent.app`, reverse proxy to `127.0.0.1:3001` |

Everything is in [`deploy/api`](../deploy/api), run from the repository root:

```sh
deploy/api/release.sh                                                   # ship code, install, restart, health check
deploy/api/configure.sh contracts/deployment-testnet.json   # (re)write the API environment
```

`provision.sh` set the host up once (Node 24, pnpm, Caddy, swap, firewall, units) and can be rerun.
Only one process may run with the relayer key (its nonces are process-local): never start a second API
with it, locally or elsewhere. Logs: `sudo journalctl -u pact-api -f`.

## Funds

The relayer pays for what the merchant tanks do not reimburse: relayed USDT approvals, keeper renewals,
x402 settlements and agent setup (about 0.001 WBT each, agent creation about 0.01). Paid x402 calls are
sponsored per merchant up to `X402_MERCHANT_DAILY_LIMIT_WEI` a day (0.4 WBT on the testnet), counted at each
call's worst case of about 0.008 WBT: roughly 50 calls a merchant a day, of which about a tenth is actually
spent. Check the relayer and top it up from the deployer:

```sh
cd apps/api && pnpm exec tsx scripts/testnet/transfer.ts --keys ../../.env.testnet --to relayer --wbt 0.2
```

## Web (Vercel)

Both projects build `apps/web` (root directory, Node 24) with `apps/web/vercel.json`.

| Project | Environment (production) |
| --- | --- |
| `pact-pay` | `PACT_DATA=api`, `PACT_API_URL=https://api.pactagent.app`, `PACT_PUBLIC_ORIGIN=https://pay.pactagent.app`, `PACT_CHAIN_RPC_URL`, `NEXT_PUBLIC_PRIVY_APP_ID`. Preview deployments stay in mock mode: wallet sign-in is bound to the production origin. |
| `pact-pay-demo` | `PACT_DATA=mock`, `PACT_PUBLIC_ORIGIN=https://demo.pactagent.app`, Upstash Redis `pact-pay-demo` (`KV_REST_API_*`) for per-visitor sandboxes |

`pact-pay` also uses the Upstash store: a prepared signature's context (`pact:pending:*`, single use,
ten minutes) is kept there because prepare and submit can reach different function instances. Without
`KV_REST_API_*` it stays in process memory, which only suits a single server (`next start`).

Do not set `PACT_LIVE` on Vercel: it only moves the local build folder to `.next-live`. The API's
`PACT_WEB_ORIGIN` must equal the live origin (Sign-In with Ethereum checks it), and the Privy app must
allow it.

```sh
vercel deploy --prod                                                                   # live app
VERCEL_ORG_ID=team_7saCQFoozijJ3qus7IGc8QNo VERCEL_PROJECT_ID=prj_KuJoc6KQklA2F0vBYWZMHJSSnVtL vercel deploy --prod   # demo
```

DNS (Hostinger): `A api → 13.213.181.29`, `CNAME pay → f13ff116b66cffc9.vercel-dns-017.com`,
`CNAME demo → da03b22f223ece21.vercel-dns-017.com`.

## Checks

```sh
PACT_LIVE_URL=https://pay.pactagent.app PACT_LIVE_API=https://api.pactagent.app pnpm live:check
PACT_E2E_URL=https://demo.pactagent.app pnpm --filter @pact/web exec playwright test
```

The first runs every live flow on the testnet (see [live-mode.md](live-mode.md#on-the-testnet)); the
second runs the mock journeys against the demo.
