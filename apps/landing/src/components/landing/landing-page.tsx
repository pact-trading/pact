import { RefreshHeader } from './refresh/RefreshHeader';
import { HeroSection } from './refresh/HeroSection';
import { CtaSection } from './refresh/CtaSection';
import { RefreshFooter } from './refresh/RefreshFooter';
import { LandingRuntime } from './refresh/landing-runtime';
import { PolarSections } from './pay/PaySections';
import './refresh/styles.css';

/** Hero, CTA and footer as approved; the middle is Polar's landing ported to Pact (pay/PaySections, polar/). */
export function LandingPage() {
  return (
    <LandingRuntime>
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <RefreshHeader />
      <main id="main-content" tabIndex={-1}>
        <HeroSection />
        <PolarSections />
        <CtaSection />
      </main>
      <RefreshFooter />
    </LandingRuntime>
  );
}
