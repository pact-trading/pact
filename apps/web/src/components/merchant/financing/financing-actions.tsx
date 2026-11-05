'use client';

import { IconArrowBackUp, IconBuildingBank, IconX } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { FinancedInvoice } from '@/server/data/parts/financing';
import {
  prepareBuyBack,
  prepareCancelFinancing,
  prepareRequestFinancing,
  submitBuyBack,
  submitCancelFinancing,
  submitRequestFinancing,
} from '@/server/actions/financing';
import { date, usd } from '@/lib/format';
import { useSignedAction } from '../../auth/use-signed-action';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { Notice } from '../../ui/notice';
import { useToast } from '../../ui/toast';
import { percent } from './financing-parts';

/**
 * Request financing on an eligible invoice, take a listing down (keeping any unsold part),
 * or buy back a defaulted invoice from its holders.
 */
export function FinancingActions({ invoice }: { invoice: FinancedInvoice }) {
  const router = useRouter();
  const toast = useToast();
  const signed = useSignedAction();
  const [open, setOpen] = useState<'request' | 'cancel' | null>(null);
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const debtor = invoice.debtor.company ?? invoice.debtor.name;
  const { terms } = invoice;
  const partlySold = BigInt(invoice.funding.soldMinor) > 0n;

  const close = () => {
    if (pending) return;
    setOpen(null);
    setError('');
  };
  // Listing sells the invoice's future payment, so the business's wallet confirms it (and a cancellation).
  const run = (kind: 'request' | 'cancel') =>
    start(async () => {
      setError('');
      const result =
        kind === 'request'
          ? await signed(
              () => prepareRequestFinancing(invoice.invoiceId),
              (token, signature) => submitRequestFinancing(token, signature),
            )
          : await signed(
              () => prepareCancelFinancing(invoice.invoiceId),
              (token, signature) => submitCancelFinancing(token, signature),
            );
      if (!result.ok) {
        if (result.error.code !== 'cancelled') setError(result.error.message);
        router.refresh();
        return;
      }
      setOpen(null);
      toast(
        kind === 'request'
          ? `${invoice.number} listed for investors`
          : partlySold
            ? 'Listing closed; you keep the unsold part'
            : 'Financing request cancelled',
      );
      router.refresh();
    });

  if (invoice.status === 'eligible')
    return (
      <>
        <Button variant="dark" className="w-full sm:w-auto" onClick={() => setOpen('request')}>
          <IconBuildingBank className="size-4.5" />
          Request financing
        </Button>
        <Dialog
          open={open === 'request'}
          onClose={close}
          title={`Request financing for ${invoice.number}?`}
          description="Your invoice is listed for approved investors. Nothing moves until one buys."
          footer={
            <>
              <Button onClick={close} disabled={pending}>
                Not now
              </Button>
              <Button variant="dark" onClick={() => run('request')} disabled={pending} data-autofocus>
                {pending ? 'Requesting…' : 'Request financing'}
              </Button>
            </>
          }
        >
          <div className="grid gap-3 text-[15px] text-subtle-foreground">
            <p>
              If investors buy all of it, you receive{' '}
              <strong className="text-foreground">{usd(terms.upfrontMinor)}</strong> right away and{' '}
              {usd(terms.reserveMinor)} more when {debtor} pays, {usd(terms.netAdvanceMinor)} in all.
              Investors can buy part of it; you keep any part that is not sold.
            </p>
            <p>
              {debtor} pays the {usd(terms.faceMinor)} invoice as usual, and the contract sends it straight to
              the investors. If it arrives after {date(terms.maturityAt)}, they receive a{' '}
              {percent(terms.lateFeeBps)} late fee from the reserve. If it has not arrived by{' '}
              {date(terms.graceEndsAt)}, the reserve goes to them and you buy back the rest.
            </p>
            {error && <Notice tone="danger">{error}</Notice>}
          </div>
        </Dialog>
      </>
    );

  if (invoice.status === 'requested')
    return (
      <>
        <Button variant="danger" className="w-full sm:w-auto" onClick={() => setOpen('cancel')}>
          <IconX className="size-4.5" />
          {partlySold ? 'Close the listing' : 'Cancel request'}
        </Button>
        <Dialog
          open={open === 'cancel'}
          onClose={close}
          title={partlySold ? 'Close the listing?' : 'Cancel the financing request?'}
          description={
            partlySold
              ? `Investors keep the ${usd(invoice.funding.soldMinor)} they bought. You keep the other ${usd(invoice.funding.unsoldMinor)}.`
              : `${invoice.number} is taken off the marketplace. No money has moved.`
          }
          footer={
            <>
              <Button onClick={close} disabled={pending} data-autofocus>
                Keep it listed
              </Button>
              <Button variant="danger" onClick={() => run('cancel')} disabled={pending}>
                {pending ? 'Closing…' : partlySold ? 'Close the listing' : 'Cancel request'}
              </Button>
            </>
          }
        >
          <div className="grid gap-3 text-[15px] text-subtle-foreground">
            <p>
              {partlySold
                ? `When ${debtor} pays, the investors’ share goes to them and your share comes to you.`
                : 'You can request financing again later while the invoice is unpaid and not yet due.'}
            </p>
            {error && <Notice tone="danger">{error}</Notice>}
          </div>
        </Dialog>
      </>
    );

  if (invoice.status === 'defaulted')
    return (
      <div className="grid gap-3">
        <Button
          variant="dark"
          className="w-full sm:w-auto"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError('');
              const result = await signed(
                () => prepareBuyBack(invoice.invoiceId),
                (token, signature) => submitBuyBack(token, signature),
              );
              if (result.ok) {
                toast(`Bought back ${invoice.number} for ${usd(invoice.buyBackMinor)}`);
                router.refresh();
              } else if (result.error.code !== 'cancelled') {
                setError(result.error.message);
                router.refresh();
              }
            })
          }
        >
          <IconArrowBackUp className="size-4.5" />
          {pending ? 'Waiting for your confirmation…' : `Buy back for ${usd(invoice.buyBackMinor)}`}
        </Button>
        <p className="text-[13px] text-muted-foreground">
          You sold this invoice with recourse: the reserve already went to the investors, and the buy-back
          pays them the rest. {debtor}’s payment then comes to you.
        </p>
        {error && (
          <Notice tone="danger" title="Not bought back">
            {error}
          </Notice>
        )}
      </div>
    );

  return null;
}
