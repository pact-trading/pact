# Pact for React Native

`@pactagent/react-native` exports `PactCheckout`, `usePayment`, `pactTheme`, and `pactThemePresets`. Install it with `@pactagent/core`, `expo-linking`, and `expo-secure-store`. Set an Expo URL scheme so hosted checkout can return to the app. The app must call a merchant API proxy; never bundle the server API key or webhook secret.

## Secure storage adapter

```ts
import * as SecureStore from 'expo-secure-store';
import type { SecureStorageAdapter } from '@pactagent/react-native';

export const storage: SecureStorageAdapter = {
  getItem: (key) => SecureStore.getItemAsync(key),
  setItem: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItem: (key) => SecureStore.deleteItemAsync(key),
};
```

`usePayment` stores the sign-in token under `settle.session` when both `signIn` and `storage` are supplied. Treat that key as an SDK identifier. Remove it on sign-out with `storage.deleteItem('settle.session')`.

## Passkey adapter

Provide a platform passkey client configured for your relying party and a merchant server that issues a challenge and verifies the assertion. Expo passkey modules may require a development build and platform association files. The SDK calls this adapter before creating a payment; it does not sign an EVM transaction with the passkey.

```ts
import type { SignInAdapter } from '@pactagent/react-native';

type Passkeys = { get(options: unknown): Promise<unknown> };
export function passkeySignIn(passkeys: Passkeys): SignInAdapter {
  return {
    async signIn() {
      const options = await fetch('https://merchant.example/auth/passkey/options', { credentials: 'include' }).then((r) => r.json());
      const assertion = await passkeys.get(options);
      const response = await fetch('https://merchant.example/auth/passkey/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(assertion), credentials: 'include',
      });
      if (!response.ok) throw new Error('Passkey sign-in failed');
      return response.json() as Promise<{ token: string }>;
    },
  };
}
```

Pass the adapter as `signIn={passkeySignIn(passkeys)}`, `signInMethod="passkey"`, and `storage={storage}` to `PactCheckout`. Your merchant proxy must accept the authenticated session and return a payment or hosted checkout URL. The deep-link callback can update UI state, but the merchant server must confirm payment before fulfillment.

The sign-in token is stored but is not automatically added to API requests. Attach it in the transport when the merchant proxy uses bearer authentication:

```ts
import { PactClient, fetchTransport } from '@pactagent/core';

const base = fetchTransport('https://merchant.example/api/pact');
export const client = new PactClient({
  transport: async (request) => {
    const token = await storage.getItem('settle.session');
    return base({ ...request, headers: {
      ...request.headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    } });
  },
});
```
