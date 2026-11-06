#!/usr/bin/env bash
# Boots API (offline fake chain) and web wired together. Prints a payment link.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="${TMPDIR:-/tmp}/gol-dev-stack"; mkdir -p "$TMP"; rm -f "$TMP/db.sqlite"
export DATABASE_PATH="$TMP/db.sqlite" PORT=3001 CHAIN_ADAPTER=fake PUBLIC_BASE_URL=http://127.0.0.1:3202
SEED="$(cd "$ROOT/apps/api" && ./node_modules/.bin/tsx scripts/e2e-seed.ts)"
SK="$(python3 -c 'import json,sys;print(json.load(sys.stdin)["secretKey"])' <<< "$SEED")"
PK="$(python3 -c 'import json,sys;print(json.load(sys.stdin)["publishableKey"])' <<< "$SEED")"
(cd "$ROOT/apps/api" && exec ./node_modules/.bin/tsx src/server.ts) > "$TMP/api.log" 2>&1 &
for i in $(seq 1 50); do curl -fsS localhost:3001/health >/dev/null 2>&1 && break; sleep 0.2; done
PAY="$(curl -s -X POST localhost:3001/v1/payments -H "authorization: Bearer $SK" -H 'content-type: application/json' -d '{"amount":"125.00","description":"Brand identity package"}')"
echo "$PAY" > "$TMP/payment.json"
export PACT_API_URL=http://localhost:3001 PACT_PUBLISHABLE_KEY="$PK" PACT_SECRET_KEY="$SK" PACT_API_KEY="$SK" PACT_DASHBOARD_TOKEN=local NEXT_PUBLIC_PACT_DEV_DASHBOARD_TOKEN=local PACT_MERCHANT_PRIVATE_KEY="0x$(printf '1%.0s' $(seq 1 64))"
echo "payment: $PAY"
cd "$ROOT/apps/web" && exec pnpm dev -p 3202
