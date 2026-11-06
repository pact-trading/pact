#!/usr/bin/env bash
# Ships the API to the VM and restarts it: the API, workspace manifests, lockfile and the compiled
# contract artifacts the API reads. Ignored files (.env*, databases, node_modules) never leave this machine.
#   deploy/api/release.sh                 install and restart
#   deploy/api/release.sh --install-only  install without restarting (first setup, before the env exists)
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
host=${PACT_API_HOST:-ubuntu@13.213.181.29}
ssh_cmd="ssh -i $HOME/.ssh/pact-pay -o UserKnownHostsFile=$HOME/.ssh/pact-pay-known_hosts -o BatchMode=yes"

(cd "$root/contracts" && forge build >/dev/null 2>&1) || { echo "forge build failed" >&2; exit 1; }
list=$(mktemp)
trap 'rm -f "$list"' EXIT
{
  git -C "$root" ls-files --cached --others --exclude-standard -- \
    package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json apps/api packages \
    ':(glob)apps/*/package.json' ':(glob)examples/*/package.json'
  for name in GasTank Router PaymentEscrow SubscriptionManager SubscriptionManagerV2 SponsoredApprover X402AccountFactory X402AgentAccount InvoiceReceivables InvestorRegistry; do
    echo "contracts/out/$name.sol/$name.json"
  done
} | grep -vE '(^|/)\.env|\.sqlite' | while read -r f; do [ -f "$root/$f" ] && echo "$f"; done > "$list"

rsync -az --checksum --files-from="$list" -e "$ssh_cmd" "$root/" "$host:/opt/pact-pay/"
install_only=0
[ "${1:-}" = "--install-only" ] && install_only=1
$ssh_cmd "$host" "INSTALL_ONLY=$install_only bash -s" <<'REMOTE'
set -euo pipefail
cd /opt/pact-pay
pnpm install --frozen-lockfile --filter @pact/api... --reporter=append-only 2>&1 | tail -3
[ "$INSTALL_ONLY" = 1 ] && exit 0
sudo systemctl restart pact-api
for i in $(seq 1 30); do curl -sf http://127.0.0.1:3001/health >/dev/null && break; sleep 1; done
curl -sf http://127.0.0.1:3001/health && echo || { sudo journalctl -u pact-api -n 40 --no-pager; exit 1; }
REMOTE
