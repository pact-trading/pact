'use client';

import type { ReactNode } from 'react';
import type { LiveConfig } from '@/lib/live-wallet';
import { LiveAuthProvider, type LiveSessions } from './auth/live-auth-provider';
import { MockAuthProvider } from './auth/mock-auth-provider';
import { ToastProvider } from './ui/toast';

export function Providers({
  mode,
  viewer,
  live,
  children,
}: {
  mode: 'mock' | 'api';
  viewer: { name: string; email: string } | null;
  live: { config: LiveConfig; sessions: LiveSessions } | null;
  children: ReactNode;
}) {
  const content = <ToastProvider>{children}</ToastProvider>;
  if (mode === 'mock' || !live) return <MockAuthProvider viewer={viewer}>{content}</MockAuthProvider>;
  return (
    <LiveAuthProvider config={live.config} sessions={live.sessions}>
      {content}
    </LiveAuthProvider>
  );
}
