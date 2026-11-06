'use client';

import {
  IconArrowRight,
  IconBuildingStore,
  IconChartPie,
  IconFlask,
  IconLogout,
  IconMail,
  IconShieldCheck,
  IconUserCircle,
  IconWallet,
} from '@tabler/icons-react';
import { useEffect, useRef, useState, useTransition } from 'react';
import { usePactAuth } from '@/components/auth/auth-context';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Notice } from '@/components/ui/notice';
import { chooseViewer } from '@/server/actions/demo';

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/**
 * Live sign-in. A business connects a wallet: that address is its workspace and payout account. It
 * only signs, so it needs no WBT.
 * A customer signs in with email (no wallet, no gas). On a local fork, test wallets replace both.
 */
export function LoginCard({ returnTo }: { returnTo?: string }) {
  const auth = usePactAuth();
  const live = auth.live;
  const [error, setError] = useState('');
  const [email, setEmail] = useState('buyer@example.test');
  const [pending, start] = useTransition();
  const awaitingPrivy = useRef(false);

  // After Privy email sign-in finishes, the session cookie is set by the bridge; enter the portal.
  useEffect(() => {
    if (awaitingPrivy.current && live?.customer?.kind === 'privy') {
      awaitingPrivy.current = false;
      start(() => chooseViewer('customer', returnTo));
    }
  }, [live?.customer, returnTo]);

  if (!live)
    return (
      <Notice tone="warning" title="Sign-in is not set up">
        Start the app with `pnpm live`, or run the preview with mock data.
      </Notice>
    );
  const attempt = (work: () => Promise<void> | void, then?: () => Promise<void>) =>
    start(async () => {
      setError('');
      try {
        await work();
        if (then) await then();
      } catch (e) {
        const message = e instanceof Error ? e.message : '';
        if (!/reject|denied|cancel/i.test(message)) setError(message || 'Sign-in failed. Please try again.');
      }
    });
  const busy = pending || live.busy;

  return (
    <div className="grid gap-6">
      {live.config.localFork && (
        <Notice tone="warning" title="Local fork">
          This is a local copy of Whitechain Sepolia. Test wallets and the test faucet work here only.
        </Notice>
      )}

      <section className="grid gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <IconBuildingStore className="size-4.5" /> Run a business
        </h2>
        {live.merchant ? (
          <>
            <p className="text-sm text-muted-foreground">
              Wallet {short(live.merchant.address)} is connected.
            </p>
            <Button
              variant="dark"
              size="lg"
              disabled={busy}
              onClick={() => start(() => chooseViewer('merchant'))}
            >
              Open my business workspace <IconArrowRight className="size-4.5" />
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => attempt(() => live.signOut('merchant'))}>
              <IconLogout className="size-4.5" /> Disconnect wallet
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="dark"
              size="lg"
              disabled={busy}
              onClick={() =>
                attempt(
                  () => live.connectMerchant('injected'),
                  () => chooseViewer('merchant'),
                )
              }
            >
              <IconWallet className="size-4.5" /> Connect wallet
            </Button>
            {live.config.localFork && (
              <Button
                size="lg"
                disabled={busy}
                onClick={() =>
                  attempt(
                    () => live.connectMerchant('local'),
                    () => chooseViewer('merchant'),
                  )
                }
              >
                <IconFlask className="size-4.5" /> Use a local test wallet
              </Button>
            )}
            <p className="text-xs text-muted-foreground">
              You sign a message to prove the wallet is yours. It does not move funds or cost gas.
            </p>
          </>
        )}
      </section>

      <section className="grid gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <IconUserCircle className="size-4.5" /> Pay as a customer
        </h2>
        {live.customer ? (
          <>
            <p className="text-sm text-muted-foreground">
              Signed in as {live.customer.email ?? short(live.customer.address)}.
            </p>
            <Button size="lg" disabled={busy} onClick={() => start(() => chooseViewer('customer', returnTo))}>
              {returnTo ? 'Continue to payment' : 'See my purchases'} <IconArrowRight className="size-4.5" />
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => attempt(() => live.signOut('customer'))}>
              <IconLogout className="size-4.5" /> Sign out
            </Button>
          </>
        ) : (
          <>
            {live.config.privyConfigured && (
              <Button
                size="lg"
                disabled={busy || !auth.ready}
                onClick={() =>
                  attempt(() => {
                    awaitingPrivy.current = true;
                    return live.signInCustomer('privy');
                  })
                }
              >
                <IconMail className="size-4.5" /> Continue with email
              </Button>
            )}
            {live.config.localFork && (
              <form
                className="grid gap-2"
                onSubmit={event => {
                  event.preventDefault();
                  attempt(
                    () => live.signInCustomer('local', email.trim()),
                    () => chooseViewer('customer', returnTo),
                  );
                }}
              >
                <Input
                  type="email"
                  aria-label="Test customer email"
                  value={email}
                  onChange={event => setEmail(event.target.value)}
                  required
                />
                <Button type="submit" size="lg" disabled={busy}>
                  <IconFlask className="size-4.5" /> Use a test customer
                </Button>
              </form>
            )}
            <p className="text-xs text-muted-foreground">
              No wallet, seed phrase or gas. The business pays the fees.
            </p>
          </>
        )}
      </section>

      {live.config.network?.contracts.receivables && (
        <>
          <WalletSide
            role="investor"
            title="Invest in invoices"
            icon={<IconChartPie className="size-4.5" />}
            hint="Approved investors buy invoices with USDT. You only sign: Pact pays the gas."
            open="Open the marketplace"
            busy={busy}
            attempt={attempt}
            start={start}
          />
          <WalletSide
            role="compliance"
            title="Review investors"
            icon={<IconShieldCheck className="size-4.5" />}
            hint="Compliance officers approve and revoke investors in the registry, by signature: Pact pays the gas."
            open="Open the investor registry"
            busy={busy}
            attempt={attempt}
            start={start}
          />
        </>
      )}

      {(error || auth.error) && <Notice tone="danger">{error || auth.error}</Notice>}
    </div>
  );
}

/** Investors and compliance officers sign in with a wallet, like a business. */
function WalletSide({
  role,
  title,
  icon,
  hint,
  open,
  busy,
  attempt,
  start,
}: {
  role: 'investor' | 'compliance';
  title: string;
  icon: React.ReactNode;
  hint: string;
  open: string;
  busy: boolean;
  attempt: (work: () => Promise<void> | void, then?: () => Promise<void>) => void;
  start: (work: () => Promise<void>) => void;
}) {
  const live = usePactAuth().live!;
  const session = live[role];
  return (
    <section className="grid gap-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        {icon} {title}
      </h2>
      {session ? (
        <>
          <p className="text-sm text-muted-foreground">Wallet {short(session.address)} is connected.</p>
          <Button size="lg" disabled={busy} onClick={() => start(() => chooseViewer(role))}>
            {open} <IconArrowRight className="size-4.5" />
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => attempt(() => live.signOut(role))}>
            <IconLogout className="size-4.5" /> Disconnect wallet
          </Button>
        </>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button
              size="lg"
              disabled={busy}
              onClick={() =>
                attempt(
                  () => live.connectWallet(role, 'injected'),
                  () => chooseViewer(role),
                )
              }
            >
              <IconWallet className="size-4.5" /> Connect wallet
            </Button>
            {live.config.localFork && (
              <Button
                size="lg"
                disabled={busy}
                onClick={() =>
                  attempt(
                    () => live.connectWallet(role, 'local'),
                    () => chooseViewer(role),
                  )
                }
              >
                <IconFlask className="size-4.5" /> Test wallet
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </>
      )}
    </section>
  );
}
