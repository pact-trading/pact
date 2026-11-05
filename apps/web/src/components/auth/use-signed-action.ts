'use client';

import { useCallback } from 'react';
import type { ActionResult } from '@/server/actions/result';
import type { SignRequest } from '@/server/data/types';
import type { Hex } from 'viem';
import { continueSigned, submitApproval } from '@/server/actions/customer';
import { SignatureCancelled, usePactAuth } from './auth-context';

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
        // A first payment carries the one-time USDT approval: sign it, let the relayer send it,
        // then sign the payment itself. The customer confirms once.
        if (prepared.data.approval) {
          if (!auth.live) throw new Error('This payment needs an approval that only live mode can collect.');
          const { message, delegate, nonce } = prepared.data.approval;
          const approval = await auth.live.approveAsCustomer(message as Hex, delegate as Hex | null, nonce);
          prepared = await submitApproval(prepared.data.token, approval);
          if (!prepared.ok) return prepared;
        }
        signature = await auth.sign(prepared.data);
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
        return error instanceof SignatureCancelled
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
