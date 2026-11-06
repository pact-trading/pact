#!/usr/bin/env bash
# Installs the API environment on the VM from a verified testnet deployment record.
# The file holds the relayer key and the Privy secret: it is generated locally with mode 600,
# copied over SSH, installed as root:pact 640 and deleted locally. Nothing is printed.
#   deploy/api/configure.sh contracts/deployment-testnet-<date>.json [contracts/deployment-financing-testnet-<date>.json]
# The optional second record turns on invoice financing (the receivables contract and investor registry).
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
record=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
financing_args=()
if [ -n "${2:-}" ]; then financing_args=(--financing "$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"); fi
host=${PACT_API_HOST:-ubuntu@13.213.181.29}
web_origin=${PACT_WEB_ORIGIN:-https://pay.pactagent.app}
ssh_cmd="ssh -i $HOME/.ssh/pact-pay -o UserKnownHostsFile=$HOME/.ssh/pact-pay-known_hosts -o BatchMode=yes"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
(cd "$root/apps/api" && pnpm exec tsx scripts/testnet/api-env.ts --deployment "$record" --keys "$root/.env.testnet" \
  --privy "$root/apps/api/.env.local" --rpc https://rpc.testnet.whitechain.io --web-origin "$web_origin" --out "$tmp/api.env" ${financing_args[@]+"${financing_args[@]}"})
$ssh_cmd "$host" 'umask 077; cat > /tmp/pact-api.env && sudo install -o root -g pact -m 640 /tmp/pact-api.env /etc/pact-api/api.env && rm -f /tmp/pact-api.env' < "$tmp/api.env"
echo "installed /etc/pact-api/api.env on $host"
