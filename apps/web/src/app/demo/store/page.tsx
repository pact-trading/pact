import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { IconChevronRight, IconShoppingBag, IconUserCircle } from '@tabler/icons-react';
import { BuyButton } from '@/components/lab/buy-button';
import { ProductArt } from '@/components/lab/product-art';
import { StoreFrame } from '@/components/lab/store-frame';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { SectionTitle } from '@/components/ui/page-header';
import { date, usd } from '@/lib/format';
import { getData } from '@/server/data';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Demo store' };
export const dynamic = 'force-dynamic';

/** A fictional merchant website that sells Kite Labs' products through Pact. Mock mode only. */
export default async function StorePage() {
  const { lab } = await getData();
  if (!lab) redirect('/login');
  const [viewer, store] = await Promise.all([getViewer(), lab.storefront()]);
  return (
    <StoreFrame brand={store.brand} shopper={store.shopper}>
      <div className="mb-8">
        <p className="text-sm font-medium text-muted-foreground">{store.brand.brandName} store</p>
        <h1 className="mt-1 text-[30px] leading-tight font-semibold sm:text-4xl">Shop</h1>
        <p className="mt-2 max-w-2xl text-[15px] text-muted-foreground">
          Services and tools from {store.brand.brandName}. Prices in dollars, no fees at checkout.
        </p>
      </div>
      {!store.shopper && (
        <Notice
          className="mb-6"
          title={viewer ? `You are viewing as ${viewer.name}` : 'Browsing as a guest'}
          action={
            <Button asChild size="sm" variant="dark">
              <a href="/demo/as/customer?next=/demo/store">
                <IconUserCircle className="size-4" />
                Shop as Jordan
              </a>
            </Button>
          }
        >
          Buying needs a customer. Jordan Lee from Acme Robotics shops here in the demo.
        </Notice>
      )}
      {store.products.length === 0 ? (
        <Card>
          <EmptyState icon={<IconShoppingBag />} title="Nothing for sale yet">
            Products {store.brand.brandName} marks active appear here.
          </EmptyState>
        </Card>
      ) : (
        <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {store.products.map(product => (
            <li key={product.id}>
              <Card className="flex h-full flex-col overflow-hidden">
                <ProductArt
                  productId={product.id}
                  imageUrl={product.imageUrl}
                  name={product.name}
                  className="aspect-[4/3]"
                />
                <div className="flex flex-1 flex-col gap-2 p-5">
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="text-base font-semibold">{product.name}</h2>
                    <p className="shrink-0 font-semibold tabular-nums">
                      {usd(product.prices[0].amountMinor)}
                    </p>
                  </div>
                  <p className="flex-1 text-sm text-muted-foreground">{product.description}</p>
                  <div className="mt-2">
                    {store.shopper ? (
                      <BuyButton productId={product.id} name={product.name} />
                    ) : (
                      <Button asChild variant="secondary" className="w-full">
                        <a href="/demo/as/customer?next=/demo/store">Shop as Jordan to buy</a>
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
      {store.shopper && (
        <>
          <SectionTitle>Your orders</SectionTitle>
          <Card>
            {store.orders.length === 0 ? (
              <EmptyState title="No orders yet">Orders you place here appear with their status.</EmptyState>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {store.orders.map(order => (
                  <li key={order.orderId}>
                    <Link
                      href={`/demo/store/orders/${order.orderId}`}
                      className="flex items-center gap-3 px-5 py-3.5 hover:bg-raised"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="font-medium">{order.productName}</p>
                        <p className="text-[13px] text-muted-foreground">
                          {date(order.createdAt)} · {usd(order.amountMinor)}
                        </p>
                      </div>
                      {order.fulfilment.count > 0 ? (
                        <Badge tone="success">Fulfilled</Badge>
                      ) : (
                        <StatusBadge
                          status={order.paidAt ? 'paid' : (order.checkoutStatus ?? order.orderStatus)}
                        />
                      )}
                      <IconChevronRight className="size-4 text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      )}
    </StoreFrame>
  );
}
