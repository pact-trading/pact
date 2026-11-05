import type { Metadata } from 'next';
import Link from 'next/link';
import { IconArrowRight, IconRobot } from '@tabler/icons-react';
import { AddFunds } from '@/components/customer/add-funds';
import { NotConnected } from '@/components/states/not-connected';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Notice } from '@/components/ui/notice';
import { PageHeader } from '@/components/ui/page-header';
import { date, money, period, toMinor, usd, usdDecimal } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Your account' };

export default async function PortalHome() {
  const data = await getData();
  const [viewer, account, orders, subs, invoices, agents, plans] = await Promise.all([
    getViewer(),
    load(() => data.customer.account()),
    load(() => data.customer.orders()),
    load(() => data.customer.subscriptions()),
    load(() => data.customer.invoices()),
    load(() => data.customer.agents()),
    data.customer.availablePlans().catch(() => []),
  ]);
  if (isNotWired(orders)) return <NotConnected feature={orders.feature} />;
  const due = isNotWired(invoices) ? [] : invoices.filter(i => i.status !== 'paid');
  const owed = due.reduce((t, i) => t + toMinor(i.remaining), 0n);
  const overdue = due.filter(i => i.status === 'overdue').length;
  const active = isNotWired(subs) ? [] : subs.filter(s => s.status !== 'cancelled');
  const stopped = isNotWired(subs)
    ? []
    : subs.flatMap(s =>
        s.charges
          .filter(c => c.status === 'refused' && c.reason !== 'insufficient_funds')
          .map(c => ({ ...c, plan: s.plan, subId: s.id })),
      );
  return (
    <>
      <PageHeader
        title={`Hi ${viewer?.name.split(' ')[0] ?? 'there'}`}
        description={
          viewer
            ? `${viewer.name} · ${viewer.email}. Your payments, subscriptions, invoices and agents, with a public record for each.`
            : 'Your payments, subscriptions, invoices and agents, with a public record for each.'
        }
      />
      {!isNotWired(invoices) && (
        <div
          role="status"
          className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card px-5 py-4 shadow-panel"
        >
          <p className="text-[15px]">
            Amount due: <strong className="font-semibold">{usd(owed)}</strong>
            <span className="text-muted-foreground">
              {due.length
                ? ` across ${due.length} invoice${due.length === 1 ? '' : 's'}${overdue ? `, ${overdue} overdue` : ''}`
                : ' · you are all paid up'}
            </span>
          </p>
          {due.length > 0 && (
            <Button asChild size="sm" variant="dark">
              <Link href={due.length === 1 ? `/invoice/${due[0].id}` : '/portal/invoices'}>
                {due.length === 1 ? 'Pay now' : 'See invoices'}
              </Link>
            </Button>
          )}
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="Balance" description="What you can spend at any Pact checkout" />
          <CardBody className="grid gap-4">
            {isNotWired(account) ? (
              <p className="text-sm text-muted-foreground">Unavailable</p>
            ) : (
              <p className="text-4xl font-semibold tracking-tight">{usd(account.balanceMinor)}</p>
            )}
            {!isNotWired(account) && BigInt(account.balanceMinor) < 1_000_000_000n && (
              <AddFunds balanceMinor={account.balanceMinor} />
            )}
          </CardBody>
        </Card>
        <Card>
          <CardHeader
            title="Due"
            action={
              <Link href="/portal/invoices" className="text-sm font-medium hover:underline">
                All invoices
              </Link>
            }
          />
          {due.length === 0 ? (
            <EmptyState title="Nothing due">Invoices you owe appear here.</EmptyState>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {due.map(i => (
                <li key={i.id}>
                  <Link
                    href={`/invoice/${i.id}`}
                    className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-raised"
                  >
                    <div>
                      <p className="font-medium">
                        {i.number} · {i.merchantName}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Due {i.dueAt ? date(i.dueAt) : 'on receipt'}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold">{usdDecimal(i.remaining)}</p>
                      <StatusBadge status={i.status} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {stopped.length > 0 && (
        <Notice tone="shield" title="Your limits held" className="mt-6">
          {stopped.length === 1 ? 'A charge' : `${stopped.length} charges`} outside what you approved{' '}
          {stopped.length === 1 ? 'was' : 'were'} refused, most recently on {stopped[0].plan} (
          {stopped[0].reason?.replaceAll('_', ' ')}). No money moved.{' '}
          <Link className="font-medium underline" href={`/portal/subscriptions/${stopped[0].subId}`}>
            See the record
          </Link>
        </Notice>
      )}
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Recent purchases"
            action={
              <Link href="/portal/purchases" className="text-sm font-medium hover:underline">
                All
              </Link>
            }
          />
          {orders.length === 0 ? (
            <EmptyState title="No purchases yet">Receipts and refunds appear here.</EmptyState>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {orders.slice(0, 4).map(o => (
                <li key={o.id}>
                  <Link
                    href={`/portal/purchases/${o.id}`}
                    className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-raised"
                  >
                    <div>
                      <p className="font-medium">{o.productName}</p>
                      <p className="text-sm text-muted-foreground">{date(o.createdAt)}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-medium">{money(o.total)}</p>
                      {o.status !== 'paid' && <StatusBadge status={o.status} />}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <CardHeader
            title="Subscriptions"
            action={
              <Link href="/portal/subscriptions" className="text-sm font-medium hover:underline">
                Manage
              </Link>
            }
          />
          {active.length === 0 ? (
            <EmptyState
              title="No active subscriptions"
              action={
                plans.length > 0 && (
                  <Button asChild size="sm">
                    <Link href="/portal/subscriptions#plans">Browse plans</Link>
                  </Button>
                )
              }
            >
              {plans.length > 0 ? undefined : 'Subscribe from a business’s subscribe link.'}
            </EmptyState>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {active.map(s => (
                <li key={s.id}>
                  <Link
                    href={`/portal/subscriptions/${s.id}`}
                    className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-raised"
                  >
                    <div>
                      <p className="font-medium">{s.plan}</p>
                      <p className="text-sm text-muted-foreground">
                        {usdDecimal(s.amount)} / {period(s.periodSeconds)} · next {date(s.nextChargeAt)}
                      </p>
                    </div>
                    <StatusBadge status={s.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {!isNotWired(agents) && agents.some(a => a.status === 'active') && (
        <Card className="mt-6">
          <CardHeader
            title="Agents"
            description="Software that pays on your behalf, inside limits you set"
            action={<IconRobot className="size-5 text-muted-foreground" />}
          />
          <ul className="divide-y divide-border-subtle">
            {agents
              .filter(a => a.status === 'active')
              .map(a => (
                <li key={a.id}>
                  <Link
                    href={`/portal/agents/${a.id}`}
                    className="flex items-center justify-between gap-3 px-5 py-3 hover:bg-raised"
                  >
                    <div>
                      <p className="font-medium">{a.name}</p>
                      <p className="text-sm text-muted-foreground">
                        {usd(a.spentTodayMinor)} of {usd(a.dailyCapMinor)} today · {a.callsToday} calls
                      </p>
                    </div>
                    <IconArrowRight className="size-4 text-muted-foreground" />
                  </Link>
                </li>
              ))}
          </ul>
        </Card>
      )}
    </>
  );
}
