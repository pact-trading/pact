# Whitechain feedback (GOL Pay)

Everything below was observed while building on Whitechain testnet (chain 1874), not guessed.

## What worked
- Chain ID 1874 on `https://rpc.testnet.whitechain.io`, 1 second blocks. Standard EVM tooling works
  unchanged. `forge script --broadcast` deployed four contracts in one run with no special flags (fee
  floor 5 gwei, total about 0.028 WBT). Our full suite, 22 transactions over two scripts, cost about
  0.09 WBT.
- Blockscout verification through `forge verify-contract --verifier blockscout --verifier-url https://explorer.testnet.whitechain.io/api/` passed first time for all contracts, including ones with constructor arguments.
- The network reference page lists the EVM version limits (Prague, no Karst). Having this written down let us pin `evm_version` correctly.
- The testnet USDT (`0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7`) has code, `decimals()` returns 6,
  and `transfer` returns `true`. It supports EIP-2612 `permit` and EIP-3009
  `receiveWithAuthorization`, so a payer can pay with a single signature and no gas.
- The usual OP Stack and community predeploys are present:
  - Permit2 at its canonical address `0x000000000022D473030F116dDEE9F6B43aC78BA3`. Its runtime equals
    Ethereum's except for the chain ID and domain immutables.
  - Multicall3 at `0xcA11bde05977b3631167028862bE2a173976CA11`.
  - EntryPoint v0.7 and v0.6.
  - The CREATE2 deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`.
  - The Safe singleton factory.
  - The x402 exact proxy `0x402085c248EeA27D92E8b30b2C58ed07f9E20001`.
- P256VERIFY (RIP-7212) is live at `0x…0100`: a check costs about 3.5k gas, and a passkey-signed
  transaction about 40k gas in total. Passkey smart accounts are cheap here.
- The RPC streams `newHeads` over WebSocket at `/ws`, so an indexer can react to each block
  without polling.
- The testnet DEX (Uniswap v3 SwapRouter02 `0xe208cC685cD95D56E8ec6DEC9816476567fc6962`, WWBT/USDT
  0.3% pool) is a scripted path from WBT to test USDT.

## Where we got stuck
1. Wrong RPC guess cost time. We first tried `rpc-testnet.whitechain.io` (hyphen). It answers, but `eth_chainId` returns 2625, not 1874, and the USDT address has no code there. Nothing in the error told us we were on another chain. The correct host is `rpc.testnet.whitechain.io`. A hyphenated host that answers with a different chain ID is a trap; consider redirecting or retiring it.
2. No way to get test USDT without a human. `mint(address,uint256)` on the USDT reverts with
   `Ownable: caller is not the owner`. The faucet needs a GitHub login. Swapping faucet WBT on the
   testnet DEX works, but it is still gated by that login. A hackathon team that wants a USDT payment
   in its main flow has no unattended path. Time lost: about an hour of probing.
3. The USDT's EIP-712 domain cannot be discovered from the token itself. `version()` and
   `eip712Domain()` (EIP-5267) both revert. We had to guess name `Tether USD` and version `1` and
   compare the hash with `DOMAIN_SEPARATOR()`. A wrong guess only shows up as a failed signature.
4. The USDT is an upgradeable EIP-1967 proxy (implementation
   `0x26425662d126412128967ecf0a02ec48573026f7`, admin `0xb8d40f05309bfa5c751fa0925761e3e4bc5f4042`).
   Nothing says so. An integration built on its EIP-3009 and permit behaviour cannot tell whether
   that behaviour will stay.
5. RPC limits are only discoverable by hitting them:
   - A JSON-RPC batch takes at most 100 requests. Request 101 returns HTTP 413 with
     `-32014 Batch size limit exceeded`.
   - `eth_getLogs` spans at most 10,000 blocks. More returns
     `-32602 query exceeds max block range 10000`.
   - The Ankr endpoint (`rpc.ankr.com/whitechain_testnet`, same chain ID) has the same range limit,
     but answers with a different error, `-32062 Block range is too large`. Code that detects the
     limit has to match both.
6. A local Anvil fork does not behave like the chain, and the differences hide real costs:
   - The precompile set does not match any single Anvil hardfork. `--hardfork prague` lacks
     P256VERIFY. `--hardfork osaka` adds it but also enables CLZ, which the chain does not have.
     Contracts must still be compiled for Prague.
   - The chain pins the base fee at 5 gwei. Anvil lets it decay toward zero, so gas looks nearly free
     in local tests. We only found that small payments do not cover their gas once we forced the floor.
   - On Anvil, `safe` and `finalized` equal `latest`. On the chain they lag by minutes.
7. "1 second blocks" is easy to read as "1 second finality". The chain is an OP Stack (Isthmus)
   rollup:
   - A block is the sequencer's word.
   - `safe` lagged `latest` by minutes in our readings (up to about 30), and `finalized` by 30–40
     minutes.
   - A sequencer block can still be reorged before its batch reaches Ethereum.

   A payments product has to show "confirmed" and "final" as separate states. We had to work out the
   lags by measuring.
8. Receipts carry an L1 data fee and an Isthmus operator fee (`l1Fee`, `operatorFeeScalar`,
   `operatorFeeConstant`) on top of `gasUsed × effectiveGasPrice`. A relayer that books gas costs from
   `gasUsed` alone undercounts them.
9. The canonical x402 upto proxy (`0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002`) was not predeployed,
   while the exact proxy was. We deployed it ourselves through the CREATE2 deployer with the official
   initcode.
10. The WWBT/USDT pool keeps a single price observation (observation cardinality 1). A 10-minute TWAP
    read from it is effectively the spot price, so anyone using the pool as a price oracle gets spot
    prices.
11. Foundry on this chain wants an explicit `--private-key` or `--sender` for scripts that do not read the key in `vm.startBroadcast(key)`; the default-sender error is confusing for newcomers.

## What the docs were missing
- A list of predeploys and precompiles: the addresses above, P256VERIFY at `0x…0100`, CLZ absent, and
  the canonical x402 upto proxy absent. The reference mentions predeploys but not which builder
  contracts exist.
- How a hackathon team obtains test USDT, the owner or minter contract behind it, its EIP-712 domain
  (name and version), and that it supports EIP-2612 and EIP-3009 and is upgradeable.
- RPC limits: batch size, `eth_getLogs` range, rate limits and the WebSocket path.
- Finality: the usual `safe` and `finalized` lag on testnet and mainnet, and when a reorg is still
  possible.
- Gas: the 5 gwei base-fee floor, the 0.001 gwei suggested tip, and the L1 data and operator fees
  in receipts.
- A note next to the relayer guidance that the faucet allowance is per GitHub account per 24 hours
  (0.5 WBT). For scale, one relayed one-signature checkout costs about 0.001 WBT, and redeploying a
  full contract suite about 0.09 WBT. A sponsored-gas product needs more than one claim a day to be
  demonstrable.
- Explorer API base path for verification (`/api/`) in one copy-paste block.

## Questions
1. Which address can mint test USDT? `owner()` now returns
   `0x8790832ba493cc16a4dbc5c961b0c4950632799c`, but the mint revert first led us to
   `0x009Bf898c9c89bbF75F3C57f57B6D89Dcfb484a0`.
2. Will the testnet USDT be upgraded? Will its EIP-3009 and permit interface and its domain stay as
   they are?
3. Does mainnet USDT support EIP-3009 like the testnet token? If not, integrations built on the
   testnet need a Permit2 fallback before launch.
4. Is the 5 gwei base-fee floor fixed, and does mainnet have the same one? It sets the smallest
   payment whose fee can cover gas. At the DEX's price of about 73 USDT per WBT, one checkout costs
   about 0.07 USDT of gas.
5. Is EIP-7702 (type-4 transactions) supported on 1874? We tested it only on a local fork and then
   designed around it.
6. What is chain 2625 behind `rpc-testnet.whitechain.io`, and will that host be retired?
7. Which RPC limits apply on mainnet (batch size, `eth_getLogs` range, requests per second)?
8. What are the expected `safe` and `finalized` lags, and the deepest reorg a sequencer block can
   suffer?
9. Will the canonical x402 upto proxy be predeployed on mainnet, alongside the exact proxy?

## Suggestions
1. Publish a test-USDT faucet (or a documented claim contract) alongside the WBT faucet.
2. Make the legacy `rpc-testnet` host fail loudly or redirect, and print the chain ID in the docs next to every URL.
3. Add a "deploy and verify with Foundry" snippet using the Blockscout API URL, `evm_version = "prague"` and the 5 gwei floor.
4. Add one "chain facts" page: predeploys, precompiles, RPC limits, finality lags, gas floor and fee
   components, with the matching Anvil flags for a faithful local fork.
5. Add `eip712Domain()` (EIP-5267) to the USDT at its next upgrade, or publish its domain, and say
   that the token is upgradeable and who controls it.
6. Raise the WWBT/USDT pool's observation cardinality so its TWAP is meaningful.
