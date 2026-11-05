import type { Metadata } from 'next';
import Link from 'next/link';
import { IconRobot } from '@tabler/icons-react';
import { CreateAgent } from '@/components/customer/agents/create-agent';
import { NotConnected } from '@/components/states/not-connected';
import { StatusBadge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/ui/page-header';
import { date, usd } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';

export const metadata: Metadata = { title: 'Agents' };

export default async function AgentsPage() {
  const agents = await load(async () => (await getData()).customer.agents());
  if (isNotWired(agents)) return <NotConnected feature={agents.feature} />;
  return (
    <>
      <PageHeader
        title="Agents"
        description="AI agents that pay for APIs on your behalf. Each has its own spending limits, enforced in its account, and you can revoke it anytime."
      />
      <div className="mb-6">
        <CreateAgent />
      </div>
      <Card>
        {agents.length === 0 ? (
          <EmptyState icon={<IconRobot />} title="No agents yet" />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {agents.map(a => (
              <li key={a.id}>
                <Link
                  href={`/portal/agents/${a.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hover:bg-raised"
                >
                  <div className="flex items-center gap-3">
                    <span className="grid size-10 place-items-center rounded-xl bg-chip">
                      <IconRobot className="size-5" />
                    </span>
                    <div>
                      <p className="font-medium">{a.name}</p>
                      <p className="text-sm text-muted-foreground">{a.description}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    {a.status === 'active' && (
                      <span className="text-muted-foreground">
                        {usd(a.spentTodayMinor)} of {usd(a.dailyCapMinor)} today · expires {date(a.expiresAt)}
                      </span>
                    )}
                    <StatusBadge status={a.status} />
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
