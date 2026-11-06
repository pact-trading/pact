#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT/apps/api"
TEMP_DIR="$(mktemp -d)"
cleanup() { if [[ -n "${API_PID:-}" ]]; then kill "$API_PID" 2>/dev/null || true; wait "$API_PID" 2>/dev/null || true; fi; rm -rf "$TEMP_DIR"; }
trap cleanup EXIT
export DATABASE_PATH="$TEMP_DIR/settle.sqlite"
SEED="$(cd "$API_DIR" && ./node_modules/.bin/tsx scripts/e2e-seed.ts)"
export E2E_SECRET="$(python3 -c 'import json,sys;print(json.load(sys.stdin)["secretKey"])' <<< "$SEED")"
export E2E_PUBLISHABLE="$(python3 -c 'import json,sys;print(json.load(sys.stdin)["publishableKey"])' <<< "$SEED")"
PORT="$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')"
export PORT CHAIN_ADAPTER=fake
export E2E_URL="http://127.0.0.1:$PORT"
(cd "$API_DIR" && exec ./node_modules/.bin/tsx src/server.ts) >"$TEMP_DIR/api.log" 2>&1 &
API_PID=$!
for attempt in $(seq 1 50); do
  if curl -fsS "$E2E_URL/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$API_PID" 2>/dev/null; then cat "$TEMP_DIR/api.log"; exit 1; fi
  sleep 0.1
done
curl -fsS "$E2E_URL/health" >/dev/null
echo 'Checking payment, refunds, subscription approval, renewal, refusals and cancellation'
(cd "$API_DIR" && ./node_modules/.bin/tsx scripts/e2e-flow.ts)
