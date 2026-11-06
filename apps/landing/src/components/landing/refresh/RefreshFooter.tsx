import { ArrowUp, ArrowUpRight } from 'lucide-react';
import { APP_URL, DEMO_URL, DOCS_URL, GITHUB_URL } from '@/links';

export function RefreshFooter({ anchorBase = '' }: { anchorBase?: string } = {}) {
  return (
    <footer
      className={'closing closing-editorial dark-section'}
      id={'footer'}
      data-capture={'10-footer'}
    >
      <div className={'section-wrap'}>
        <div className={'footer-columns'}>
          <div className={'footer-brand'}>
            <a className={'brand'} href={`${anchorBase}#top`}>
              <img src={'/landing/pact-mark.svg'} alt={'Pact'} />
              <span className={'wordmark'}>{'PACT'}</span>
            </a>
            <p>
              {'Get paid in USDT.'} <br />
              {'Customers just pay.'}
            </p>
          </div>
          <div>
            <h3>{'Product'}</h3>
            <a href={`${anchorBase}#checkout`}>{'Checkout'}</a>
            <a href={`${anchorBase}#subscriptions`}>{'Subscriptions'}</a>
            <a href={`${anchorBase}#agents`}>{'Agent payments'}</a>
            <a href={`${anchorBase}#fees`}>{'Fees'}</a>
          </div>
          <div>
            <h3>{'Developers'}</h3>
            <a href={DOCS_URL} target={'_blank'} rel={'noopener'}>
              {'Documentation '}
              <ArrowUpRight className="ui-icon" size={20} strokeWidth={1.5} aria-hidden="true" />
            </a>
            <a href={GITHUB_URL} target={'_blank'} rel={'noopener'}>
              {'GitHub '}
              <ArrowUpRight className="ui-icon" size={20} strokeWidth={1.5} aria-hidden="true" />
            </a>
            <a href={`${anchorBase}#integrations`}>{'SDK & x402'}</a>
            <a href={`${anchorBase}#how`}>{'How it works'}</a>
          </div>
          <div>
            <h3>{'Get started'}</h3>
            <a href={APP_URL}>{'Merchant app'}</a>
            <a href={DEMO_URL}>{'Live demo'}</a>
            <a href={`${anchorBase}#faq`}>{'Questions'}</a>
          </div>
        </div>
        <div className={'footer-bottom'}>
          <span>{'© 2026 Pact. Built on Whitechain.'}</span>
          <a href={'#top'}>
            {'Back to top '}
            <ArrowUp className="ui-icon" size={20} strokeWidth={1.5} aria-hidden="true" />
          </a>
        </div>
        <div className={'footer-signature'} aria-hidden={'true'}>
          <img src={'/landing/pact-mark-outline.svg'} alt={''} />
        </div>
      </div>
    </footer>
  );
}
