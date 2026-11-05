'use client';

import { IconFingerprint, IconLoader2, IconShieldLock } from '@tabler/icons-react';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SignRequest } from '@/server/data/types';
import { signOut } from '@/server/actions/demo';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { AuthContext, SignatureCancelled, type PactAuth } from './auth-context';

const fakeSignature = () =>
  `0x${Array.from(crypto.getRandomValues(new Uint8Array(65)), b => b.toString(16).padStart(2, '0')).join('')}`;

/**
 * Stand-in for Privy in mock mode. The confirmation sheet mirrors a passkey prompt:
 * it shows what is being approved in plain language and returns a synthetic signature.
 */
export function MockAuthProvider({
  viewer,
  children,
}: {
  viewer: { name: string; email: string } | null;
  children: ReactNode;
}) {
  const [request, setRequest] = useState<SignRequest | null>(null);
  const [verifying, setVerifying] = useState(false);
  const pending = useRef<{ resolve: (signature: string) => void; reject: (error: Error) => void } | null>(
    null,
  );

  const sign = useCallback(
    (next: SignRequest) =>
      new Promise<string>((resolve, reject) => {
        pending.current?.reject(new SignatureCancelled());
        pending.current = { resolve, reject };
        setVerifying(false);
        setRequest(next);
      }),
    [],
  );

  const cancel = useCallback(() => {
    if (verifying) return;
    pending.current?.reject(new SignatureCancelled());
    pending.current = null;
    setRequest(null);
  }, [verifying]);

  const confirm = () => {
    setVerifying(true);
    window.setTimeout(() => {
      pending.current?.resolve(fakeSignature());
      pending.current = null;
      setRequest(null);
      setVerifying(false);
    }, 900);
  };

  const value = useMemo<PactAuth>(
    () => ({
      mode: 'mock',
      configured: true,
      ready: true,
      identity: viewer ? { email: viewer.email, name: viewer.name } : null,
      error: '',
      login: () => window.location.assign(`/demo?next=${encodeURIComponent(window.location.pathname)}`),
      logout: async () => {
        await signOut();
      },
      sign,
    }),
    [viewer, sign],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      <Dialog
        open={request !== null}
        onClose={cancel}
        dismissible={!verifying}
        title={request?.title ?? 'Confirm'}
        description="Review and confirm with your passkey."
        footer={
          <>
            <Button variant="ghost" onClick={cancel} disabled={verifying}>
              Cancel
            </Button>
            <Button variant="dark" onClick={confirm} disabled={verifying} data-autofocus>
              {verifying ? (
                <IconLoader2 className="size-4.5 animate-spin" />
              ) : (
                <IconFingerprint className="size-4.5" />
              )}
              {verifying ? 'Verifying…' : 'Confirm with passkey'}
            </Button>
          </>
        }
      >
        <dl className="divide-y divide-border-subtle rounded-2xl border border-border">
          {request?.lines.map(line => (
            <div key={line.label} className="flex items-baseline justify-between gap-4 px-4 py-3">
              <dt className="text-sm text-muted-foreground">{line.label}</dt>
              <dd className="text-right text-[15px] font-medium [overflow-wrap:anywhere]">{line.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 flex items-start gap-2 text-[13px] text-muted-foreground">
          <IconShieldLock className="mt-0.5 size-4 shrink-0" />
          You approve a signed message only. Nothing happens unless you confirm, and you never pay network
          fees.
        </p>
      </Dialog>
    </AuthContext.Provider>
  );
}
