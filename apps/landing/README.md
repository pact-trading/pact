# Pact landing page

The marketing site for Pact Pay: USDT payments for businesses on Whitechain. It reuses the
original Pact landing (Vite, React Three Fiber, the GPU ASCII hero, receipt-style features,
pixel CTA and lime slab footer). Only the copy has changed, to describe Pact Pay.

## Run it

```bash
pnpm install
pnpm --filter @pact/landing dev     # http://localhost:5173
pnpm --filter @pact/landing build   # static output in apps/landing/dist
```

The host needs SPA fallback, which `vercel.json` already sets.

## Where things live

| What | File |
| --- | --- |
| Outbound links (app, demo, docs, GitHub) | `src/links.js` |
| Chain shown in the hero and footer | `src/chain.js` |
| Palette, fonts, breakpoints | `src/brand.js` |
| Hero stages: Pay, Check, Settle, Refund | `src/components/hero/HeroCopy.jsx` |
| The six payment records | `src/components/features/FeaturesSection.jsx` |
| FAQ | `src/components/faq/FaqSection.jsx` |
| CTA and footer copy | `src/components/cta/CtaSection.jsx`, `src/components/footer/SiteFooter.jsx` |

Keep the copy short, and in step with `docs-site/` (what is live and what is mock).
The Whitechain icon in `public/chain/` is a simplified redraw, not the official asset.
