'use client';

import { IconShieldCheck, IconShieldOff } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { prepareInvestorApproval, submitInvestorApproval } from '@/server/actions/financing';
import { useSignedAction } from '../auth/use-signed-action';
import { Button } from '../ui/button';
import { useToast } from '../ui/toast';

/** Approves or revokes an investor in the registry the receivables token checks on every move. */
export function ApprovalButton({
  investorId,
  organization,
  decision,
}: {
  investorId: string;
  organization: string;
  decision: 'approve' | 'revoke';
}) {
  const router = useRouter();
  const toast = useToast();
  const signed = useSignedAction();
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  return (
    <div className="grid justify-items-end gap-1">
      <Button
        size="sm"
        variant={decision === 'approve' ? 'dark' : 'danger'}
        disabled={pending}
        aria-label={`${decision === 'approve' ? 'Approve' : 'Revoke'} ${organization}`}
        onClick={() =>
          start(async () => {
            setError('');
            const result = await signed(
              () => prepareInvestorApproval(investorId, decision),
              (token, signature) => submitInvestorApproval(token, signature),
            );
            if (result.ok) {
              toast(`${organization} ${decision === 'approve' ? 'approved' : 'revoked'}`);
              router.refresh();
            } else if (result.error.code !== 'cancelled') setError(result.error.message);
          })
        }
      >
        {decision === 'approve' ? (
          <IconShieldCheck className="size-4" />
        ) : (
          <IconShieldOff className="size-4" />
        )}
        {pending ? 'Confirming…' : decision === 'approve' ? 'Approve' : 'Revoke'}
      </Button>
      {error && <p className="text-[13px] text-destructive">{error}</p>}
    </div>
  );
}
