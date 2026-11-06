# Payment-only funded x402 gateway

This contract slice implements the payment route from the reviewed M7 design. The subsequent [funded journal integration](FUNDED_JOURNAL.md) connects explicit Router envelopes to the existing production facilitator/SQLite journal/AccountWriter. Production remains inactive. Privy delegation, account enrollment and funded bootstrap/reservation grants remain unimplemented. No live contract deployment or transaction is authorized by these artifacts.

## Contracts and trust boundaries

`X402AccountFactory` deploys the existing X402AgentAccount with CREATE2, binding owner and caller-supplied salt. Its immutable registry records only accounts that it created and their runtime hashes. It cannot register arbitrary addresses, change implementation, or approve code changes. Anyone may create an account for an owner, but only that owner can configure it or sign its bounded bootstrap. Creation is provenance, not merchant sponsorship consent. Duplicate owner/salt creation reverts. Existing independently deployed accounts are not automatically admitted.

`X402FundedGateway` exposes only `settleExact` and `settleUpto` as sponsored action selectors. Its view-only `sponsorshipQuote` recognizes exactly those selectors and canonical calldata. It rejects suffixes, alternative ABI offsets/encodings, unsupported/admin selectors, oversized calls and signatures other than the account's 65-byte session authorization. The maximum accepted call length is 452 bytes. There is no generic forwarding, token approval, asset custody, bootstrap or reservation action.

The immutable constructor binds an existing Router and this exact factory runtime, checks Router's USDT and GasTank binding, and rejects zero limits or a payment ceiling above 100 USDT. Every payment enforces:

- chain1874; fixed official USDT, Permit2, exact and upto addresses;
- unchanged deployed token/Permit2/proxy runtime commitment;
- factory provenance and unchanged registered account runtime;
- nonzero actual amount, actual <= signed ceiling <= immutable gateway ceiling;
- nonzero recipient distinct from payer; recipient equal to both Router activeMerchant and activeSigner;
- current reservation ERC1271 validity, unused canonical Permit2 nonce, nonexpired deadline no more than 300 seconds away, and validAfter already reached;
- account, merchant and global gateway daily call limits across exact and upto;
- actual payer decrease and merchant increase equal to the settled amount before returning true.

The official addresses are not constructor inputs. Deployment still MUST compare their runtimes with independently pinned official hashes before constructing/allowlisting the gateway. The constructor checks code presence and both proxy PERMIT2 getters and stores the observed code commitment; that alone is not independent source attestation. The fork harness performs the independent hash checks against the pinned read-only research. Root must attest the configured Router, GasTank and factory too. No existing Router/GasTank semantics or source files were changed.

Router verifies a genuine merchant EOA signature over the exact intent before calling the gateway. Gateway requires `msg.sender == router`, `activeSigner == activeMerchant == signed Permit2 recipient`. A valid signature from some other payer/sponsor cannot spend the merchant tank through this gateway. Permit2 separately verifies the account's payment authorization. Merchant funding and signing consent are both required.

## Official caller and witness rules

The Permit2 domain and signed spender remain canonical. Exact uses the exact proxy as spender and the unchanged merchant/validAfter witness. Upto uses the upto proxy as spender and requires `witness.facilitator = gateway`, because gateway is the immediate caller of the official upto proxy. A witness signed for the relayer EOA cannot be reused or rewritten. The advertised facilitator caller must become the gateway before the official client signs; the transaction signer remains the existing relayer.

The helper `gatewayPayment(proxy, canonicalProxyCalldata, gateway)` explicitly constructs a payment draft containing both the official call and the new gateway call. `authorizeGatewayPayment` then constructs the merchant Router intent, authenticates its exact EIP712 signature, and returns a frozen request. This happens BEFORE durable fingerprinting, budget reservation and transaction preparation. Prepare functions must continue signing the supplied envelope unchanged.

`ExactMerchantIntentAuthorizer` is a required cryptographic signing port. An application secret, API authentication or a tank balance is not delegated signing authority. No production implementation is supplied. The local harness uses a distinct synthetic merchant key to sign the actual Router domain/dataHash/amount/fee/nonce/deadline/gas, and the pure helper recovers the merchant address. Root can connect the separately reviewed genuine Privy delegation flow later.

## Fees, reimbursement and evidence

Merchant funds native WBT in the existing GasTank, sets its daily cap and supplies actual USDT fee balance/Router allowance. Router's existing default 1-USDT minimum would reject the demonstrated micropayments; the local fixture explicitly configures minimum1 base unit. Production must choose and approve its own minimum, gas, fee and call caps. The gateway call ceiling is immutable; the account retains its independent per-call/full-ceiling daily/merchant policy.

Router's daily intent counter is merchant-scoped here because intent.signer is the merchant. Gateway supplies separate account/merchant/global call caps. Native gas caps still come from Router, merchant GasTank and the shared AccountWriter budget; gateway does not promise an independent per-account native-gas spending ledger. Root's cross-feature merchant admission must include any remaining gas/call requirements before activation.

`fundedReceipt` requires matching gateway PaymentSettled, canonical proxy Settled, official USDT payer-to-merchant Transfer, Router Executed, merchant-to-feeVault USDT Transfer and GasTank Reimbursed to the configured relayer. It rejects missing, duplicated payment/fee or forged-emitter evidence and reimbursement above Router's signed target-gas-plus-40000 cap. The caller must also bind the receipt hash to the exact prepared hash and enforce its confirmation depth. A status-success receipt is not business success: Router emits Refused and can return false, sometimes consuming the intent nonce without reimbursement.

The gateway reverts if proxy settlement fails or transfers do not match; target state changes and gateway counters roll back on failure. Router's existing fee/reimbursement revert semantics roll back the entire payment. Genuine reimbursement need not equal full transaction cost: Router meters/clamps its reimbursement separately from receipt gasUsed. The fork records both values and verifies the relayer's native balance delta exactly; no full-gas coverage claim is made. Failed attempts remain relayer-funded and retain shared admission costs.

## Admin actions are disabled

Admin sponsorship is excluded from this slice. Bootstrap and reservation cannot receive a payment quote, even if an owner mistakenly allowlists such a selector on this gateway. Neither approval ceilings nor reservation ceilings are disguised as payments.

The fork pays setup/bootstrap/reservation transactions from a distinct synthetic owner wallet and proves that reservations leave merchant funds, GasTank, feeVault and the payment relayer unchanged. Those transactions are explicitly outside the funded payment proof. Production needs a separate bounded, merchant-authorized admin grant design, limits, provenance, fee and reimbursement evidence before enabling gasless account onboarding or autonomous reservation sponsorship.

## Integration boundary and remaining gates

Existing `SqliteX402Journal`, `bindSettlement`, `Permit2Facilitator` and inactive production sponsorship policy are unchanged and still bind direct canonical proxy calls. Do not pass Router/gateway calldata through those direct-call paths or change it inside prepare. Root must implement an explicit funded operation variant with the same global payer Permit2 nonce uniqueness, immutable merchant authorization fingerprint, hash-only AccountWriter ownership, conservative budgets, confirmation depth, pending receipt recovery and no ambiguous resend. This slice's script-only `funded_proof` table demonstrates serialized frozen requests/results; it is not a replacement production journal.

Root also owns genuine merchant delegation and nonce coordination, authentication, exclusive process ownership, deployment approval and runtime attestation, configuration/allowlisting, account enrollment, final indexer/accounting semantics, funded admin grants and final combined PRD audit. Merchant authorization and a mandatory sponsorship policy must both remain required. Current runtime remains inactive; all contract deployments and sends in the proof are on a newly spawned local Anvil.

## Reproduction and sources

```sh
forge test --root contracts
pnpm --dir apps/api typecheck
pnpm --dir apps/api exec vitest run
pnpm --dir apps/api exec tsx scripts/x402/fork-funded-gateway.ts
```

The harness forks Whitechain (chain 1874) at a pinned archive block, attests the canonical runtime hashes, deploys upto locally from pinned official initcode, and uses actual root Router/GasTank/account/factory/gateway artifacts. Official USDT comes from a holder impersonated ONLY on the fork. No token code/storage substitutions or minting are used in this proof. The Foundry unit tests explicitly use mocks separately and do not claim official-token evidence.

Official @x402/core/evm/fetch/hono remain pinned2.29.0 and unmodified; no dependencies or third-party sources were added. The new Solidity uses project MIT code, existing OpenZeppelin MIT and the pinned official MIT ISignatureTransfer interface. See SOURCES.md and package-licenses.json for retained source versions and existing transitive license inventory; no GPL/LGPL/AGPL source was used.
