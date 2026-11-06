'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PrivyProvider,
  usePrivy,
  useSignTypedData,
  useWallets,
} from '@privy-io/react-auth';
import { defineChain, type Hex } from 'viem';
import type { IdentitySession as PactIdentity } from '@pactagent/core/api-types';
import { createContext } from 'react';

/** The customer's Privy account: email sign-in, an embedded wallet, typed-data signing. */
export interface PrivyCustomer {
  ready: boolean;
  authenticated: boolean;
  identity: PactIdentity | null;
  error: string;
  login(): void;
  signOut(): Promise<void>;
  /** Signs EIP-712 typed data: payments, mandates, cancellations and USDT permits. */
  signTyped(typedData: Record<string, unknown>): Promise<Hex>;
}
export const PrivyCustomerContext = createContext<PrivyCustomer | null>(null);

const whitechain = defineChain({
  id: 1874,
  name: 'Whitechain Sepolia',
  nativeCurrency: { name: 'WBT', symbol: 'WBT', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.testnet.whitechain.io'] } },
  testnet: true,
});
export type TypedRequest = Parameters<ReturnType<typeof useSignTypedData>['signTypedData']>[0];
async function clearSession() {
  // Only a Privy cookie: a merchant wallet session or a local test customer must survive Privy sign-out.
  const response = await fetch('/api/session?role=customer&only=privy', { method: 'DELETE' });
  if (!response.ok) throw new Error('Could not end the session. Please try again.');
}
function SessionBridge({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, user, getAccessToken, login, logout } = usePrivy();
  const { signTypedData } = useSignTypedData();
  const { wallets } = useWallets();
  const walletReadyKey = wallets.map(w => `${w.walletClientType}:${w.address}`).join(',');
  const [identity, setIdentity] = useState<PactIdentity | null>(null);
  const [error, setError] = useState('');
  const cookieUser = useRef<string | undefined>(undefined);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const currentUser = useRef(user?.id);
  currentUser.current = authenticated ? user?.id : undefined;
  const serial = useCallback(<T,>(work: () => Promise<T>): Promise<T> => {
    const result = queue.current.then(work, work);
    queue.current = result.catch(() => undefined);
    return result;
  }, []);
  const refresh = useCallback(
    () =>
      serial(async () => {
        // Privy restores its session shortly after a page load; a click in that moment waits for it.
        for (let i = 0; i < 50 && !currentUser.current; i++) await new Promise(r => setTimeout(r, 200));
        const expectedUser = currentUser.current;
        if (!expectedUser) throw new Error('Please sign in again.');
        // After a page load, keep a cookie that already belongs to this user: clearing it first would
        // leave requests made in the meantime (a click on Pay) without a session.
        if (cookieUser.current === undefined) {
          const current = await fetch('/api/session', { cache: 'no-store' })
            .then(r => (r.ok ? (r.json() as Promise<{ userId?: string }>) : null))
            .catch(() => null);
          if (current?.userId === expectedUser) cookieUser.current = expectedUser;
        }
        if (cookieUser.current !== expectedUser) {
          await clearSession();
          cookieUser.current = undefined;
        }
        const token = await getAccessToken();
        if (!token) throw new Error('Please sign in again.');
        const response = await fetch('/api/session', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        });
        const value = await response.json();
        if (!response.ok)
          throw new Error(
            value.error === 'embedded_wallet_required'
              ? 'Your payment wallet is being created. Try again shortly.'
              : 'We could not verify your session. Please try again.',
          );
        if (value.userId !== expectedUser || currentUser.current !== expectedUser) {
          await clearSession();
          throw new Error('Account changed. Please try again.');
        }
        cookieUser.current = expectedUser;
        setIdentity(value);
        setError('');
        return value as PactIdentity;
      }),
    [getAccessToken, serial],
  );
  useEffect(() => {
    if (!ready) return;
    let active = true;
    setIdentity(null);
    if (!authenticated) {
      void serial(clearSession).catch(() => setError('Could not clear the previous session.'));
      return;
    }
    void refresh().catch(e => {
      if (active) setError(e.message);
    });
    const timer = setInterval(() => {
      void refresh().catch(e => {
        if (active) {
          setIdentity(null);
          setError(e.message);
        }
      });
    }, 60_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [ready, authenticated, user?.id, walletReadyKey, refresh, serial]);
  const signOut = async () => {
    setIdentity(null);
    currentUser.current = undefined;
    await serial(clearSession);
    await logout();
  };
  const signTyped = async (input: TypedRequest) => {
    const verified = await refresh();
    return (await signTypedData(input, { address: verified.wallet.address })).signature;
  };
  return (
    <PrivyCustomerContext.Provider
      value={{
        ready,
        authenticated,
        identity,
        error,
        login: () => login(),
        signOut,
        signTyped: async (typedData: Record<string, unknown>) =>
          (await signTyped(typedData as unknown as TypedRequest)) as Hex,
      }}
    >
      {children}
    </PrivyCustomerContext.Provider>
  );
}
/** Privy for customers. Without an app id, children render with no Privy account available. */
export function PrivyRoot({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) return <>{children}</>;
  return (
    <PrivyProvider
      appId={appId}
      clientId={process.env.NEXT_PUBLIC_PRIVY_CLIENT_ID}
      config={{
        loginMethods: ['email', 'passkey'],
        // Pact shows its own confirmation, so the embedded wallet signs without a second popup.
        embeddedWallets: { ethereum: { createOnLogin: 'all-users' }, showWalletUIs: false },
        defaultChain: whitechain,
        supportedChains: [whitechain],
        appearance: {
          theme: 'light',
          accentColor: '#3b5100',
          logo: '/brand/pact/svg/pact-logo-horizontal.svg',
        },
      }}
    >
      <SessionBridge>{children}</SessionBridge>
    </PrivyProvider>
  );
}
