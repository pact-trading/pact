import { IconPlugConnectedX } from '@tabler/icons-react';
import { Card } from '../ui/card';
import { EmptyState } from '../ui/empty-state';

/** Shown in API mode for screens whose endpoints are still on the wiring backlog. */
export function NotConnected({ feature }: { feature: string }) {
  return (
    <Card>
      <EmptyState icon={<IconPlugConnectedX />} title="Not connected yet">
        {feature} has a finished screen but no API endpoint yet. Run the preview with mock data to see it.
      </EmptyState>
    </Card>
  );
}
