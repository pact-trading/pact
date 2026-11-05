import type { Metadata } from 'next';
import Link from 'next/link';
import { IconLink, IconPlus } from '@tabler/icons-react';
import { LinkStateBadge, linkAmount } from '@/components/merchant/payment-links/link-state';
import { LinkStatusButton } from '@/components/merchant/payment-links/link-status-button';
import { ShareDialog } from '@/components/merchant/products/share-dialog';
import { QrCode } from '@/components/merchant/qr-code';
import { SearchBox } from '@/components/merchant/search-box';
import { NotConnected } from '@/components/states/not-connected';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { listHref, readSort, SortHeader, sortParams, sortRows } from '@/components/ui/sort-header';
import { Stat, StatGrid } from '@/components/ui/stat';
import { Table, Td, Th, Tr } from '@/components/ui/table';
import { LinkTabs } from '@/components/ui/tabs';
import { date, usd } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Payment links' };

const states = [
  ['all', 'All'],
  ['active', 'Active'],
  ['inactive', 'Off'],
  ['expired', 'Expired'],
  ['used', 'Used'],
] as const;
const columns = ['name', 'amount', 'payments', 'collected', 'visits', 'expires', 'created'] as const;
const PATH = '/dashboard/payment-links';

function NewLinkButton() {
  return (
    <Button asChild variant="primary" size="sm">
      <Link href="/dashboard/payment-links/new">
        <IconPlus className="size-4" />
        New payment link
      </Link>
    </Button>
  );
}

export default async function PaymentLinksPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string; sort?: string; dir?: string }>;
}) {
  const params = await searchParams;
  const { status = 'all', q } = params;
  const sort = readSort(params, columns);
  const data = await getData();
  const [all, viewer] = await Promise.all([
    load(() => data.commerce.paymentLinks({ query: q })),
    getViewer(),
  ]);
  if (isNotWired(all)) return <NotConnected feature={all.feature} />;
  const canWrite = viewer?.role === 'merchant';
  const counted = all.length === 0 || all.some(l => l.payments !== null);
  const links = sortRows(
    all.filter(l => status === 'all' || l.state === status),
    sort,
    {
      name: l => l.name,
      amount: l => (l.amountMinor === null ? null : BigInt(l.amountMinor)),
      payments: l => l.payments,
      collected: l => (l.collectedMinor === null ? null : BigInt(l.collectedMinor)),
      visits: l => l.visits,
      expires: l => l.expiresAt,
      created: l => l.createdAt,
    },
  );
  const keep = { status: status === 'all' ? undefined : status, q };
  const header = { sort, path: PATH, params: keep };
  const collected = all.reduce((t, l) => t + BigInt(l.collectedMinor ?? '0'), 0n);
  return (
    <>
      <PageHeader
        title="Payment links"
        description="Get paid without an invoice: share a link or QR code for a fixed price, a deposit or a tip."
        actions={
          <>
            <SearchBox
              placeholder="Search payment links"
              value={q}
              keep={{ status: keep.status, ...sortParams(sort) }}
            />
            {canWrite && <NewLinkButton />}
          </>
        }
      />
      <StatGrid className="mb-6">
        <Stat
          label="Taking payments"
          value={all.filter(l => l.state === 'active').length}
          hint={`of ${all.length} links`}
        />
        <Stat label="Visits" value={all.reduce((t, l) => t + l.visits, 0).toLocaleString('en-US')} />
        <Stat
          label="Payments"
          value={counted ? all.reduce((t, l) => t + (l.payments ?? 0), 0) : '—'}
          hint={counted ? 'Completed through a link' : 'Not counted by the API yet'}
        />
        <Stat
          label="Collected"
          value={counted ? usd(collected) : '—'}
          hint={counted ? 'After refunds' : undefined}
        />
      </StatGrid>
      <LinkTabs
        label="Link status"
        active={status}
        items={states.map(([value, label]) => ({
          value,
          label,
          href: listHref(PATH, { status: value === 'all' ? undefined : value, q, ...sortParams(sort) }),
          count: all.filter(l => value === 'all' || l.state === value).length,
        }))}
      />
      <Card>
        {links.length === 0 ? (
          <EmptyState
            icon={<IconLink />}
            title={all.length === 0 && !q ? 'No payment links yet' : 'No payment links here'}
            action={canWrite && all.length === 0 && !q && <NewLinkButton />}
          >
            {q
              ? `Nothing matches “${q}”.`
              : all.length === 0
                ? 'Create a link to take a payment without an invoice. Payers need only an email or a passkey.'
                : 'No links have this status.'}
          </EmptyState>
        ) : (
          <Table>
            <thead>
              <tr>
                <SortHeader label="Link" column="name" {...header} />
                <SortHeader label="Amount" column="amount" align="right" first="desc" {...header} />
                <SortHeader label="Payments" column="payments" align="right" first="desc" {...header} />
                <SortHeader label="Collected" column="collected" align="right" first="desc" {...header} />
                <SortHeader
                  label="Visits"
                  column="visits"
                  align="right"
                  first="desc"
                  className="hidden 2xl:table-cell"
                  {...header}
                />
                <SortHeader label="Expires" column="expires" first="asc" {...header} />
                <Th>Status</Th>
                <Th align="right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {await Promise.all(
                links.map(async link => (
                  <Tr key={link.id}>
                    <Td>
                      <Link href={`${PATH}/${link.id}`} className="font-medium hover:underline">
                        {link.name}
                      </Link>
                      <p className="max-w-56 truncate text-[13px] text-muted-foreground">
                        {link.description ?? <span className="font-mono text-[12px]">{link.id}</span>}
                      </p>
                    </Td>
                    <Td align="right" className="font-medium">
                      {linkAmount(link)}
                    </Td>
                    <Td align="right">
                      {link.payments === null ? '—' : `${link.payments}${link.singleUse ? ' of 1' : ''}`}
                    </Td>
                    <Td align="right">{link.collectedMinor === null ? '—' : usd(link.collectedMinor)}</Td>
                    <Td align="right" className="hidden text-muted-foreground 2xl:table-cell">
                      {link.visits.toLocaleString('en-US')}
                    </Td>
                    <Td className="text-muted-foreground">
                      {link.expiresAt ? date(link.expiresAt) : 'Never'}
                    </Td>
                    <Td>
                      <LinkStateBadge state={link.state} />
                    </Td>
                    <Td align="right">
                      <div className="flex justify-end gap-1.5 whitespace-nowrap">
                        <ShareDialog
                          name={link.name}
                          url={link.url}
                          qr={<QrCode value={link.url} />}
                          disabled={link.state !== 'active'}
                          disabledReason="Only an active link can be shared"
                          description="A hosted page anyone can pay with email or a passkey."
                          openLabel="Open pay page"
                          note="Payments made through this link show up in Orders and on the link’s page."
                        />
                        {canWrite && (link.status === 'active' || data.mode === 'mock') && (
                          <LinkStatusButton id={link.id} name={link.name} status={link.status} />
                        )}
                      </div>
                    </Td>
                  </Tr>
                )),
              )}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
