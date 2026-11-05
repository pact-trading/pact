'use client';

import { IconArrowsExchange } from '@tabler/icons-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { Counterparty, TransferRules } from '@/server/data/parts/financing';
import { prepareTransfer, submitTransfer } from '@/server/actions/financing';
import { dateTime, fromMinor, toMinor, usd } from '@/lib/format';
import { usePactAuth } from '../auth/auth-context';
import { useSignedAction } from '../auth/use-signed-action';
import { Button } from '../ui/button';
import { AmountInput, Field, Select } from '../ui/field';
import { Notice } from '../ui/notice';
import { useToast } from '../ui/toast';

const parse = (value: string) => {
  try {
    return toMinor(value || '0');
  } catch {
    return null;
  }
};

/**
 * Moves part or all of a holding to another investor. The token checks who may hold it: an
 * investor who is not approved, the record date and maturity are all refused by the contract,
 * and the refusal shows here. Any price is agreed between the two investors, outside Pact.
 */
export function TransferClaim({
  invoiceId,
  number,
  heldMinor,
  counterparties,
  rules,
}: {
  invoiceId: string;
  number: string;
  heldMinor: string;
  counterparties: Counterparty[];
  rules: TransferRules;
}) {
  const router = useRouter();
  const toast = useToast();
  const signed = useSignedAction();
  const wallet = usePactAuth().mode === 'live';
  const [to, setTo] = useState(counterparties[0]?.id ?? '');
  const [amount, setAmount] = useState(fromMinor(heldMinor));
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const face = parse(amount);
  const valid = face !== null && face > 0n && face <= BigInt(heldMinor) && to !== '';
  const recipient = counterparties.find(c => c.id === to);
  return (
    <div className="grid gap-3">
      <p className="text-sm text-subtle-foreground">
        {rules.open
          ? `Transfers are open until the record date, ${dateTime(rules.recordDateAt)}. Only approved investors can receive this token.`
          : rules.reason}
      </p>
      <Field label="Send to">
        {id => (
          <Select id={id} value={to} onChange={e => setTo(e.target.value)}>
            {counterparties.map(c => (
              <option key={c.id} value={c.id}>
                {c.organization}
                {c.approved ? '' : ' (not approved)'}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Face value" hint={`You hold ${usd(heldMinor)}`}>
        {id => <AmountInput id={id} value={amount} onChange={e => setAmount(e.target.value)} />}
      </Field>
      <Button
        disabled={pending || !valid}
        onClick={() =>
          start(async () => {
            setError('');
            const result = await signed(
              () => prepareTransfer(invoiceId, to, face!.toString()),
              (token, signature) => submitTransfer(token, signature),
            );
            if (result.ok) {
              toast(`Transferred ${usd(face!)} of ${number} to ${recipient?.organization ?? 'the investor'}`);
              router.refresh();
            } else if (result.error.code !== 'cancelled') {
              setError(result.error.message);
              router.refresh();
            }
          })
        }
      >
        <IconArrowsExchange className="size-4.5" />
        {pending ? (wallet ? 'Confirm in your wallet…' : 'Waiting for your passkey…') : 'Transfer'}
      </Button>
      {error && (
        <Notice tone="danger" title="Not transferred">
          {error}
        </Notice>
      )}
      <p className="text-[13px] text-muted-foreground">
        Agree any price with the other investor yourselves; Pact only moves the claim. What you paid and what
        you have received move with it, in proportion.
      </p>
    </div>
  );
}
