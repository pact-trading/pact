export function initReveals(root) {
  const events = new AbortController();
  const signal = events.signal;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const sectionNodes = [
    root.querySelector('header'),
    ...root.querySelectorAll('main>section'),
    root.querySelector('footer'),
  ].filter(Boolean);
  let enabled = !reduce.matches && !root.classList.contains('page-motion-off');
  const active = new Set(),
    seen = new WeakSet();
  function animate(node, frames, options) {
    if (!enabled || document.hidden) return;
    const a = node.animate(frames, {
      duration: 650,
      easing: 'cubic-bezier(.22,1,.36,1)',
      ...options,
    });
    active.add(a);
    a.finished.catch(() => {}).finally(() => active.delete(a));
    return a;
  }
  const revealSelector =
    '.intro>*,.hero .visual,.section-title,.editorial-heading,.integration-heading,.integration-path,.product-copy,.product-visual,.problem-grid article,.infra-tile,.infra-wide,.journey-screen,.journey-narrative,.control-sculpture,.control-narrative,.opportunity-grid article,.client-logo,.faq-editorial>div,.cta-content>*,.footer-columns>div';
  const reveals = [...root.querySelectorAll(revealSelector)];
  const revealObserver = new IntersectionObserver(
    (entries) => {
      const incoming = entries.filter((e) => e.isIntersecting && !seen.has(e.target));
      incoming.forEach((entry, i) => {
        seen.add(entry.target);
        revealObserver.unobserve(entry.target);
        if (enabled)
          animate(
            entry.target,
            [
              { opacity: 0.25, translate: '0 18px' },
              { opacity: 1, translate: '0 0' },
            ],
            {
              delay: Math.min(i * 55, 220),
              duration: entry.target.matches('.product-visual,.hero .visual') ? 850 : 650,
            },
          );
      });
    },
    { threshold: 0.08, rootMargin: '0px 0px -24px 0px' },
  );
  reveals.forEach((e) => revealObserver.observe(e));
  const visibleObserver = new IntersectionObserver(
    (entries) =>
      entries.forEach((e) => e.target.classList.toggle('motion-visible', e.isIntersecting)),
    { threshold: 0.02 },
  );
  sectionNodes.forEach((e) => visibleObserver.observe(e));
  root.querySelectorAll('details').forEach((details) =>
    details.addEventListener(
      'toggle',
      () => {
        if (details.open && enabled) {
          const children = [...details.children].filter((e) => e.tagName !== 'SUMMARY');
          children.forEach((child, i) =>
            animate(
              child,
              [
                { opacity: 0.3, translate: '0 7px' },
                { opacity: 1, translate: '0 0' },
              ],
              { duration: 350, delay: i * 35 },
            ),
          );
        }
      },
      { signal },
    ),
  );
  root.querySelectorAll('[data-journey]').forEach((button) =>
    button.addEventListener(
      'click',
      () => {
        const text = root.querySelector('.journey-text');
        animate(
          text,
          [
            { opacity: 0.5, translate: '0 6px' },
            { opacity: 1, translate: '0 0' },
          ],
          { duration: 350 },
        );
      },
      { signal },
    ),
  );
  function setEnabled(value) {
    enabled = value && !reduce.matches;
    if (!enabled) {
      active.forEach((a) => a.finish());
      active.clear();
    }
  }
  root.addEventListener('gol:motion', (e) => setEnabled(e.detail.enabled), { signal });
  reduce.addEventListener(
    'change',
    () => setEnabled(!reduce.matches && !root.classList.contains('page-motion-off')),
    { signal },
  );
  document.addEventListener(
    'visibilitychange',
    () => {
      root.classList.toggle('page-backgrounded', document.hidden);
      active.forEach((a) => (document.hidden ? a.pause() : a.play()));
    },
    { signal },
  );
  // Render/inspection tools can finish entrance animations without disabling normal product motion.
  return () => {
    events.abort();
    active.forEach((a) => a.cancel());
    active.clear();
    revealObserver.disconnect();
    visibleObserver.disconnect();
    root.classList.remove('page-backgrounded');
  };
}
