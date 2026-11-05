import type { Metadata } from 'next';
import { IconFingerprint, IconKeyOff } from '@tabler/icons-react';
import { AddFunds } from '@/components/customer/add-funds';
import { NotificationPreferencesCard } from '@/components/notifications/notification-preferences';
import { NotConnected } from '@/components/states/not-connected';
import { Card, CardBody, CardHeader, DetailList } from '@/components/ui/card';
import { CopyButton } from '@/components/ui/copy-button';
import { Disclosure } from '@/components/ui/disclosure';
import { PageHeader } from '@/components/ui/page-header';
import { usd } from '@/lib/format';
import { getData } from '@/server/data';
import { isNotWired, load } from '@/server/load';

export const metadata: Metadata = { title: 'Account' };

export default async function AccountPage() {
  const account = await load(async () => (await getData()).customer.account());
  const notifications = await load(async () => (await getData()).customer.notificationPreferences());
  if (isNotWired(account)) return <NotConnected feature={account.feature} />;
  return (
    <>
      <PageHeader title="Account" description="How you sign in and what you can spend." />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Profile" />
          <CardBody>
            <DetailList
              items={[
                { label: 'Name', value: account.name },
                { label: 'Email', value: account.email },
                { label: 'Company', value: account.company ?? '—' },
                {
                  label: 'Sign-in',
                  value: (
                    <span className="inline-flex items-center gap-1.5">
                      <IconFingerprint className="size-4" />
                      {account.passkeys} passkey{account.passkeys === 1 ? '' : 's'} and email
                    </span>
                  ),
                },
              ]}
            />
            <p className="mt-4 flex items-start gap-2 text-[13px] text-muted-foreground">
              <IconKeyOff className="mt-0.5 size-4 shrink-0" />
              There is no seed phrase to write down. Your account is recovered with your email or passkey.
            </p>
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Balance" />
          <CardBody className="grid gap-4">
            <p className="text-4xl font-semibold tracking-tight">{usd(account.balanceMinor)}</p>
            {account.testFunds.nextClaimAt ? (
              <p className="text-sm text-muted-foreground">Test funds can be claimed again tomorrow.</p>
            ) : (
              <AddFunds balanceMinor={account.balanceMinor} />
            )}
          </CardBody>
        </Card>
      </div>
      <Disclosure summary="Advanced details" className="mt-6">
        <div className="grid gap-2 text-[13px]">
          <p className="text-muted-foreground">
            For developers and the curious. You never need these to pay.
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-muted-foreground">Smart account on Whitechain Sepolia</span>
            <span className="flex items-center gap-1 font-mono">
              {account.address}
              <CopyButton value={account.address} label="Copy address" />
            </span>
          </div>
          <p className="text-muted-foreground">
            Created silently on your first payment and deployed by the relayer at no cost to you. Balances are
            held in USDT.
          </p>
        </div>
      </Disclosure>
      {!isNotWired(notifications) && <NotificationPreferencesCard key={JSON.stringify(notifications)} kind="customer" className="mt-6" initial={notifications} />}
    </>
  );
}
