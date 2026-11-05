'use client';

import { useEffect, useState } from 'react';
import { ArrowUpRight, Menu, X } from 'lucide-react';
import { ActionShader } from './action-shader';
import { APP_URL, DOCS_URL } from '@/links';
// Migrated from the approved landing-v16. Edit this native section here.
export function RefreshHeader({
  anchorBase = '',
  showCta = true,
}: { anchorBase?: string; showCta?: boolean } = {}) {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const updateScrolled = () => setScrolled(window.scrollY > 0);
    updateScrolled();
    window.addEventListener('scroll', updateScrolled, { passive: true });
    window.addEventListener('pageshow', updateScrolled);
    return () => {
      window.removeEventListener('scroll', updateScrolled);
      window.removeEventListener('pageshow', updateScrolled);
    };
  }, []);

  return (
    <header data-scrolled={scrolled}>
      <a className={'brand'} href={`${anchorBase}#top`} aria-label={'Pact'}>
        <img src={'/landing/pact-mark.svg'} alt={''} />
        <span className={'wordmark'}>{'PACT'}</span>
      </a>
      <nav id={'product-nav'} className={'nav'} aria-label={'Products'}>
        <a href={`${anchorBase}#checkout`}>{'Checkout'}</a>
        <a href={`${anchorBase}#subscriptions`}>{'Subscriptions'}</a>
        <a href={`${anchorBase}#agents`}>{'Agents'}</a>
        <a href={`${anchorBase}#gas`}>{'Gas tank'}</a>
        <a href={DOCS_URL} target={'_blank'} rel={'noopener'}>
          {'Docs'}
        </a>
      </nav>
      {showCta ? (
        <a className={'button'} href={APP_URL}>
          <ActionShader />
          {'Start selling '}
          <span aria-hidden={'true'}>
            <ArrowUpRight className="ui-icon" size={20} strokeWidth={1.5} aria-hidden="true" />
          </span>
        </a>
      ) : null}
      <button
        className={'nav-toggle'}
        type={'button'}
        aria-label={'Toggle product navigation'}
        aria-expanded={'false'}
        aria-controls={'product-nav'}
      >
        <Menu className="ui-icon nav-toggle-open" size={20} strokeWidth={1.5} aria-hidden="true" />
        <X className="ui-icon nav-toggle-close" size={20} strokeWidth={1.5} aria-hidden="true" />
      </button>
    </header>
  );
}
