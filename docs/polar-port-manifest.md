# Polar port manifest

Source: https://github.com/polarsource/polar at `3203d4e06dab7f8e3c78408962f7fce564c9adbb`.
Source paths below are relative to `clients/apps/web/src/components/`; destination paths are relative to `apps/web/src/components/`. All 16 paths resolve in the pinned checkout; SHA-256 records source bytes. The root Apache-2.0 license applies to these web components; no nested web license or applicable NOTICE was found. Full text is retained at `../licenses/polar-Apache-2.0.txt`.

| Source | Destination | SHA-256 | Status |
|---|---|---|---|
| `Checkout/CheckoutLayout.tsx` | `playground/preview/checkout-frame.tsx` | `e56ef184eaccd752bca5a7019d91fada6f38084baa1b828507b0369e25a8afc3` | Composition adapted; kept only for the checkout playground preview |
| `Checkout/CheckoutOrderSummary.tsx` | `playground/preview/checkout-summary.tsx` | `a7008da14ac9090d9b39c73ffdae4c100d0e4f4c84a40a9577480142c880c73e` | Composition adapted; kept only for the checkout playground preview |
| `Checkout/CheckoutCollapsibleOrderSummary.tsx` | `playground/preview/checkout-summary.tsx` | `194eb3204ae7fffd7af4f9249607046c075e69a9d24e5fe25a85222159c5e9e3` | Composition adapted; kept only for the checkout playground preview |
| `Checkout/CheckoutConfirmation.tsx` | removed | `ff3242bbf36bc9e231e36fdab464ed0666a2206abb70bdc96b53436218c0e35b` | The adapted file was deleted in the UI rebuild; its replacement is new Pact code, with Polar as UX reference only |
| `Layout/Dashboard/DashboardNavigation.tsx` | removed | `2893593d45050fcf42c6df02e54c5c1f37edb13d71ddf627718c09823bcee764` | The adapted file was deleted in the UI rebuild; its replacement is new Pact code, with Polar as UX reference only |
| `Layout/Dashboard/DashboardSidebar.tsx` | removed | `bd7a3fc44e1375a637e850c443f0b4e52764390258820ddd4f35ab03be18ff17` | The adapted file was deleted in the UI rebuild; its replacement is new Pact code, with Polar as UX reference only |
| `Products/ProductForm/ProductInfoSection.tsx` | removed | `43c434a405e84468903e4066e8dba96e5e200444affe1d257e68fe7f0814fe1b` | The adapted file was deleted in the UI rebuild; its replacement is new Pact code, with Polar as UX reference only |
| `Products/ProductForm/ProductPricingSection.tsx` | removed | `5f99789acf1a708a0374efb0cb1c621510d2147ccfa1cf53b0278e8ea8be8df4` | The adapted file was deleted in the UI rebuild; its replacement is new Pact code, with Polar as UX reference only |
| `Products/ProductListItem.tsx` | removed | `db8adf5a5b0b9712bf68ed583cf8329a714b3120603b54fbae37412735b47ffd` | The adapted file was deleted in the UI rebuild; its replacement is new Pact code, with Polar as UX reference only |
| `Orders/OrderDetails.tsx` | removed | `d94c3aa61e056eeb4faf4936637950640ceeeb7a1eb78c83dfa12183e9075e15` | The adapted file was deleted in the UI rebuild; its replacement is new Pact code, with Polar as UX reference only |
| `Orders/OrderPaymentsTable.tsx` | removed | `1aefca88eb0639706cefdaa4f984ddae4ffaa8a17e4fd4426bbfda13f25b95f9` | The adapted file was deleted in the UI rebuild; its replacement is new Pact code, with Polar as UX reference only |
| `Orders/OrderRefundsSection.tsx` | removed | `cd973d5b958d8da456cba4e0a6818c63aae692051e17bead03f003f16ced262f` | The adapted file was deleted in the UI rebuild; its replacement is new Pact code, with Polar as UX reference only |
| `Customer/CustomerPage/CustomerDetailsSection.tsx` | removed | `48a4b574098a0da0a3497cbe3619d235489eddc890f23b34f3f226c0d78bc876` | The adapted file was deleted in the UI rebuild; its replacement is new Pact code, with Polar as UX reference only |
| `Customer/CustomerPage/CustomerOrdersTable.tsx` | removed | `4b374c6d34392d504a6d1edb05559b9dc6bf1e4f6875fce91b41d9eb6e806f83` | The adapted file was deleted in the UI rebuild; its replacement is new Pact code, with Polar as UX reference only |
| `CustomerPortal/CustomerPortalOrders.tsx` | removed | `18485c49ee272817c0b6dd764d2cb842c0fcacd79fe11837b5dda313affd55a3` | The adapted file was deleted in the UI rebuild; its replacement is new Pact code, with Polar as UX reference only |
| `CustomerPortal/CustomerPortalOrder.tsx` | removed | `da7381560cb748ceb36fe6b6c107c2898cf8835d4db9a6459bba8a2e8c4a664d` | The adapted file was deleted in the UI rebuild; its replacement is new Pact code, with Polar as UX reference only |

The web app is built on a Tailwind component kit (see `apps/web/src/components`). Only the two playground preview files above still contain composition adapted from Polar, and they keep their attribution headers. No other current file contains code derived from Polar.

The product checkout and playground now share `ProductCheckoutFrame` and
`CheckoutSummary`. Preview identity, balances and receipts remain explicitly
sample data; real checkout uses the verified commerce API.
