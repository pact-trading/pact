import type { Metadata } from 'next';
import { SettingsForm } from '@/components/merchant/settings-form';
import { NotificationPreferencesCard } from '@/components/notifications/notification-preferences';
import { NotConnected } from '@/components/states/not-connected';
import { Card, CardBody, CardHeader, DetailList } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import Link from 'next/link';
import { usd, usdDecimal } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Settings' };

export default async function SettingsPage() {
  const data = await getData();
  const [settings, preferences, quote, fees, viewer, notifications] = await Promise.all([
    load(() => data.merchant.settings()),
    load(() => data.merchant.preferences()),
    load(() => data.merchant.feePreview()),
    load(() => data.merchant.fees()),
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
  ]);
  return (
    <>
      <PageHeader title="Settings" description="Your brand, refund policy and payout account." />
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
          <CardHeader
            title="Pricing"
            description={
              <>
                The fee terms you signed. Pact takes them out of each payment.{' '}
                <Link href="/dashboard/fees" className="font-medium underline-offset-4 hover:underline">
                  Open fees
                </Link>
              </>
            }
          />
          <CardBody>
            <DetailList
              items={[
                {
                  label: 'Checkout payments and renewals',
                  value: (fees.terms.accepted ?? fees.terms.latest).checkout.percent,
                  hint: `At least ${usdDecimal((fees.terms.accepted ?? fees.terms.latest).checkout.minimumUsdt)}, taken out of the payment`,
                },
                {
                  label: 'Invoices',
                  value: (fees.terms.accepted ?? fees.terms.latest).invoice.percent,
                  hint: (fees.terms.accepted ?? fees.terms.latest).invoice.capUsdt
                    ? `At most ${usdDecimal((fees.terms.accepted ?? fees.terms.latest).invoice.capUsdt!)}`
                    : 'No cap',
                },
                { label: 'Per agent call', value: '$0.0005', hint: 'On x402 settlements through Pact' },
                ...(isNotWired(quote)
                  ? []
                  : [
                      {
                        label: 'Smallest payment',
                        value: usd(quote.minimumAmountMinor),
                        hint: 'The Router refuses anything smaller',
                      },
                      {
                        label: 'Refund network fee',
                        value: `At most ${usd(quote.maximumGasFeeMinor)}`,
                        hint: 'Taken from your wallet in USDT when you send a refund. Customers pay none.',
                      },
                    ]),
              ]}
            />
          </CardBody>
        </Card>
      )}
    </>
  );
}
