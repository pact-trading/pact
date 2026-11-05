'use client';

import { IconCoins, IconEye, IconSend } from '@tabler/icons-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type ReactNode } from 'react';
import type { InvoiceStatus } from '@pactagent/core/api-types';
import { sendInvoice } from '@/server/actions/merchant';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { useToast } from '../../ui/toast';
import { ShareDialog } from '../products/share-dialog';
import { ReminderDialog } from './reminder-dialog';

/** Header actions on an invoice: preview, share, send, remind and finance. */
export function InvoiceActions({
  id,
  number,
  status,
  hostedUrl,
  readOnly,
  qr,
  preview,
  reminder,
  financeHref,
}: {
  id: string;
  number: string;
  status: InvoiceStatus;
  hostedUrl: string;
  readOnly: boolean;
  qr: ReactNode;
  preview: ReactNode;
  reminder: { to: string; defaultMessage: string; now: string } | null;
  financeHref: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [previewing, setPreviewing] = useState(false);
  const [pending, start] = useTransition();
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setPreviewing(true)}>
        <IconEye className="size-4" />
        Preview
      </Button>
      <Dialog
        open={previewing}
        onClose={() => setPreviewing(false)}
        title="Customer view"
        description={
          status === 'draft'
            ? 'A preview of what the payer opens once you send it, with your brand.'
            : 'A preview of what the payer opens from the link, with your brand.'
        }
        footer={
          <Button variant="ghost" onClick={() => setPreviewing(false)}>
            Close
          </Button>
        }
      >
        {preview}
      </Dialog>
      {status !== 'draft' && (
        <ShareDialog
          name={number}
          url={hostedUrl}
          qr={qr}
          label="Share"
          description="The payer opens this link, signs in with email or a passkey and pays. No wallet needed."
          openLabel="Open payer view"
          note="Payments through this link update the invoice and its activity. The amount is fixed by the server."
          snippet={false}
        />
      )}
      {!readOnly && status === 'draft' && (
        <Button
          size="sm"
          variant="dark"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const result = await sendInvoice(id);
              if (result.ok) toast('Invoice sent');
              else toast(result.error.message, 'danger');
              router.refresh();
            })
          }
        >
          <IconSend className="size-4" />
          Send invoice
        </Button>
      )}
      {!readOnly && reminder && (
        <ReminderDialog
          invoiceId={id}
          to={reminder.to}
          defaultMessage={reminder.defaultMessage}
          now={reminder.now}
        />
      )}
      {financeHref && (
        <Button asChild size="sm" variant="primary">
          <Link href={financeHref}>
            <IconCoins className="size-4" />
            Finance this invoice
          </Link>
        </Button>
      )}
    </>
  );
}
