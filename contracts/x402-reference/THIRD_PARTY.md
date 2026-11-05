# Pinned official x402 reference subset

Source: https://github.com/x402-foundation/x402/tree/f3cb4bb79a708bf5669f952d09fa404370263c76/contracts/evm

Copied unchanged:

- `src/x402BasePermit2Proxy.sol`
- `src/x402ExactPermit2Proxy.sol`
- `src/x402UptoPermit2Proxy.sol`
- `src/interfaces/ISignatureTransfer.sol`
- `script/data/exact-proxy-initcode.hex`

The four Solidity files explicitly declare **MIT** in SPDX headers. The repository and official TypeScript packages declare **Apache-2.0**. Retain both the per-file declarations and upstream root `LICENSE`/`NOTICE`; do not describe these individual Solidity files as exclusively Apache-2.0. Both licenses fit the project's permitted source choices.

The necessary OpenZeppelin dependency subset is copied unchanged from commit `fcbae5394ae8ad52d8e580a3477db99814b9d565`, the exact submodule revision in that x402 tree:

- `openzeppelin/contracts/utils/ReentrancyGuard.sol`
- `openzeppelin/contracts/utils/StorageSlot.sol`
- `openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol`
- `openzeppelin/LICENSE` (MIT)

`foundry.toml` is our reduced build configuration using upstream compiler/optimization/metadata settings and remappings to the selected dependency files. No test fixtures, mock token, unused periphery, GPL/LGPL/AGPL sources or unlicensed deploy scripts were copied. Exact uses upstream's original initcode because its CBOR metadata is part of the canonical CREATE2 address. Upto compiles reproducibly without metadata.

Permit2 is **not vendored or modified**. Canonical runtime is checked against Ethereum, validating only the two chain-dependent constructor immutables. Official source reference: https://github.com/Uniswap/permit2/tree/cc56ad0f3439c502c246fc5cfcc3db92bb8b7219 (MIT production Solidity source). Its deployment script is marked UNLICENSED and was not copied.
