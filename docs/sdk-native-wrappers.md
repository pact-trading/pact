# Pact native wrapper plan

The TypeScript API is the reference shape for future first-party Swift and Kotlin packages. Ship thin platform wrappers that call the same `/v1` endpoints and expose the same decimal-string amount contract, rather than embedding a second payment protocol.

## iOS (Swift Package Manager)

- Publish `SettleKit` with `PactClient`, `Payment`, `Invoice`, `SubscriptionPlan`, `Intent`, `Mandate`, and `SettleError` public types. These code identifiers remain stable while the product is displayed as Pact. Use `Decimal` only at UI boundaries; convert USDT to six-decimal integer units with explicit rounding rejection.
- Implement transport with injected `URLSession` for mockability. Use `Codable` for JSON, including `BigUInt` values as decimal strings. Attach the merchant server's short-lived checkout token, never a secret API key, to mobile requests.
- Offer `PactCheckout` as a SwiftUI view with email, amount, progress, and error states. Open hosted checkout through `ASWebAuthenticationSession`, register a custom URL or universal-link callback, and pass the returned payment ID to the merchant backend for status confirmation.
- Define `SignInAdapter` for passkeys (`AuthenticationServices`) or email, plus a `SecureStorageAdapter` backed by Keychain. Release sample app and mocked `URLProtocol` tests for success, cancellation, malformed callbacks, and token persistence.

## Android (Kotlin)

- Publish `settle-android` using Gradle and Maven Central with coroutine `suspend` methods and Kotlin data classes matching the shared REST model. Keep this package identifier stable. Parse six-decimal amounts with `BigDecimal` and `RoundingMode.UNNECESSARY`.
- Inject an OkHttp client for tests. Keep checkout tokens in Android Keystore-backed encrypted storage; expose `SignInAdapter` for Credential Manager passkeys or email.
- Offer a Compose `PactCheckout` composable with a Pact brand label. Launch hosted checkout through Custom Tabs and handle the return with an App Link or custom scheme. Resolve the returned payment ID with the merchant backend before displaying success.
- Use MockWebServer for route, serialization, error, and callback tests; include a small Compose reference app.

## Shared release gates

Match the Solidity EIP-712 domain names, field order, widths, chain ID 1874, and USDT address in fixed vectors generated from `@pactagent/core`. Domain strings are signing protocol values and must retain their current spelling. Verify webhook HMAC over raw bytes. Document API authentication and callback contracts once the backend schema is finalized. Publish semantic versions and migration notes together across JavaScript, Swift, and Kotlin.
