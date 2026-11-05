import type { Metadata } from 'next';
import { DiscountForm, ArchiveDiscount } from '@/components/merchant/discounts/discount-form';
import { NotConnected } from '@/components/states/not-connected';
import { PageHeader } from '@/components/ui/page-header';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Discounts' };
export default async function DiscountsPage() {
  const [discounts, products, plans, viewer] = await Promise.all([
    load(async () => (await getData()).commerce.discounts()),
    load(async () => (await getData()).merchant.products()),
    load(async () => (await getData()).commerce.plans()),
    getViewer(),
  ]);
  if (isNotWired(discounts)) return <NotConnected feature={discounts.feature} />;
  if (isNotWired(products)) return <NotConnected feature={products.feature} />;
  return <>
    <PageHeader title="Discounts" description="Create codes for products and plans. Prices are calculated when checkout opens." />
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,420px)]">
      <section className="overflow-hidden rounded-2xl border border-border bg-card">
        <h2 className="border-b border-border px-5 py-4 text-lg font-semibold">Codes</h2>
        {discounts.length === 0 ? <p className="p-5 text-sm text-muted-foreground">No discount codes yet.</p> : <div className="divide-y divide-border">{discounts.map(d => <div key={d.id} className="flex flex-wrap items-center justify-between gap-3 p-5"><div><p className="font-semibold">{d.code}</p><p className="text-sm text-muted-foreground">{d.kind === 'percent' ? `${Number(d.value) / 100}%` : `${Number(d.value) / 1_000_000} USDT`} off · {d.duration}{d.duration === 'repeating' ? ` for ${d.periods} periods` : ''}</p><p className="text-xs text-muted-foreground">{d.redemptions}{d.maxRedemptions === null ? '' : ` / ${d.maxRedemptions}`} uses · {d.status}</p></div>{viewer?.role === 'merchant' && d.status === 'active' && <ArchiveDiscount id={d.id} />}</div>)}</div>}
      </section>
      {viewer?.role === 'merchant' && <DiscountForm products={products} plans={isNotWired(plans) ? [] : plans.filter(plan => plan.status !== 'archived')} />}
    </div>
  </>;
}
