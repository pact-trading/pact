import { ArrowUpRight } from 'lucide-react';
import { ActionShader, CtaWaves } from './action-shader';
import { APP_URL, DOCS_URL } from '@/links';
// Migrated from the approved landing-v16. Edit this native section here.
export function CtaSection() {
  return (
    <section
      className={'cta-banner'}
      id={'early-access'}
      data-capture={'09-cta'}
      aria-labelledby={'cta-title'}
    >
      <img className={'cta-backdrop'} src={'/landing/soft-blue/cta-banner-bg.webp'} alt={''} />
      <CtaWaves />
      <div className={'section-wrap'}>
        <div className={'cta-content'}>
          <img className={'cta-mark'} src={'/landing/pact-mark.svg'} alt={'Pact'} />
          <div className={'eyebrow'}>{'START TODAY'}</div>
          <h2 id={'cta-title'}>
            {'Get paid in USDT.'} <br />
            {'Today.'}
          </h2>
          <p>
            {'Free on Whitechain testnet.'} <br />
            {'Set up in a few minutes.'}
          </p>
          <div className={'closing-actions'}>
            <a className={'button light-button'} href={APP_URL}>
              <ActionShader />
              {'Start selling '}
              <span>
                <ArrowUpRight className="ui-icon" size={20} strokeWidth={1.5} aria-hidden="true" />
              </span>
            </a>
            <a
              className={'footer-docs'}
              href={DOCS_URL}
              target={'_blank'}
              rel={'noopener'}
            >
              {'Read the docs '}
              <ArrowUpRight className="ui-icon" size={20} strokeWidth={1.5} aria-hidden="true" />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
