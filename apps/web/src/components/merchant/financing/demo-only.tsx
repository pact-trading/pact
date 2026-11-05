import { IconArrowUpRight, IconBuildingBank } from '@tabler/icons-react';
import { Button } from '../../ui/button';
import { Card } from '../../ui/card';
import { EmptyState } from '../../ui/empty-state';

/** The mock demo, where financing runs end to end on sample data. */
export const DEMO_URL = 'https://demo.pactagent.app';

/**
 * Shown on the live site for financing screens: there are no receivables contracts on Whitechain
 * Sepolia yet, so the flow runs on sample data in the demo. `path` opens the same screen there.
 */
export function FinancingDemoOnly({ feature, path }: { feature: string; path: string }) {
  return (
    <Card>
      <EmptyState
        icon={<IconBuildingBank />}
        title={`${feature} runs in the demo for now`}
        action={
          <Button asChild size="sm" variant="dark">
            <a href={`${DEMO_URL}/demo?next=${encodeURIComponent(path)}`}>
              Try it in the demo
              <IconArrowUpRight className="size-4" />
            </a>
          </Button>
        }
      >
        Selling invoices to investors needs receivables contracts that are not deployed on Whitechain Sepolia
        yet. The demo runs the whole flow on sample data: listing, investors buying, the customer’s payment
        going to them, late payment, default and buy-back.
      </EmptyState>
    </Card>
  );
}
