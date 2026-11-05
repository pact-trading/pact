import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { IconArrowUpRight } from '@tabler/icons-react';
import { PactLogo } from '@/components/brand/pact-logo';
import { screenAreas, screenHref } from '@/components/lab/screens';
import { ThemeToggle } from '@/components/shell/theme-toggle';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { getData } from '@/server/data';
import { DEMO } from '@/server/data/mock/fixtures';

export const metadata: Metadata = { title: 'Screens' };
export const dynamic = 'force-dynamic';

const roleLabel = {
  merchant: 'Merchant',
  accountant: 'Accountant',
  customer: 'Customer',
  investor: 'Investor',
  compliance: 'Compliance',
} as const;

/** Every screen with a working example link that opens it as the right viewer. Mock mode only. */
export default async function ScreensPage() {
  const { lab } = await getData();
  if (!lab) redirect('/login');
  const examples = await lab.examples();
  const areas = screenAreas({ ...DEMO, ...examples });
  const total = areas.reduce((sum, area) => sum + area.screens.length, 0);
  return (
    <div className="min-h-[calc(100dvh-2.5rem)]">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 pt-6">
        <PactLogo width={96} />
        <ThemeToggle />
      </header>
      <main className="mx-auto max-w-6xl px-5 pt-10 pb-16">
        <p className="text-sm font-medium text-muted-foreground">Review</p>
        <h1 className="mt-1 text-[30px] leading-tight font-semibold sm:text-4xl">Screens</h1>
        <p className="mt-2 max-w-2xl text-[15px] text-muted-foreground">
          All {total} screens, each with an example from the seeded story. A link switches the demo to the
          viewer the screen is for. Use the scenario menu in the demo bar to see empty, loading and error
          states.
        </p>
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          {areas.map(area => (
            <Card key={area.area}>
              <CardHeader title={area.area} description={area.description} />
              <ul className="divide-y divide-border-subtle" aria-label={area.area}>
                {area.screens.map(screen => (
                  <li key={`${screen.role}:${screen.path}`}>
                    <a
                      href={screenHref(screen)}
                      data-screen-link
                      className="flex items-center gap-3 px-5 py-3 hover:bg-raised"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{screen.title}</span>
                        <span className="block truncate font-mono text-[12px] text-muted-foreground">
                          {screen.path}
                        </span>
                        {screen.note && (
                          <span className="block text-[13px] text-muted-foreground">{screen.note}</span>
                        )}
                      </span>
                      <Badge tone={screen.role ? 'neutral' : 'outline'}>
                        {screen.role ? roleLabel[screen.role] : 'Anyone'}
                      </Badge>
                      <IconArrowUpRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    </a>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      </main>
    </div>
  );
}
