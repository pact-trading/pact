import { decodeFunctionData } from 'viem';
import type { Db } from './db.js';
import { escrowAbi } from './chain.js';
import { receivablesAbi } from './financing/chain.js';

/** A submitted, unsettled charge for this payment: an escrow charge, or a financed invoice's payment to `receivables`. */
export function pendingPaymentIntent(db: Db, paymentId: string, escrow: string, receivables?: string) {
  const rows = db.prepare("SELECT id,status,tx_hash,request_json FROM intents WHERE status IN ('submitted','reconciliation_required')").all() as Array<{ id: string; status: string; tx_hash: string | null; request_json: string }>;
  return rows.find(row => {
    try {
      const request = JSON.parse(row.request_json);
      if (receivables && request.intent.target.toLowerCase() === receivables.toLowerCase()) {
        const pay = decodeFunctionData({ abi: receivablesAbi, data: request.data });
        return pay.functionName === 'pay' && String(pay.args?.[1]).toLowerCase() === paymentId.toLowerCase();
      }
      if (request.intent.target.toLowerCase() !== escrow.toLowerCase()) return false;
      const call = decodeFunctionData({ abi: escrowAbi, data: request.data });
      return ['charge', 'authorize'].includes(call.functionName) && String(call.args?.[0]).toLowerCase() === paymentId.toLowerCase();
    } catch { return false; }
  });
}
