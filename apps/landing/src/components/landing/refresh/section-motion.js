import { golIcon } from './icons';
export function initSections(root, heroPreview, visibility) {
  const events = new AbortController();
  const signal = events.signal;
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const reducedMotion = preference.matches;
  let motionEnabled = !reducedMotion;
  const visuals = [...root.querySelectorAll('[data-motion]')];
  const observer = new IntersectionObserver(
    (entries) =>
      entries.forEach((e) => {
        e.target.classList.toggle('is-visible', e.isIntersecting);
        e.target.querySelectorAll('svg.problem-animation').forEach((svg) => {
          e.isIntersecting && motionEnabled ? svg.unpauseAnimations() : svg.pauseAnimations();
        });
      }),
    { threshold: 0.15 },
  );
  visuals.forEach((v) => observer.observe(v));
  const heroObserver = new IntersectionObserver(
    (entries) => {
      visibility.current = entries[0].isIntersecting;
    },
    { threshold: 0.05 },
  );
  heroObserver.observe(root.querySelector('.hero .visual'));
  function setMotion(enabled) {
    enabled = enabled && !preference.matches;
    motionEnabled = enabled;
    root.querySelectorAll('svg.problem-animation').forEach((svg) => {
      enabled && svg.closest('.is-visible') ? svg.unpauseAnimations() : svg.pauseAnimations();
    });
    root.classList.toggle('page-motion-off', !enabled);
    enabled ? heroPreview.play() : heroPreview.pause();
    root.dispatchEvent(new CustomEvent('gol:motion', { detail: { enabled } }));
  }
  setMotion(motionEnabled);
  let ticks = 0;
  const updateProducts = () => {
    if (!motionEnabled || document.hidden) return;
    ticks++;
    visuals.forEach((v) => {
      if (!v.classList.contains('is-visible')) return;
      if (v.dataset.motion === 'wallet' && v.querySelector('.action-state')) {
        const p = ticks % 9;
        const labels = [
          'Pending',
          'Pending',
          'Signed in',
          'Signed in',
          'Settling',
          'Settling',
          'Paid',
          'Paid',
          'Paid',
        ];
        v.querySelector('.action-state').textContent = labels[p];
        v.querySelector('.transfer-progress>span').style.width =
          [15, 15, 40, 40, 70, 70, 100, 100, 100][p] + '%';
        v.querySelector('.action-caption').textContent =
          p < 6 ? 'Email sign-in. No wallet.' : 'No wallet. No gas. One block.';
      }
      if (v.dataset.motion === 'terminal' && v.querySelector('.strategy-caption')) {
        v.querySelector('.strategy-caption').textContent = [
          'Checked by the contract',
          'Checked by the contract',
          'Checked by the contract',
          '12 USDT renewal within the cap',
          'Renewal paid. 3 USDT left.',
        ][ticks % 5];
      }
      if (v.dataset.motion === 'infra') {
        const stage = ticks % 12;
        const phase =
          stage < 2 ? 'request' : stage < 4 ? 'checking' : stage < 8 ? 'approved' : 'refused';
        v.dataset.phase = phase;
        v.querySelector('.infra-live-decision').textContent = {
          request: 'Customer pays 49 USDT',
          checking: 'Router checks the limits',
          approved: '49 USDT paid',
          refused: 'Replay refused',
        }[phase];
        v.querySelector('.infra-live-record').textContent =
          phase === 'refused'
            ? 'Refusal public. Nothing moved.'
            : phase === 'approved'
              ? 'Settled in one block.'
              : 'A record on the explorer';
      }
    });
  };
  const productTimer = setInterval(updateProducts, 1000);
  const journey = [
    {
      product: 'PAYMENT LINKS',
      title: 'Create a link.',
      copy: 'Set a price in USDT and share the link. Or drop checkout into your site.',
      label: 'Payment link',
      value: '49 USDT',
      detail: 'pay.pactagent.app/pro',
      width: 20,
    },
    {
      product: 'CHECKOUT',
      title: 'The customer pays.',
      copy: 'Email or passkey. No wallet to install and no gas to buy.',
      label: 'Checkout',
      value: 'Paid',
      detail: 'Email sign-in, settled in one block',
      width: 40,
    },
    {
      product: 'REFUNDS',
      title: 'Refund in one click.',
      copy: 'Full or partial. Every refund is public on the explorer.',
      label: 'Refund',
      value: '20 USDT',
      detail: 'Partial refund, onchain',
      width: 60,
    },
    {
      product: 'FEES',
      title: 'One fee, from the payment.',
      copy: '0.8% of a checkout payment, at least 0.15 USDT. Pact pays the gas, and spam, replays and dust are refused.',
      label: 'Fee on 100 USDT',
      value: '0.80 USDT',
      detail: 'You receive 99.20 USDT',
      width: 80,
    },
    {
      product: 'CUSTOMER PORTAL',
      title: 'Customers see it all.',
      copy: 'Receipts, subscriptions and caps in one place. Cancel any time.',
      label: 'Customer portal',
      value: 'Self-serve',
      detail: 'Receipts, plans, cancel',
      width: 100,
    },
  ];
  let step = 0;
  const tabs = [...root.querySelectorAll('[data-journey]')];
  function showJourney(index) {
    step = index;
    const d = journey[step];
    // The step's card is a React component built from the app's UI (JourneySection).
    root.dispatchEvent(new CustomEvent('pact:journey', { detail: { step } }));
    const ui = root.querySelector('.pact-journey-card');
    if (ui && motionEnabled)
      ui.animate([{ opacity: 0.25 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
    root.querySelector('.journey-product').textContent = d.product;
    root.querySelector('#journey-title').textContent = d.title;
    root.querySelector('#journey-copy').textContent = d.copy;
    root.querySelector('#journey-mini-label').textContent = d.label;
    root.querySelector('#journey-mini-value').textContent = d.value;
    root.querySelector('#journey-mini-detail').textContent = d.detail;
    root.querySelector('.journey-meter>span').style.width = d.width + '%';
    tabs.forEach((t, i) => {
      t.setAttribute('aria-selected', String(i === step));
      t.tabIndex = i === step ? 0 : -1;
    });
    // Only the label changes, so the live shader canvas inside the button survives.
    root.querySelector('.journey-next-label').innerHTML =
      step === 4 ? 'Start again ' + golIcon('RotateCcw') : 'Next step ' + golIcon('ArrowRight');
  }
  tabs.forEach((tab, i) => {
    tab.onclick = () => showJourney(i);
    tab.onkeydown = (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const n = (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        showJourney(n);
        tabs[n].focus();
      }
    };
  });
  const journeyNext = root.querySelector('.journey-next');
  if (journeyNext) {
    journeyNext.onclick = () => showJourney((step + 1) % journey.length);
    showJourney(0);
  }
  const menu = root.querySelector('.nav-toggle');
  const closeMenu = () => {
    menu.setAttribute('aria-expanded', 'false');
    root.querySelector('header .nav').classList.remove('open');
  };
  root.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
        closeMenu();
        menu.focus();
      }
    },
    { signal },
  );
  menu.onclick = () => {
    const expanded = menu.getAttribute('aria-expanded') !== 'true';
    menu.setAttribute('aria-expanded', String(expanded));
    root.querySelector('header .nav').classList.toggle('open', expanded);
  };
  root.querySelectorAll('header .nav a').forEach((a) =>
    a.addEventListener(
      'click',
      () => {
        menu.setAttribute('aria-expanded', 'false');
        root.querySelector('header .nav').classList.remove('open');
      },
      { signal },
    ),
  );
  root.querySelectorAll('[data-control]').forEach((detail) =>
    detail.addEventListener(
      'toggle',
      () => {
        if (!detail.open) return;
        root.querySelectorAll('[data-control]').forEach((other) => {
          if (other !== detail) other.open = false;
        });
        root.querySelector('.sculpture-value').innerHTML = [
          'Signed caps.<br>Checked onchain.',
          'Daily caps.<br>No drain.',
          'Every refusal.<br>A public reason.',
        ][Number(detail.dataset.control)];
      },
      { signal },
    ),
  );

  preference.addEventListener('change', () => setMotion(!preference.matches), { signal });
  return {
    setMotion,
    showJourney,
    destroy() {
      events.abort();
      clearInterval(productTimer);
      observer.disconnect();
      heroObserver.disconnect();
      root.querySelectorAll('[data-journey],.journey-next,.nav-toggle').forEach((n) => {
        n.onclick = null;
        n.onkeydown = null;
      });
      root.classList.remove('page-motion-off');
    },
  };
}
