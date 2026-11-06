'use client';

import { useCallback } from 'react';
import type { ActionResult } from '@/server/actions/result';
import type { SignRequest } from '@/server/data/types';
import { continueSigned, submitApproval } from '@/server/actions/customer';
import { SignatureCancelled, usePactAuth } from './auth-context';
import { PasskeyCancelled, passkeyAssertion } from '@/lib/passkey';

export type SignedResult<T> = ActionResult<T>;

/**
 * Prepare on the server, confirm with the user's passkey, then submit.
 * Returns the submit result, or an error value with code `cancelled` when the user backs out.
 */
export function useSignedAction() {
  const auth = usePactAuth();
  return useCallback(
    async <T>(
      prepare: () => Promise<ActionResult<SignRequest>>,
      submit: (token: string, signature: string) => Promise<ActionResult<T>>,
    ): Promise<SignedResult<T>> => {
      let prepared = await prepare();
      if (!prepared.ok) return prepared;
      let signature: string;
      try {
        // A first payment carries the one-time USDT permit: sign it, let Pact's relayer submit it,
        // then sign the payment itself. The customer confirms once and pays no gas.
        if (prepared.data.approval) {
          const permit = await auth.sign({ ...prepared.data, typedData: prepared.data.approval.typedData, approval: undefined, also: undefined });
          prepared = await submitApproval(prepared.data.token, { signature: permit });
          if (!prepared.ok) return prepared;
        }
        // A passkey account confirms with a WebAuthn assertion instead of an EIP-712 signature.
        signature = prepared.data.passkey ? await passkeyAssertion(prepared.data.passkey) : await auth.sign(prepared.data);
        // A first-step signature (a plan change's new mandate) yields the next request to sign.
        while (prepared.data.continues) {
          const next = await continueSigned(prepared.data.token, signature);
          if (!next.ok) return next;
          prepared = next;
          signature = await auth.sign(prepared.data);
        }
        // Extra messages in the same confirmation: submit receives every signature, primary first.
        if (prepared.data.also?.length) {
          const extra: string[] = [];
          for (const typedData of prepared.data.also)
            extra.push(await auth.sign({ ...prepared.data, typedData, also: undefined }));
          signature = JSON.stringify([signature, ...extra]);
        }
      } catch (error) {
        return error instanceof SignatureCancelled || error instanceof PasskeyCancelled
          ? { ok: false, error: { code: 'cancelled', message: 'Cancelled. Nothing was signed.' } }
          : {
              ok: false,
              error: {
                code: 'signature_failed',
                message: error instanceof Error ? error.message : 'The confirmation did not complete.',
              },
            };
      }
      return submit(prepared.data.token, signature);
    },
    [auth],
  );
}
