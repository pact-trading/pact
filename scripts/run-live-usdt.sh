#!/usr/bin/env bash
# Runs the three live flows against the ORIGINAL contracts with the prize USDT.
# Prerequisite: deployer holds at least ~600 USDT (0xcedf...55a7) and the payer wallets hold WBT or use the gasless script.
# Usage: scripts/run-live-usdt.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../apps/api"
set -a; . ../../.env.wallets; set +a
BAL=$(cast call "$USDT" 'balanceOf(address)(uint256)' "$DEPLOYER_ADDRESS" --rpc-url "$WHITECHAIN_RPC" | awk '{print $1}')
echo "deployer USDT balance (6 decimals): $BAL"
[ "$BAL" -ge 300000000 ] || { echo "Fund the deployer with prize USDT first (need >= 300 USDT)."; exit 1; }
export USE_PRIZE_USDT=1
./node_modules/.bin/tsx scripts/onchain-flow.ts
./node_modules/.bin/tsx scripts/onchain-subscription.ts
./node_modules/.bin/tsx scripts/onchain-gasless-payer.ts
