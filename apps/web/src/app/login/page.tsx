import type { Metadata } from 'next';
import Link from 'next/link';
import { PactLogo } from '@/components/brand/pact-logo';
import { isMock } from '@/server/mode';
import { LoginCard } from './login-card';
import { DemoViewpointsLink, MockSignIn } from './mock-sign-in';

export const metadata: Metadata = { title: 'Sign in' };
export const dynamic = 'force-dynamic';

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const { returnTo } = await searchParams;
  const safe =
    returnTo && /^\/(checkout|invoice|subscribe|buy|l|pay)\/[\w-]+$/.test(returnTo) ? returnTo : undefined;
  // In the demo any internal page can be the destination; /demo stays the main way in.
  const next = isMock && returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : safe;
  return (
    <main className="grid min-h-dvh place-items-center px-5 py-12">
      <div className="w-full max-w-sm">
        <Link href="/" aria-label="Pact home">
          <PactLogo width={104} />
        </Link>
        <h1 className="mt-10 text-3xl font-semibold">Payments, with less friction.</h1>
        <p className="mt-2 text-[15px] text-muted-foreground">
          {isMock
            ? 'Sign in to run your business or see what you bought. No wallet or seed phrase.'
            : 'Businesses connect a wallet. Customers sign in with email: no wallet, seed phrase or gas.'}
        </p>
        <div className="mt-8 grid gap-6">
          {isMock ? (
            <>
              <MockSignIn next={next} />
              <DemoViewpointsLink />
            </>
          ) : (
            <LoginCard returnTo={safe} />
          )}
        </div>
      </div>
    </main>
  );
}
