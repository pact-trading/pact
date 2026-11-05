import type { Metadata } from 'next';
import { SettingsForm } from '@/components/merchant/settings-form';
import { NotificationPreferencesCard } from '@/components/notifications/notification-preferences';
import { NotConnected } from '@/components/states/not-connected';
import { Card, CardBody, CardHeader, DetailList } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { usd, wbt } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const data = await getData();
  const [settings, preferences, fees, viewer, notifications] = await Promise.all([
    load(() => data.merchant.settings()),
    load(() => data.merchant.preferences()),
    load(() => data.merchant.feePreview()),
    getViewer(),
    load(() => data.merchant.notificationPreferences()),
  ]);
  if (isNotWired(settings)) return <NotConnected feature={settings.feature} />;
  const prefs = isNotWired(preferences) ? null : preferences;
  // Remounting on the saved values means the form always starts from what is stored.
  const saved = JSON.stringify([
    settings.brandName,
    settings.logoUrl,
    settings.refundWindowSeconds,
    prefs?.brandColor,
    prefs?.feeMode,
  ]);
  return (
    <>
      <PageHeader title="Settings" description="Your brand, refund policy, fees and payout account." />
      <SettingsForm
        key={saved}
        settings={settings}
        preferences={prefs}
        readOnly={viewer?.role !== 'merchant'}
      />
      {!isNotWired(notifications) && (
        <NotificationPreferencesCard
          key={JSON.stringify(notifications)}
          kind="merchant"
          className="mt-6"
          initial={notifications}
          readOnly={viewer?.role !== 'merchant'}
        />
      )}
      {!isNotWired(fees) && (
        <Card className="mt-6">
          <CardHeader title="Pricing" description="Testnet pricing, illustrative only" />
          <CardBody>
            <DetailList
              items={[
                {
                  label: 'Per payment',
                  value: '1%',
                  hint: `Minimum ${usd(fees.minimumFeeMinor)}, taken in the same transaction`,
                },
                { label: 'Per agent call', value: '$0.0005', hint: 'On x402 settlements through Pact' },
                {
                  label: 'Smallest sponsored payment',
                  value: usd(fees.minimumAmountMinor),
                  hint: 'Below this the fee would not cover gas',
                },
                {
                  label: 'Gas reimbursement cap',
                  value: wbt(fees.maximumReimbursementWei, 5),
                  hint: 'Per sponsored call, paid from your tank',
                },
              ]}
            />
          </CardBody>
        </Card>
      )}
    </>
  );
}
