'use client';

import { IconCircleCheckFilled, IconCircleDashed, IconSignature } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { FeesDetail, MerchantSpender } from '@pactagent/core/api-types';
import { useSignedAction } from '@/components/auth/use-signed-action';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/cn';
import { prepareAcceptTerms, preparePermit, submitAcceptTerms, submitPermit } from '@/server/actions/merchant';

const PERMIT_TITLES: Record<MerchantSpender, string> = {
  escrow: 'Allow refunds from your wallet',
  router: 'Allow refund network fees in USDT',
};

/**
 * What a merchant signs before Pact can take its payments: the fee terms, once, then two standing
 * USDT permits, one after the other. Each is a signature; Pact's relayer submits it and pays the gas.
 */
export function FeeSetup({ fees, readOnly = false }: { fees: FeesDetail; readOnly?: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const signed = useSignedAction();
  const [pending, start] = useTransition();
  const [working, setWorking] = useState<'terms' | 'permits' | null>(null);
  const [error, setError] = useState('');

  const termsSigned = !fees.terms.needsAcceptance && !fees.terms.newerTermsAvailable;
  const missing = fees.permits.filter(p => p.status !== 'ready');
  const confirming = missing.some(p => p.status === 'pending');

  const signTerms = () =>
    start(async () => {
      setWorking('terms');
      setError('');
      const result = await signed(prepareAcceptTerms, submitAcceptTerms);
      setWorking(null);
      if (result.ok) {
        toast('Fee terms signed');
        router.refresh();
      } else if (result.error.code !== 'cancelled') setError(result.error.message);
    });
  const signPermits = () =>
    start(async () => {
      setWorking('permits');
      setError('');
      // One after the other: the refund permit, then the network-fee permit.
      for (const permit of missing.filter(p => p.status === 'needs_approval')) {
        const result = await signed(() => preparePermit(permit.spender), submitPermit);
        if (!result.ok) {
          setWorking(null);
          if (result.error.code !== 'cancelled') setError(result.error.message);
          router.refresh();
          return;
        }
      }
      setWorking(null);
      toast('Refund permits signed');
      router.refresh();
    });

  const steps = [
    {
      id: 'terms',
      title: fees.terms.newerTermsAvailable ? 'Sign Pact’s new fee terms' : 'Sign Pact’s fee terms',
      detail: termsSigned
        ? `Version ${fees.terms.acceptedVersion}, signed. Pact can take payments for you.`
        : `Until you sign, Pact cannot take payments for you. Version ${fees.terms.latestVersion}.`,
      done: termsSigned,
      action: (
        <Button size="sm" variant="dark" disabled={pending} onClick={signTerms}>
          <IconSignature className="size-4" />
          {working === 'terms' ? 'Signing…' : 'Sign fee terms'}
        </Button>
      ),
    },
    ...fees.permits.map(permit => ({
      id: permit.spender,
      title: PERMIT_TITLES[permit.spender] ?? permit.label,
      detail:
        permit.status === 'ready'
          ? `${permit.label}. In place.`
          : permit.status === 'pending'
            ? 'Confirming on chain…'
            : `${permit.label}. Spent only on refunds you sign.`,
      done: permit.status === 'ready',
      action: null,
    })),
  ];

  return (
    <div className="grid gap-3">
      {steps.map(step => (
        <div
          key={step.id}
          className={cn(
            'flex flex-wrap items-center gap-3 rounded-2xl border border-border p-3',
            step.done && 'opacity-70',
          )}
        >
          {step.done ? (
            <IconCircleCheckFilled className="size-5 shrink-0 text-success" />
          ) : (
            <IconCircleDashed className="size-5 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <p className="font-medium">{step.title}</p>
            <p className="text-sm text-muted-foreground">{step.detail}</p>
          </div>
          {!step.done && !readOnly && step.action && <div className="shrink-0">{step.action}</div>}
        </div>
      ))}
      {!readOnly && missing.length > 0 && (
        <Button
          variant={termsSigned ? 'dark' : 'secondary'}
          className="justify-self-start"
          disabled={pending || confirming}
          onClick={signPermits}
        >
          <IconSignature className="size-4.5" />
          {working === 'permits'
            ? 'Signing…'
            : missing.length === 2
              ? 'Sign the two refund permits'
              : 'Sign the refund permit'}
        </Button>
      )}
      {readOnly && !fees.ready && (
        <p className="text-sm text-muted-foreground">Only the business owner can sign these.</p>
      )}
      {error && <Notice tone="danger">{error}</Notice>}
      <p className="text-[13px] text-muted-foreground">
        Each is a signature, not a transaction: Pact submits it and pays the gas, so your wallet never
        needs WBT. Your customers never pay a fee or gas.
      </p>
    </div>
  );
}
