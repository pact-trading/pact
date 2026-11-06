# Primary sources and license record

npm's current stable versions for `@x402/core`, `@x402/evm`, `@x402/fetch` and `@x402/hono` are **2.29.0**. All four are pinned exactly in package.json; pnpm-lock.yaml pins tarball integrity and transitive versions. The core/evm/fetch packages are Apache-2.0; hono is Apache-2.0 and is used only by the local compatibility harness.

- Official package metadata: https://registry.npmjs.org/@x402/core/2.29.0, https://registry.npmjs.org/@x402/evm/2.29.0, https://registry.npmjs.org/@x402/fetch/2.29.0, https://registry.npmjs.org/@x402/hono/2.29.0
- Official protocol and deployment source: https://github.com/x402-foundation/x402/tree/f3cb4bb79a708bf5669f952d09fa404370263c76
- Exact specification: https://github.com/x402-foundation/x402/blob/f3cb4bb79a708bf5669f952d09fa404370263c76/specs/schemes/exact/scheme_exact_evm.md
- Upto specification: https://github.com/x402-foundation/x402/blob/f3cb4bb79a708bf5669f952d09fa404370263c76/specs/schemes/upto/scheme_upto_evm.md
- Canonical deploy source and build: https://github.com/x402-foundation/x402/blob/f3cb4bb79a708bf5669f952d09fa404370263c76/contracts/evm/script/Deploy.s.sol
- Permit2: https://github.com/Uniswap/permit2/tree/cc56ad0f3439c502c246fc5cfcc3db92bb8b7219
- Whitechain network reference: https://docs.whitechain.io/learn/network/reference

The proxy source snapshot is independently pinned from the npm packages. Compatibility is proven by the integration test rather than assuming repository HEAD equals the published package source. The exact and upto constants used by 2.29.0 match the reference build.

`package-licenses.json` records the installed API tree, including pre-existing tooling. No GPL, LGPL or AGPL package was found. Direct x402 packages and copied production Solidity source are Apache-2.0/MIT. Additional transitives have permissive BSD/ISC/Unlicense choices: in particular the hono test harness pulls `@x402/extensions` with BSD-2-Clause `apg-js` and Unlicense `tweetnacl`. These are not GPL-family licenses; retain their package notices. The existing Vitest/Vite development tree includes MPL-2.0 lightningcss, which is not copied into our contracts or production module. This is an inventory, not a claim that every package in the pre-existing API tree is exclusively MIT or Apache. If the project applies an exclusive MIT/Apache rule to every transitive development dependency, this tooling/hono graph needs a separate dependency-policy decision before distribution; no exceptions are silently asserted.

All directly copied files, with original SPDX headers and licenses, are listed in `contracts/x402-reference/THIRD_PARTY.md`. No GPL-family repository was cloned or used. Original Settle account/facilitator code in this task is MIT-compatible project code. No external contract code is presented as work built during the event.
