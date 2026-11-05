import type { Metadata } from 'next';
import { EditProductForm } from '@/components/merchant/products/product-form';
import { ShareDialog } from '@/components/merchant/products/share-dialog';
import { inkOn } from '@/components/merchant/invoices/invoice-preview';
import { QrCode } from '@/components/merchant/qr-code';
import { NotConnected } from '@/components/states/not-connected';
import { StatusBadge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader, DetailList } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { money } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { publicOrigin } from '@/server/origin';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Product' };

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getData();
  const [product, viewer, origin, orders, settings, preferences] = await Promise.all([
    load(() => data.merchant.product(id)),
    getViewer(),
    publicOrigin(),
    load(() => data.merchant.orders()),
    load(() => data.merchant.settings()),
    load(() => data.merchant.preferences()),
  ]);
  if (isNotWired(product)) return <NotConnected feature={product.feature} />;
  const sold = isNotWired(orders)
    ? []
    : orders.filter(o => o.productId === id && ['paid', 'partially_refunded', 'refunded'].includes(o.status));
  const url = `${origin}/buy/${product.id}`;
  const brandName = isNotWired(settings) ? 'Your business' : settings.brandName;
  const color = isNotWired(preferences) ? '#c6ff34' : preferences.brandColor;
  const price = product.prices[0] ? money(product.prices[0]) : '—';
  return (
    <>
      <PageHeader
        back={{ href: '/dashboard/products', label: 'Products' }}
        title={product.name}
        description={product.description}
        actions={
          <ShareDialog
            name={product.name}
            url={url}
            qr={<QrCode value={url} />}
            disabled={product.status !== 'active'}
          />
        }
      />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Details" />
          <CardBody>
            <EditProductForm product={product} readOnly={viewer?.role === 'accountant'} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Summary" />
          <CardBody>
            <DetailList
              items={[
                { label: 'Status', value: <StatusBadge status={product.status} /> },
                {
                  label: 'Price',
                  value: product.prices[0] ? money(product.prices[0]) : '—',
                  hint: 'Settled in USDT',
                },
                { label: 'Revision', value: product.revision },
                { label: 'Paid orders', value: sold.length },
                { label: 'Checkout link', value: <code className="text-[13px]">/buy/{product.id}</code> },
              ]}
            />
          </CardBody>
        </Card>
        <Card className="lg:col-start-2">
          <CardHeader title="Checkout preview" description="The saved product with your brand settings" />
          <CardBody>
            <div className="overflow-hidden rounded-2xl border border-border bg-background">
              <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-3">
                <span
                  aria-hidden
                  className="grid size-8 place-items-center rounded-lg text-sm font-semibold"
                  style={{ background: color, color: inkOn(color) }}
                >
                  {brandName.slice(0, 1).toUpperCase()}
                </span>
                <span className="truncate text-sm font-semibold">{brandName}</span>
              </div>
              <div className="grid gap-3 p-4">
                <div>
                  <p className="font-semibold">{product.name}</p>
                  {product.description && (
                    <p className="text-sm text-muted-foreground">{product.description}</p>
                  )}
                </div>
                <p className="text-2xl font-semibold tracking-tight">{price}</p>
                <div
                  aria-hidden
                  className="flex h-10 items-center justify-center rounded-full text-sm font-semibold"
                  style={{ background: color, color: inkOn(color) }}
                >
                  Pay {price}
                </div>
                {product.status !== 'active' && (
                  <p className="text-center text-[13px] text-muted-foreground">
                    Not on sale: activate the product to open its checkout.
                  </p>
                )}
              </div>
            </div>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
