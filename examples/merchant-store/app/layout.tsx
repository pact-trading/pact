import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: 'Studio Supply: Pact example store' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, background: '#f5f3ed', color: '#23271e', font: '16px/1.6 system-ui, sans-serif' }}>
        <main style={{ maxWidth: 640, margin: 'auto', padding: '48px 24px' }}>{children}</main>
      </body>
    </html>
  );
}
