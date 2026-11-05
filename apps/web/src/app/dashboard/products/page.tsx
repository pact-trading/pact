import type { Metadata } from 'next';
import Link from 'next/link';
import { IconBox } from '@tabler/icons-react';
import { NewProductButton } from '@/components/merchant/products/product-form';
import { ShareDialog } from '@/components/merchant/products/share-dialog';
import { QrCode } from '@/components/merchant/qr-code';
import { NotConnected } from '@/components/states/not-connected';
import { StatusBadge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { readSort, SortHeader, sortRows } from '@/components/ui/sort-header';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { money } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { publicOrigin } from '@/server/origin';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Products' };

const columns = ['name', 'price', 'status'] as const;
const statusOrder = { active: 0, draft: 1, archived: 2 };

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; dir?: string }>;
}) {
  const sort = readSort(await searchParams, columns);
  const [all, viewer, origin] = await Promise.all([
    load(async () => (await getData()).merchant.products()),
    getViewer(),
    publicOrigin(),
  ]);
  if (isNotWired(all)) return <NotConnected feature={all.feature} />;
  const products = sortRows(all, sort, {
    name: p => p.name,
    price: p => (p.prices[0] ? BigInt(p.prices[0].amountMinor) : null),
    status: p => statusOrder[p.status] ?? 3,
  });
  const header = { sort, path: '/dashboard/products' };
  const readOnly = viewer?.role !== 'merchant';
  return (
    <>
      <PageHeader
        title="Products"
        description="Things you sell once. Each active product has a hosted checkout link and QR code."
        actions={!readOnly && <NewProductButton />}
      />
      <Card>
        {products.length === 0 ? (
          <EmptyState icon={<IconBox />} title="No products yet" action={!readOnly && <NewProductButton />}>
            Create a product to get a payment link you can share or embed.
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <SortHeader label="Product" column="name" {...header} />
                <SortHeader label="Price" column="price" align="right" first="desc" {...header} />
                <SortHeader label="Status" column="status" {...header} />
                <Th align="right">Link</Th>
              </tr>
            </thead>
            <tbody>
              {await Promise.all(
                products.map(async product => {
                  const url = `${origin}/buy/${product.id}`;
                  return (
                    <Tr key={product.id}>
                      <Td>
                        <Link
                          href={`/dashboard/products/${product.id}`}
                          className="font-medium hover:underline"
                        >
                          {product.name}
                        </Link>
                        <p className="max-w-md truncate text-[13px] text-muted-foreground">
                          {product.description}
                        </p>
                      </Td>
                      <Td align="right" className="font-medium">
                        {product.prices[0] ? money(product.prices[0]) : '—'}
                      </Td>
                      <Td>
                        <StatusBadge status={product.status} />
                      </Td>
                      <Td align="right">
                        <ShareDialog
                          name={product.name}
                          url={url}
                          qr={<QrCode value={url} />}
                          disabled={product.status !== 'active'}
                        />
                      </Td>
                    </Tr>
                  );
                }),
              )}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
