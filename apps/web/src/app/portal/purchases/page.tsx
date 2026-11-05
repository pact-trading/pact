import type { Metadata } from 'next';
import Link from 'next/link';
import { IconShoppingBag } from '@tabler/icons-react';
import { NotConnected } from '@/components/states/not-connected';
import { StatusBadge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { dateTime, money, usd } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';

export const metadata: Metadata = { title: 'Purchases' };

export default async function PurchasesPage() {
  const orders = await load(async () => (await getData()).customer.orders());
  if (isNotWired(orders)) return <NotConnected feature={orders.feature} />;
  return (
    <>
      <PageHeader title="Purchases" description="Receipts and refunds for everything you bought." />
      <Card>
        {orders.length === 0 ? (
          <EmptyState icon={<IconShoppingBag />} title="No purchases yet">
            Receipts for everything you buy at a Pact checkout appear here, with any refunds.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border-subtle">
            {orders.map(o => (
              <li key={o.id}>
                <Link
                  href={`/portal/purchases/${o.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hover:bg-raised"
                >
                  <div>
                    <p className="font-medium">{o.productName}</p>
                    <p className="text-sm text-muted-foreground">{dateTime(o.createdAt)}</p>
                  </div>
                  <div className="flex items-center gap-3 text-right">
                    {o.refundedMinor !== '0' && (
                      <span className="text-sm text-success">
                        {usd(o.refundedMinor)} refunded · refund receipt
                      </span>
                    )}
                    <span className="font-semibold">{money(o.total)}</span>
                    <StatusBadge status={o.status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
