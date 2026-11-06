import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './globals.css';
import { Providers } from '@/components/providers';
import { DemoBar } from '@/components/shell/demo-bar';
import { LiveBar } from '@/components/shell/live-bar';
import { themeScript } from '@/components/shell/theme-toggle';
import { getData } from '@/server/data';
import { dataMode } from '@/server/mode';
import { liveConfig } from '@/server/live-config';
import { getViewer, liveSessions } from '@/server/viewer';

export const metadata: Metadata = {
  applicationName: 'Pact',
  manifest: '/brand/pact/site.webmanifest',
  icons: {
    icon: [
      { url: '/brand/pact/favicon/favicon.ico' },
      { url: '/brand/pact/svg/pact-app-icon.svg', type: 'image/svg+xml' },
    ],
    apple: '/brand/pact/favicon/apple-touch-icon.png',
  },
  title: { default: 'Pact: get paid in USDT on Whitechain', template: '%s · Pact' },
  description:
    'Checkout, subscriptions, invoices, refunds and agent payments in USDT, with one fee taken from each payment, no gas for anyone and zero crypto steps for customers.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: [{ media: '(prefers-color-scheme: dark)', color: '#090909' }, { color: '#f3f4f6' }],
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const viewer = await getViewer();
  const { demo, lab } = await getData();
  const clock = demo ? await demo.state() : null;
  const scenario = lab ? await lab.scenario() : undefined;
  // Live mode: the browser needs chain access and both sessions (merchant wallet, customer account).
  const live = dataMode === 'api' ? await liveState() : null;
  return (
    <html lang="en" className="theme-light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Providers
          mode={dataMode}
          viewer={viewer ? { name: viewer.name, email: viewer.email } : null}
          live={live}
        >
          {clock && (
            <DemoBar
              role={viewer?.role ?? null}
              name={viewer?.name ?? null}
              now={clock.now}
              offsetDays={clock.offsetDays}
              scenario={scenario}
            />
          )}
          {live && <LiveBar role={viewer?.role ?? null} />}
          {children}
        </Providers>
      </body>
    </html>
  );
}

async function liveState() {
  const [config, sessions] = await Promise.all([liveConfig(), liveSessions()]);
  return {
    config,
    sessions: {
      merchant: sessions.merchant ? { address: sessions.merchant.wallet.address as `0x${string}` } : null,
      investor: sessions.investor ? { address: sessions.investor.wallet.address as `0x${string}` } : null,
      compliance: sessions.compliance
        ? { address: sessions.compliance.wallet.address as `0x${string}` }
        : null,
      customer: sessions.customer
        ? {
            address: sessions.customer.wallet.address as `0x${string}`,
            email: sessions.customer.email,
            kind: sessions.customer.kind === 'wallet' ? ('wallet' as const) : ('privy' as const),
          }
        : null,
    },
  };
}
