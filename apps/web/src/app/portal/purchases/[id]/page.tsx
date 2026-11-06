import type { Metadata } from 'next';
import { AdvancedDetails } from '@/components/customer/advanced-details';
import { Receipt } from '@/components/customer/receipt';
import { PrintButton, Printable } from '@/components/portal/printable';
import { RefundReceipt } from '@/components/portal/refund-receipt';
import { NotConnected } from '@/components/states/not-connected';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody } from '@/components/ui/card';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';

export const metadata: Metadata = { title: 'Receipt' };

export default async function PurchasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await load(async () => (await getData()).customer.order(id));
  if (isNotWired(detail)) return <NotConnected feature={detail.feature} />;
  const { order, payment } = detail;
  const refunds = detail.refunds
    .filter(r => r.status === 'succeeded')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const paidAt = detail.activity.find(a => a.type === 'payment.captured')?.at ?? order.createdAt;
  let before = 0n;
  const receipts = refunds.map(refund => {
    const refundedBefore = before;
    before += BigInt(refund.amountMinor);
    return { refund, refundedBefore };
  });
  return (
    <>
      <PageHeader
        back={{ href: '/portal/purchases', label: 'Purchases' }}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {order.productName}
            {order.status !== 'paid' && <StatusBadge status={order.status} />}
          </span>
        }
        description={`From ${detail.merchantName}`}
        actions={payment && <PrintButton label={refunds.length ? 'Print receipts' : 'Print receipt'} />}
      />
      <div className="mx-auto grid max-w-xl gap-5">
        <Printable className="grid gap-5">
          <Card>
            <CardBody className="grid gap-4 sm:p-7">
              {payment ? (
                <Receipt
                  merchant={detail.merchantName}
                  item={order.productName}
                  amountMinor={order.total.amountMinor}
                  paidAt={paidAt}
                  txHash={payment.txHash}
                  refunds={refunds}
                  reference={order.id}
                  method={
                    payment.method
                      ? `${payment.method.label}${payment.method.demo ? ' (demo)' : ''}`
                      : undefined
                  }
                />
              ) : (
                <Notice>This order was not paid.</Notice>
              )}
            </CardBody>
          </Card>
          {payment &&
            [...receipts]
              .reverse()
              .map(({ refund, refundedBefore }) => (
                <RefundReceipt
                  key={refund.id}
                  merchant={detail.merchantName}
                  item={order.productName}
                  refund={refund}
                  reference={order.id}
                  paidMinor={order.total.amountMinor}
                  refundedBeforeMinor={refundedBefore}
                />
              ))}
        </Printable>
        {payment && (
          <AdvancedDetails
            details={{
              network: 'Whitechain Sepolia (chain 1874)',
              payerAccount: payment.payer,
              merchantAccount: '',
              gasPaidBy: 'Pact',
              gasWei: null,
            }}
            txHash={payment.txHash}
          />
        )}
        <p className="text-center text-[13px] text-muted-foreground">
          Questions about this purchase? Reply to your receipt email and {detail.merchantName} will get back
          to you. Refunds appear here the moment they are sent.
        </p>
      </div>
    </>
  );
}
