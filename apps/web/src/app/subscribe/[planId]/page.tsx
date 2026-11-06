import type { Metadata } from 'next';
import Link from 'next/link';
import { CheckoutLayout, OrderSummary } from '@/components/customer/checkout-layout';
import { CheckoutNotWired } from '@/components/customer/checkout/not-wired';
import { CheckoutPanel } from '@/components/customer/checkout/panel';
import { SignInCard } from '@/components/customer/sign-in-card';
import { SubscribeCheckout } from '@/components/customer/signed-buttons';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/notice';
import { period, toMinor, usdDecimal } from '@/lib/format';
import { getData } from '@/server/data';
import { MOCK_VIEWERS } from '@/server/data/mock/viewers';
import { isNotWired, load } from '@/server/load';
import { isMock } from '@/server/mode';
import { getViewer } from '@/server/viewer';

export const metadata: Metadata = { title: 'Subscribe' };
export const dynamic = 'force-dynamic';

export default async function SubscribePage({ params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  const data = await getData();
  const [offer, viewer] = await Promise.all([load(() => data.checkout.planOffer(planId)), getViewer()]);
  if (isNotWired(offer)) return <CheckoutNotWired feature={offer.feature} />;
  const account = viewer?.role === 'customer' ? await load(() => data.customer.account()) : null;
  const { plan, brand } = offer;
  const every = period(plan.periodSeconds);
  const price = usdDecimal(plan.amount);
  const limit = plan.maxPeriods ? `for at most ${plan.maxPeriods} payment${plan.maxPeriods === 1 ? '' : 's'}` : 'until you cancel';
  const back = { href: '/', history: true };
  return (
    <CheckoutLayout
      brand={brand}
      back={back}
      summary={
        <OrderSummary
          eyebrow="Subscription"
          title={plan.name}
          amount={plan.trialDays ? `Free for ${plan.trialDays} days` : `${price} / ${every}`}
          totalNote={`Then up to ${price} each ${every}, ${limit}.`}
          items={[{ id: plan.id, title: plan.name, detail: plan.description, amount: price, icon: 'plan' }]}
          subtotal={price}
          rows={[
            { label: 'Billed', value: `Every ${every}` },
            { label: 'Cancel', value: 'Anytime, in one click' },
          ]}
          dueToday={plan.trialDays ? usdDecimal('0') : price}
        />
      }
    >
      {offer.subscriptionId ? (
        <CheckoutPanel
          step="success"
          receipt={
            <Notice tone="success" title="You’re subscribed">
              Cancel anytime from your account. {brand.brandName} cannot charge more than you approved.
            </Notice>
          }
          actions={
            <Button asChild variant="dark">
              <Link href={`/portal/subscriptions/${offer.subscriptionId}`}>Manage subscription</Link>
            </Button>
          }
        />
      ) : offer.available === false ? (
        <Notice tone="warning" title="This plan is no longer offered">
          {brand.brandName} stopped taking new subscriptions to {plan.name}. Nothing was charged.
        </Notice>
      ) : viewer?.role === 'customer' && account && !isNotWired(account) ? (
        <SubscribeCheckout
          planId={plan.id}
          trialDays={plan.trialDays}
          email={viewer.email}
          label={plan.trialDays ? `Start ${plan.trialDays}-day free trial` : `Subscribe · ${price} / ${every}`}
          brandName={brand.brandName}
          balanceMinor={account.balanceMinor}
          amountMinor={plan.trialDays ? '0' : toMinor(plan.amount).toString()}
          payNote={`then up to ${price} each ${every}`}
          back={back}
          consent={
            <Notice tone="shield" title={`You approve up to ${price} each ${every}`}>
              One signature sets the cap, {limit}. {brand.brandName} cannot charge more, charge early, or
              charge after you cancel; the contract refuses it and shows you the attempt.
            </Notice>
          }
        />
      ) : (
        <SignInCard
          next={`/subscribe/${planId}`}
          title="Subscribe with email or a passkey"
          payToday={plan.trialDays ? usdDecimal('0') : price}
          back={back}
          mockEmail={isMock ? MOCK_VIEWERS.find(v => v.role === 'customer')?.email : undefined}
        />
      )}
    </CheckoutLayout>
  );
}
