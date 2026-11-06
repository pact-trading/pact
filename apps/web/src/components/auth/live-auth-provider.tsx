'use client';

import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import type { Address, WalletClient } from 'viem';
import {
  forgetLocalAccount,
  injectedAccount,
  localAccount,
  localClient,
  merchantWalletKind,
  rememberMerchantWalletKind,
  rememberWalletKind,
  walletKind,
  signableTypedData,
  walletSignIn,
  type LiveConfig,
  type MerchantWalletKind,
  type WalletRole,
} from '@/lib/live-wallet';
import { AuthContext, SignatureCancelled, type LiveAuth, type PactAuth } from './auth-context';
import { PrivyCustomerContext, PrivyRoot } from './privy-auth-provider';

export interface LiveSessions {
  merchant: { address: Address } | null;
  customer: { address: Address; email: string | null; kind: 'privy' | 'wallet' } | null;
  investor?: { address: Address } | null;
  compliance?: { address: Address } | null;
}

const cancelled = (error: unknown) => {
  const e = error as { code?: number; name?: string; message?: string };
  return (
    e?.code === 4001 ||
    e?.name === 'UserRejectedRequestError' ||
    /reject|denied|cancel/i.test(e?.message ?? '')
  );
};

/**
 * Live mode: the merchant is a connected wallet (or a local test wallet on a fork); the customer is
 * a Privy email account (or a local test customer on a fork). Both can be signed in at once.
 */
export function LiveAuthProvider({
  config,
  sessions,
  children,
}: {
  config: LiveConfig;
  sessions: LiveSessions;
  children: ReactNode;
}) {
  return (
    <PrivyRoot>
      <LiveAuthInner config={config} sessions={sessions}>
        {children}
      </LiveAuthInner>
    </PrivyRoot>
  );
}

function LiveAuthInner({
  config,
  sessions,
  children,
}: {
  config: LiveConfig;
  sessions: LiveSessions;
  children: ReactNode;
}) {
  const router = useRouter();
  const privy = useContext(PrivyCustomerContext);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // When Privy sets a new customer session cookie, re-read the sessions the server renders with.
  const privyUser = privy?.identity?.userId;
  useEffect(() => {
    if (privyUser && sessions.customer?.kind !== 'privy') router.refresh();
  }, [privyUser, sessions.customer?.kind, router]);

  const merchant = sessions.merchant
    ? {
        address: sessions.merchant.address,
        kind: typeof window === 'undefined' ? null : merchantWalletKind(),
      }
    : null;
  const customer = sessions.customer
    ? {
        address: sessions.customer.address,
        email: sessions.customer.email,
        kind: sessions.customer.kind === 'privy' ? ('privy' as const) : ('local' as const),
      }
    : null;

  const run = useCallback(
    async (work: () => Promise<void>) => {
      setBusy(true);
      setError('');
      try {
        await work();
        router.refresh();
      } catch (e) {
        if (!cancelled(e)) setError(e instanceof Error ? e.message : 'Something went wrong.');
        throw e;
      } finally {
        setBusy(false);
      }
    },
    [router],
  );

  /** A wallet role's client (business, investor or compliance), checked against the signed-in address. */
  const walletFor = useCallback(
    async (role: WalletRole): Promise<WalletClient> => {
      const session = sessions[role];
      if (!session)
        throw new Error(
          role === 'merchant' ? 'Connect your business wallet first.' : `Connect your ${role} wallet first.`,
        );
      const kind = role === 'merchant' ? merchantWalletKind() : walletKind(role);
      if (kind === 'local') {
        const account = localAccount(role);
        if (!account || account.address.toLowerCase() !== session.address.toLowerCase())
          throw new Error('The local test wallet is missing. Connect again.');
        return localClient(account, config);
      }
      const { address, client } = await injectedAccount(config);
      if (address.toLowerCase() !== session.address.toLowerCase())
        throw new Error(
          `Switch your wallet to ${session.address.slice(0, 6)}…${session.address.slice(-4)}, the account you signed in with.`,
        );
      return client;
    },
    [config, sessions],
  );
  const merchantWallet = useCallback(() => walletFor('merchant'), [walletFor]);
  const investor = sessions.investor
    ? {
        address: sessions.investor.address,
        kind: typeof window === 'undefined' ? null : walletKind('investor'),
      }
    : null;
  const compliance = sessions.compliance
    ? {
        address: sessions.compliance.address,
        kind: typeof window === 'undefined' ? null : walletKind('compliance'),
      }
    : null;

  const live: LiveAuth = useMemo(
    () => ({
      config,
      merchant,
      customer,
      investor,
      compliance,
      busy,
      merchantWallet,
      connectWallet: (role: 'investor' | 'compliance', kind: MerchantWalletKind) =>
        run(async () => {
          if (kind === 'local' && !config.localFork)
            throw new Error('Test wallets exist only on a local fork.');
          if (kind === 'local') {
            const account = localAccount(role, true)!;
            await walletSignIn(role, account.address, message => account.signMessage({ message }));
          } else {
            const { address, client } = await injectedAccount(config);
            await walletSignIn(role, address, message => client.signMessage({ account: address, message }));
          }
          rememberWalletKind(role, kind);
        }),
      connectMerchant: (kind: MerchantWalletKind) =>
        run(async () => {
          if (kind === 'local' && !config.localFork)
            throw new Error('Test wallets exist only on a local fork.');
          if (kind === 'local') {
            const account = localAccount('merchant', true)!;
            await walletSignIn('merchant', account.address, message => account.signMessage({ message }));
          } else {
            const { address, client } = await injectedAccount(config);
            await walletSignIn('merchant', address, message =>
              client.signMessage({ account: address, message }),
            );
          }
          rememberMerchantWalletKind(kind);
        }),
      signInCustomer: (kind: 'privy' | 'local', email?: string) => {
        if (kind === 'privy') {
          if (!privy) throw new Error('Email sign-in is not set up.');
          return privy.login();
        }
        return run(async () => {
          if (!config.localFork) throw new Error('Test customers exist only on a local fork.');
          const account = localAccount('customer', true)!;
          await walletSignIn('customer', account.address, message => account.signMessage({ message }), email);
        });
      },
      signOut: (role: 'merchant' | 'customer' | 'investor' | 'compliance') =>
        run(async () => {
          if (role === 'customer' && customer?.kind === 'privy' && privy) await privy.signOut();
          await fetch(`/api/session?role=${role}`, { method: 'DELETE' });
          if (role === 'merchant') rememberMerchantWalletKind(null);
          else if (role === 'customer') forgetLocalAccount('customer');
          else rememberWalletKind(role, null);
        }),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, sessions, busy, privy, merchantWallet, walletFor, run],
  );

  const value: PactAuth = {
    mode: 'live',
    configured: true,
    ready: !privy || privy.ready,
    identity: customer
      ? { email: customer.email, name: customer.email?.split('@')[0] ?? null }
      : merchant
        ? { email: null, name: `${merchant.address.slice(0, 6)}…${merchant.address.slice(-4)}` }
        : null,
    error: error || privy?.error || '',
    login: () => (privy ? privy.login() : undefined),
    async logout() {
      if (privy?.authenticated) await privy.signOut();
      await fetch('/api/session', { method: 'DELETE' });
      rememberMerchantWalletKind(null);
      rememberWalletKind('investor', null);
      rememberWalletKind('compliance', null);
      window.location.replace('/login');
    },
    async sign(request) {
      try {
        // Everyone only signs; Pact's relayer submits and pays the gas.
        if (request.signer === 'investor' || request.signer === 'compliance') {
          const client = await walletFor(request.signer);
          return await client.signTypedData({
            account: client.account!,
            ...signableTypedData(request.typedData),
          });
        }
        if (request.signer === 'merchant') {
          const client = await merchantWallet();
          return await client.signTypedData({
            account: client.account!,
            ...signableTypedData(request.typedData),
          });
        }
        if (!customer) throw new Error('Sign in to continue.');
        if (customer.kind === 'privy') {
          if (!privy) throw new Error('Email sign-in is not set up.');
          return await privy.signTyped(request.typedData);
        }
        const account = localAccount('customer');
        if (!account || account.address.toLowerCase() !== customer.address.toLowerCase())
          throw new Error('Sign in again to continue.');
        return await account.signTypedData(signableTypedData(request.typedData));
      } catch (e) {
        if (cancelled(e)) throw new SignatureCancelled();
        throw e;
      }
    },
    live,
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
