import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { ShaderBackground } from '@/components/ui/verdant-swirl';
import { ActionShader } from './action-shader';
import { APP_URL, DEMO_URL } from '@/links';
import { OverviewWindow, SignedCapCard } from '@/components/app-cards';
// Migrated from the approved landing-v16. Edit this native section here.
export function HeroSection() {
  return (
    <section className={'hero'} id={'top'}>
      <div className={'intro'}>
        <h1>
          <span className={'phrase'}>{'Get paid in USDT.'}</span> <br />
          <span>{'Customers just pay.'}</span>
        </h1>
        <p>
          {'Checkout, subscriptions and refunds on Whitechain.'} <br />
          {'No wallet and no gas for your customers.'}
        </p>
        <div className={'actions'}>
          <a className={'button'} href={APP_URL}>
            <ActionShader />
            {'Start selling '}
            <span aria-hidden={'true'}>
              <ArrowUpRight className="ui-icon" size={20} strokeWidth={1.5} aria-hidden="true" />
            </span>
          </a>
          <a className={'button secondary'} href={DEMO_URL}>
            <ActionShader tone="gray" />
            {'Try the demo '}
            <span aria-hidden={'true'}>
              <ArrowRight className="ui-icon" size={20} strokeWidth={1.5} aria-hidden="true" />
            </span>
          </a>
        </div>
      </div>
      <div
        className={'visual'}
        aria-label={'Pact merchant overview and a subscription with a signed cap'}
      >
        <img className={'texture'} src={'/landing/hero-generated-soft-blue.webp'} alt={''} />
        <ShaderBackground
          className={'texture'}
          colors={[
            [0.027, 0.035, 0.016],
            [0.086, 0.122, 0.024],
            [0.243, 0.345, 0.039],
            [0.776, 1, 0.204],
          ]}
        />
        <div className={'mock-stage'}>
          <div className={'desktop app-desktop'}>
            <OverviewWindow />
          </div>
          <aside className={'rules app-rules'} aria-label={'Subscription with a signed cap'}>
            <SignedCapCard />
          </aside>
        </div>
      </div>
    </section>
  );
}
