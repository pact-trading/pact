import { Disclosure } from '../ui/disclosure';
import { PublicRecord } from '../states/public-record';
import { shortHash, wbt } from '@/lib/format';

/**
 * Network details for curious customers, closed by default.
 * The main checkout never shows a network name, address or gas line.
 */
export function AdvancedDetails({
  details,
  txHash,
}: {
  details: {
    network: string;
    payerAccount: string | null;
    merchantAccount: string;
    gasPaidBy: string;
    gasWei: string | null;
  };
  txHash?: string | null;
}) {
  return (
    <Disclosure summary="Advanced details">
      <dl className="grid gap-2 text-[13px]">
        {[
          ['Network', details.network],
          ['Settles in', 'USDT, official Whitechain test token'],
          [
            'Your account',
            details.payerAccount ? shortHash(details.payerAccount, 8, 6) : 'Created on first payment',
          ],
          ['Merchant account', details.merchantAccount ? shortHash(details.merchantAccount, 8, 6) : '—'],
          [
            'Network fee',
            details.gasWei
              ? `${wbt(details.gasWei, 6)}, paid by ${details.gasPaidBy}`
              : `Paid by ${details.gasPaidBy}`,
          ],
        ].map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right font-mono">{value}</dd>
          </div>
        ))}
        {txHash && (
          <div className="flex justify-between gap-4">
            <dt className="text-muted-foreground">Transaction</dt>
            <dd>
              <PublicRecord hash={txHash} />
            </dd>
          </div>
        )}
      </dl>
    </Disclosure>
  );
}
